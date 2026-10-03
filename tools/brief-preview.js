// 空窗日的前瞻：窗口内没有已结束的比赛时，改出「未来看点」
//
// ⚠️ 这一层比写作层更容易出现幻觉，因为没有比分，人会不自觉地补内容。
// 硬规则：前瞻**只写赛程事实与静态分量**，绝不写
//   - 状态 / 近期战绩 / 连胜连败（无数据）
//   - 预测、胜负倾向、赔率（无数据且违规）
//   - 历史交锋、伤病、停赛（无数据）
// 能写的只有：开赛时间、赛事、阶段、场地、队伍分量（名单档次）、为什么值得看。

const T = require('./teams-tier.js');
const N = require('./team-nickname.js');
const { COMP_WEIGHT, stageBonus } = require('./brief-score.js');
const { compZh, stageZh } = require('./brief-write.js');

const HOUR = 3600000;

// 前瞻打分：与 brief-score 的区别是不含任何比分相关项，并加入「临近度」
function previewScore(m, nowMs) {
  const comp = m.comp;
  let s = COMP_WEIGHT[comp] != null ? COMP_WEIGHT[comp] : 30;
  const reasons = [];

  const st = stageBonus(m.stage);
  s += st.add * 1.2; // 前瞻阶段权重要比战报更重：还没打的决赛比已结束的更值得预告
  if (st.label) reasons.push(st.label);

  // ⚠️ 队名一律走显示口径 disp（zh || name）—— 电竞俱乐部 zh 是空的，见 teams-tier.js 文件头
  const hz = T.disp(m.home); const az = T.disp(m.away);
  const hT1 = T.isT1(hz);
  const aT1 = T.isT1(az);
  const hS = T.isStrong(hz);
  const aS = T.isStrong(az);
  if (hT1 && aT1) { s += 30; reasons.push('豪门对决'); }
  else if (hS && aS) { s += 16; reasons.push('强强对话'); }
  else if (hT1 || aT1) { s += 8; reasons.push('豪门出战'); }

  if (T.isCn(hz) || T.isCn(az)) { s += 20; reasons.push('中国队伍出战'); }
  else if (comp === 'lpl' || comp === 'chn' || comp === 'kpl') { s += 6; reasons.push('中国赛事'); }

  // 临近度：越近的越值得预告
  const hours = (Date.parse(m.start) - nowMs) / HOUR;
  if (hours <= 24) { s += 20; reasons.push('24 小时内'); }
  else if (hours <= 48) s += 10;
  else if (hours <= 72) s += 3;

  return { score: Math.round(s), reasons };
}

/**
 * @param {Array} list 候选比赛
 * @param {number} nowMs 出报时刻
 * @param {boolean} [includeLive] 是否把「正在进行」的比赛也算进来
 *   晚报（今夜看点）要开：18:00 开赛的比赛打到 21:00 出报时可能还没结束，
 *   那正是用户此刻最关心的场次，排除掉的话清单里会缺一块。
 *   早报不开：早报面向「接下来一天」，只预告未开赛的，避免把已结束的比赛再预告一遍。
 */
function pick(list, nowMs, includeLive, topN) {
  return list
    .filter((m) => (includeLive ? m.status !== 'finished' : m.status === 'upcoming'))
    .map((m) => {
      const r = previewScore(m, nowMs);
      return Object.assign({}, m, { _score: r.score, _reasons: r.reasons });
    })
    .sort((a, b) => b._score - a._score || Date.parse(a.start) - Date.parse(b.start))
    .slice(0, topN || 5);
}

// 「为什么值得看」—— 只从静态事实推导
// ⚠️ 没有特殊理由时不要返回「本轮值得留意的对阵」这种万金油句子：
// 一条清单里出现四五次等于没说（回测踩过）。改为返回 null，由调用方改用倒计时。
function why(m) {
  const bits = [];
  const st = stageBonus(m.stage);
  if (st.label === '决赛') bits.push('决定冠军归属');
  else if (st.label === '半决赛') bits.push('胜者进决赛');
  else if (st.label === '四分之一决赛') bits.push('输球即止步');
  else if (st.label === '淘汰赛阶段') bits.push('淘汰赛，没有退路');
  const hz = T.disp(m.home); const az = T.disp(m.away);
  if (T.isT1(hz) && T.isT1(az)) bits.push('两支顶级球队对话');
  else if (T.isStrong(hz) && T.isStrong(az) && st.label) bits.push('强队相遇');
  if (T.isCn(hz) || T.isCn(az)) bits.push('中国队伍出战');
  return bits.length ? bits.join('，') : null;
}

// 相对时间的说法：清单里「什么时候打」比「值不值得看」更有用
function relative(m, nowMs) {
  const h = Math.round((Date.parse(m.start) - nowMs) / HOUR);
  if (h < 0) return '进行中';
  if (h < 6) return h + ' 小时后';
  if (h < 24) return h + ' 小时后';
  const d = Math.round(h / 24);
  return d === 1 ? '明日' : d + ' 天后';
}

// 项目大类：前瞻要按类分栏，否则「法国 vs 比利时」这类高分会把
// NBA、LPL 全部挤出清单，篮球和电竞用户打开日报看到的全是足球（回测踩过）。
const GROUP = {
  football: ['epl', 'liga', 'seriea', 'bundesliga', 'ligue1', 'ucl', 'uel', 'nations', 'chn'],
  basketball: ['nba'],
  esports: ['lpl', 'lck', 'lec', 'worlds', 'msi'],
};

const GROUP_ZH = { football: '足球', basketball: '篮球', esports: '电竞' };

function groupOf(comp) {
  for (const g of Object.keys(GROUP)) if (GROUP[g].indexOf(comp) >= 0) return g;
  return 'football';
}

// 生成一期前瞻（按项目分栏，每栏最多 perGroup 条）
// opts.includeLive：晚报「今夜看点」传 true，把正在进行的比赛也算进候选
function build(list, nowMs, perGroup, opts) {
  const n = perGroup || 2;
  const ranked = pick(list, nowMs, opts && opts.includeLive, 999);
  const buckets = { football: [], basketball: [], esports: [] };
  ranked.forEach((m) => {
    const g = groupOf(m.comp);
    if (buckets[g].length < n) buckets[g].push(m);
  });
  const top = [];
  ['football', 'basketball', 'esports'].forEach((g) => {
    buckets[g].forEach((m) => top.push(Object.assign({}, m, { _group: g })));
  });

  return {
    mode: 'preview',
    // 晚报的 tag 是「今夜看点」，早报留空（早报是战报位，空窗时的前瞻不另起标题）
    tag: (opts && opts.tag) || '',
    intro: '',
    items: top.map((m) => {
      const comp = compZh(m.comp);
      const stage = stageZh(m.stage);
      // ⚠️ 前瞻清单统一用队名，不用绰号。
      // pairLabel 是「双方都有绰号才用」，会让同一份清单里「斗牛士 vs 格子军团」
      // 和「捷克 vs 英格兰」并存 —— 报纸上这种混排很不专业（回测踩过）。
      // 绰号留给标题，清单保持清爽。
      return {
        matchId: m.id,
        comp, stage,
        group: m._group,
        groupZh: GROUP_ZH[m._group],
        time: m.date + ' ' + (m.time || ''),
        venue: m.venue || '',
        home: T.disp(m.home), away: T.disp(m.away),
        why: why(m),
        relative: relative(m, nowMs),
        reasons: m._reasons,
        score: m._score,
      };
    }),
    groups: ['football', 'basketball', 'esports']
      .filter((g) => buckets[g].length)
      .map((g) => ({ key: g, zh: GROUP_ZH[g], count: buckets[g].length })),
  };
}

/**
 * 引言：把窗口和接下来的时间跨度说清楚，不含任何预测
 *
 * ⚠️ 晚报的 windowLabel 在 brief-build.js 里已经被换成「今夜」窗口
 * （当日 18:00 → 次日 06:00），所以这里不能再写「……内没有已结束的比赛」——
 * 那句话指的是战报窗口，两段拼在一起会自相矛盾。晚报直接说「今夜看点」。
 */
function intro(pubDate, kind, windowLabel, hours) {
  if (kind === 'evening') {
    return '北京时间' + windowLabel + '值得留意的比赛 —— 今夜看点。';
  }
  return '北京时间' + windowLabel + '内没有已结束的比赛。'
    + '以下是未来 ' + hours + ' 小时值得留意的对阵。';
}

module.exports = { previewScore, pick, build, why, intro };
