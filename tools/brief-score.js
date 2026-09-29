// 选题算法：从一个窗口内的已结束比赛中，算出哪一条最值得做成当日头版
// 设计原则：不依赖任何外部新闻源，只用 data/matches.js 已有的结构化字段
// 本文件只在构建期使用，不进小程序包

const T = require('./teams-tier.js');

// 赛事基础权重：0-100，代表这个赛事本身的分量
const COMP_WEIGHT = {
  worlds: 100,  // 全球总决赛
  msi: 92,      // 季中冠军赛
  // 俱乐部足球整体上调 +8（用户裁定：五大联赛德比应优先于 LEC 决赛）。
  // 调整前后对照见文件末尾的注释，改动一处必须重跑 tools/brief-pick.js 验证。
  ucl: 96,      // 欧冠
  epl: 82,      // 英超
  liga: 80,     // 西甲
  seriea: 78,   // 意甲
  bundesliga: 78,
  ligue1: 74,   // 法甲
  uel: 66,      // 欧联
  nba: 74,      // NBA：与五大联赛同档，中文语境下关注度相当
  lpl: 64,
  lck: 64,
  lec: 52,      // LEC：国内关注度明显低于 LPL/LCK，刻意压低
  chn: 54,      // 中国之队
  // 欧国联：国家队比赛日通常独占一天，但英西、德荷这种对决在真实体育报纸上就是头版。
  // 定 58 是为了让「豪门对决 +26」后能压过同期 LCK/LPL 常规赛（64+16=80），
  // 又不会高到盖过五大联赛豪门对决（74+26=100）。
  nations: 58,
};

// stage 字段形如「全球总决赛 · 瑞士轮」或「英超」：前半是赛事名，后半才是阶段
// ⚠️ 必须先剥离赛事名 —— 否则「全球总决赛 · 瑞士轮」会被误判成「决赛」（踩过这个坑）
function parseStage(stage) {
  const s = String(stage || '');
  const parts = s.split('·').map((x) => x.trim());
  return parts.length > 1 ? parts[parts.length - 1] : s;
}

// 阶段加成：淘汰赛越靠后越值钱。顺序必须从具体到笼统，
// 否则「四分之一决赛」会先被 /决赛/ 命中拿到决赛的分。
const STAGE_RULES = [
  { test: /四分之一|八强/, add: 24, label: '四分之一决赛' },
  { test: /半决赛|四强/, add: 32, label: '半决赛' },
  { test: /决赛|冠军赛/, add: 42, label: '决赛' },
  { test: /淘汰|附加赛|季后|资格赛|保级/, add: 18, label: '淘汰赛阶段' },
  { test: /瑞士轮|小组赛|分组|循环/, add: 4, label: '小组赛' },
];

function stageBonus(stageRaw) {
  const stage = parseStage(stageRaw);
  for (const r of STAGE_RULES) {
    if (r.test.test(stage)) return r;
  }
  return { add: 0, label: '' };
}

// 单场比赛打分
function score(m) {
  const reasons = [];
  const comp = m.comp;
  const h = m.home || {};
  const a = m.away || {};
  const hs = Number(h.score) || 0;
  const as = Number(a.score) || 0;
  const diff = Math.abs(hs - as);

  // 1. 赛事分量
  let s = COMP_WEIGHT[comp] != null ? COMP_WEIGHT[comp] : 30;

  // 2. 阶段
  const st = stageBonus(m.stage);
  s += st.add;
  if (st.label) reasons.push(st.label);

  // 3. 强队：强强对话 > 单方豪门 > 无
  // ⚠️ 「豪门对决 +34」是落实「五大联赛德比优先于 LEC 决赛」的关键旋钮。
  // 它只影响足球与国家队 —— 因为 isT1() 只认 FOOTBALL_T1 / NATIONAL_T1，
  // 电竞队伍不在 T1 名单里。所以调高它不会误伤 LPL/LCK 决赛：
  //   马德里德比 80+34+6 = 120  >  LEC 决赛 52+42+16+8 = 118   ← 要的效果
  //   LPL 决赛   64+42+16+8+6+20 = 156                        ← 不受影响，仍最高
  // 改这个值必须重跑回测：调到 26 时德比会被 LEC 决赛压过去（用户否决的排法）。
  const hT1 = T.isT1(h.zh);
  const aT1 = T.isT1(a.zh);
  const hS = T.isStrong(h.zh);
  const aS = T.isStrong(a.zh);
  if (hT1 && aT1) { s += 34; reasons.push('豪门对决'); }
  else if (hS && aS) { s += 16; reasons.push('强强对话'); }
  else if (hT1 || aT1) { s += 9; reasons.push('豪门出战'); }
  else if (hS || aS) { s += 4; reasons.push('强队出战'); }

  // 4. 冷门：名单上的强队被非强队击败 —— 报纸头版最爱
  // ⚠️ 必须分级：一刀切 +38 会让「帕尔马 2-1 热那亚」这种保级队互啄
  // 盖过「马竞 2-1 皇马」的马德里德比（回测踩过这个坑）。
  // 只有掀翻 T1 豪门才算真冷门；掀翻二线强队只是小冷门。
  const beatT1 = (hT1 && !aS && as > hs) || (aT1 && !hS && hs > as);
  const beatT2 = (hS && !aS && as > hs) || (aS && !hS && hs > as);
  if (beatT1) { s += 36; reasons.push('冷门'); }
  else if (beatT2) { s += 12; reasons.push('小冷门'); }

  // 5. 戏剧性：不同项目用不同尺度
  // ⚠️ 悬殊比分必须看是谁赢谁 —— 强队大胜鱼腩是日常，弱队大胜强队才是地震
  const winner = hs > as ? h : (as > hs ? a : null);
  const loser = hs > as ? a : (as > hs ? h : null);
  const wStrong = !!winner && T.isStrong(winner.zh);
  const lStrong = !!loser && T.isStrong(loser.zh);

  if (T.isFootball(comp)) {
    if (diff >= 5) {
      if (wStrong && !lStrong) { s += 10; reasons.push('强队大胜'); }
      else if (!wStrong && lStrong) { s += 34; reasons.push('弱队大胜强队'); }
      else { s += 22; reasons.push('比分悬殊'); }
    } else if (diff === 4) {
      if (wStrong && !lStrong) s += 5;
      else if (!wStrong && lStrong) { s += 26; reasons.push('弱队大胜强队'); }
      else { s += 15; reasons.push('大比分'); }
    } else if (diff === 1) {
      s += 6;
      reasons.push('一球之差');
    }
  } else if (T.isLol(comp)) {
    const best = Math.max(hs, as);
    const worst = Math.min(hs, as);
    const bo = Number(m.bo) || 1;
    // 「BO5 打满」与「BO5」只显示一个，避免理由栏出现重复措辞
    if (bo >= 5 && best === 3 && worst === 2) { s += 28; reasons.push('BO5 打满'); }
    else if (bo >= 5 && best === 3 && worst <= 1) { s += 8; reasons.push('BO5 横扫'); }
    else if (bo >= 3 && best === 2 && worst === 1) { s += 6; }
    else if (bo >= 3) { reasons.push('BO' + bo); }
  } else if (comp === 'nba') {
    if (diff >= 25) { s += 18; reasons.push('大比分'); }
    else if (diff <= 3) { s += 16; reasons.push('毫厘之差'); }
  }

  // 6. 中国关联：按队伍判断，国际赛事里的 LPL 队伍同样算
  // ⚠️ 这是本产品最关键的定位旋钮，不是可以随手调的小分。
  // 20 的含义：中国队出战 ≈ 一场欧洲「强强对话」（+16），且同分时优先给中国（见 tieBreak）。
  // 调到 14 时，中国男足 0-3 新西兰 会被 德国 0-1 希腊 压过去 —— 中文体育报纸不会这么排。
  // 调到 26 以上，中国队打马尔代夫也会盖过豪门对决，同样失真。
  if (comp === 'lpl' || comp === 'chn') { s += 6; reasons.push('中国赛事'); }
  if (T.isCn(h.zh) || T.isCn(a.zh)) { s += 20; reasons.push('中国队伍出战'); }

  return { score: Math.round(s), reasons };
}

// 同分时怎么排：局数多的优先，其次是中国关联，最后是分差与开赛时间
function tieBreak(x, y) {
  const bo = (Number(y.bo) || 1) - (Number(x.bo) || 1);
  if (bo !== 0) return bo;
  const cnX = (T.isCn(x.home && x.home.zh) || T.isCn(x.away && x.away.zh) || x.comp === 'lpl' || x.comp === 'chn') ? 1 : 0;
  const cnY = (T.isCn(y.home && y.home.zh) || T.isCn(y.away && y.away.zh) || y.comp === 'lpl' || y.comp === 'chn') ? 1 : 0;
  if (cnX !== cnY) return cnY - cnX;
  const dX = Math.abs((Number(x.home.score) || 0) - (Number(x.away.score) || 0));
  const dY = Math.abs((Number(y.home.score) || 0) - (Number(y.away.score) || 0));
  if (dX !== dY) return dY - dX;
  return Date.parse(y.start) - Date.parse(x.start);
}

// 在一个窗口内挑出头版与备选
function pick(list, topN) {
  return list
    .filter((m) => m.status === 'finished')
    .map((m) => {
      const r = score(m);
      return Object.assign({}, m, { _score: r.score, _reasons: r.reasons });
    })
    .sort((x, y) => (y._score - x._score) || tieBreak(x, y))
    .slice(0, topN || 5);
}

module.exports = { score, pick, COMP_WEIGHT, stageBonus };
