// 强队名单 —— 选题算法做「冷门探测」和「强强对话」判断的依据
//
// 🔴 **取名字一律用 `disp(t)`，不要直接写 `m.home.zh`**（2026-10-03 踩过）。
//    电竞俱乐部队按用户 10-02 的要求是「`zh` 留空、`name` 放简码」（见 sync.js 的 lolTeam），
//    显示口径是小程序的 `t.zh || t.name || t.abbr`（utils/data.js:179）。
//    日报写作层当初直接读 `.zh` → 电竞比赛的队名全是空串，
//    头条被写成了「战胜，比分1-0」这种没有主语的句子。
//    本文件只在构建期被 tools/* 引用，不进小程序包（project.config.json 已 ignore tools/）


// 欧洲豪门：出现在头部时天然有话题度
const FOOTBALL_T1 = [
  '皇家马德里', '巴塞罗那', '马德里竞技',
  '曼城', '曼联', '利物浦', '阿森纳', '切尔西', '热刺',
  '拜仁慕尼黑', '多特蒙德', 'RB莱比锡', '勒沃库森',
  '国际米兰', 'AC米兰', '尤文图斯', '那不勒斯', '罗马', '拉齐奥', '亚特兰大',
  '巴黎圣日耳曼', '马赛', '摩纳哥',
];

// 欧陆二线强队与常客：豪门之外仍有话题
const FOOTBALL_T2 = [
  '纽卡斯尔联', '阿斯顿维拉', '布莱顿', '水晶宫', '埃弗顿', '西汉姆联', '富勒姆', '布伦特福德',
  '塞维利亚', '瓦伦西亚', '皇家贝蒂斯', '皇家社会', '比利亚雷亚尔', '毕尔巴鄂竞技',
  '法兰克福', '斯图加特', '弗赖堡', '云达不莱梅', '门兴格拉德巴赫', '霍芬海姆',
  '佛罗伦萨', '博洛尼亚', '都灵', '乌迪内斯', '萨索洛', '热那亚', '科莫',
  '里尔', '朗斯', '尼斯', '里昂', '雷恩', '斯特拉斯堡', '图卢兹',
  '本菲卡', '波尔图', '葡萄牙体育', '埃因霍温', '费耶诺德', '阿贾克斯',
  '凯尔特人', '奥林匹亚科斯', '加拉塔萨雷', '费内巴切', '贝西克塔斯',
  '萨尔茨堡红牛', '萨格勒布迪纳摩', '布鲁日', '顿涅茨克矿工', '布拉格斯拉维亚',
];

// 国家队顶级：世界杯/欧洲杯常客，对决即头条
const NATIONAL_T1 = [
  '法国', '英格兰', '西班牙', '德国', '意大利', '葡萄牙', '荷兰', '比利时',
  '克罗地亚', '巴西', '阿根廷', '乌拉圭',
];

// 国家队强队（欧国联、世界杯预选赛等）
const NATIONAL_STRONG = [
  '法国', '英格兰', '西班牙', '德国', '意大利', '葡萄牙', '荷兰', '比利时', '克罗地亚',
  '丹麦', '挪威', '瑞典', '瑞士', '波兰', '土耳其', '塞尔维亚', '奥地利', '捷克',
  '匈牙利', '乌克兰', '苏格兰', '威尔士', '希腊', '罗马尼亚', '斯洛伐克', '斯洛文尼亚',
  '芬兰', '爱尔兰', '北爱尔兰', '格鲁吉亚', '波黑', '阿尔巴尼亚', '黑山', '冰岛',
];

// 电竞强队
// ⚠️ 名单必须按**显示口径**写：英雄联盟俱乐部的显示值是简码（BLG / T1 / G2），
//    不是「哔哩哔哩」这种中文名 —— 早期按中文名写，isStrong() 对电竞永远返回 false。
const LOL_STRONG = [
  // 中文名（历史遗留 + 亚运会国家队口径）
  '哔哩哔哩', '滔搏电竞', '京东电竞', "Anyone's Legend", '微博电竞',
  // LPL 简码
  'BLG', 'JDG', 'TES', 'WBG', 'LNG', 'IG', 'EDG', 'RNG', 'NIP', 'OMG',
  // LCK 简码（⚠️ 用实际显示值：GEN 不是 Gen.G、KRX/DNS/NS 这些新队也在）
  'T1', 'GEN', 'HLE', 'DK', 'KT', 'BRO', 'BFX', 'KRX', 'DNS', 'NS',
  // LEC / 其他赛区简码（实际显示值，照抄一下就别再猜了）
  'G2', 'FNC', 'KC', 'MKOI', 'GX', 'SK', 'TH', 'VIT', 'SHFT',
  'TL', 'C9', 'FLY', '100T', 'PSG', 'GAM', 'NAVI',
];

// 中国关联：出现即加权，国内用户天然关心
// ⚠️ 港澳台按官方口径写「中国香港 / 中国澳门 / 中国台北」，且同样计入中国关联权重。
const CN_TEAMS = [
  '中国男足', '中国女足', '中国U17', '中国U20', '中国U23',
  '中国香港', '中国澳门', '中国台北',
];

// LPL（中国大陆赛区）俱乐部。注意：即使是在 worlds / msi 这类国际赛事里，
// LPL 队伍出战对国内用户依然是最有话题的，所以按队伍而非按赛事来判断。
// ⚠️ 同上：写**显示口径**（简码）才匹配得上。
const CN_CLUBS = [
  '哔哩哔哩', '滔搏电竞', '京东电竞', "Anyone's Legend", '微博电竞',
  'BLG', 'JDG', 'TES', 'WBG',
  'LNG', 'IG', 'EDG', 'NIP', 'WE', 'TT', 'LGD', 'FPX', 'RNG', 'OMG', 'UP',
];

const ALL_STRONG = new Set([
  ...FOOTBALL_T1, ...FOOTBALL_T2, ...NATIONAL_STRONG, ...LOL_STRONG,
]);

/**
 * 赛事 → 项目大类。
 *
 * ⚠️ 这两张表原来都**不全**（2026-10-03 修真）：足球少 7 项（csl/acl/uecl/asiacup/u17/u17w/friendly）、
 *    电竞少 3 项（demacia/kpl/agames）。后果不是"没分类"这么轻 ——
 *    是 `isFootball()` / `isLol()` 双双返回 false，比赛掉进**通用分支**，
 *    于是英雄联盟的比赛被写上了「双方仅一球之差，把握住机会，未能扳回」这种足球措辞。
 */
const FOOTBALL_COMPS = new Set([
  'epl', 'liga', 'seriea', 'bundesliga', 'ligue1', 'ucl', 'uel', 'uecl', 'nations', 'chn',
  'csl', 'acl', 'asiacup', 'u17', 'u17w', 'friendly',
]);
/** 英雄联盟系（含亚运会英雄联盟项目、德杯这种区域杯赛）—— 措辞按「局」走 */
const LOL_COMPS = new Set(['lpl', 'lck', 'lec', 'worlds', 'msi', 'demacia', 'agames']);
/**
 * 电竞总类 = 英雄联盟系 ∪ 非英雄联盟项目（KPL 是王者荣耀）。
 * 电竞一律用「局」的措辞，**绝不能出现「球」**。
 */
const ESPORTS_COMPS = new Set([...LOL_COMPS, 'kpl']);
const BASKETBALL_COMPS = new Set(['nba', 'cba']);

/**
 * 国字号的队名会带后缀：数据里是「中国U23亚运队」「中国U17女足」，
 * 而白名单里写的是「中国U23」「中国U17」—— 靠白名单必漏。
 * 后果不是少一个字：`isCn` 判否 → 「中国队伍出战 +20」拿不到，
 * 中国队的比赛就会被欧洲豪门对决压下去（2026-10-03 回测发现 09-30 亚运半决赛漏了 20 分）。
 */
const CN_NAME_PREFIX = /^中国(男足|女足|U\d+)/;

function isStrong(name) { return !!name && ALL_STRONG.has(name); }
function isT1(name) { return !!name && (FOOTBALL_T1.includes(name) || NATIONAL_T1.includes(name)); }
function isCn(name) {
  if (!name) return false;
  if (CN_TEAMS.includes(name) || CN_CLUBS.includes(name)) return true;
  return CN_NAME_PREFIX.test(name);
}
function isFootball(comp) { return FOOTBALL_COMPS.has(comp); }
function isLol(comp) { return LOL_COMPS.has(comp); }
function isEsports(comp) { return ESPORTS_COMPS.has(comp); }
function isBasketball(comp) { return BASKETBALL_COMPS.has(comp); }

/**
 * 队名的**显示口径** —— 必须与小程序 `utils/data.js` 的 `t.zh || t.name || t.abbr` 完全一致。
 * 任何要写进文案的地方都过它，不要直接取 `.zh`（原因见文件头）。
 */
function disp(t) {
  if (!t) return '';
  return t.zh || t.name || t.abbr || '';
}

module.exports = {
  FOOTBALL_T1, FOOTBALL_T2, NATIONAL_T1, NATIONAL_STRONG, LOL_STRONG, CN_TEAMS, CN_CLUBS,
  FOOTBALL_COMPS, LOL_COMPS, ESPORTS_COMPS, BASKETBALL_COMPS,
  isStrong, isT1, isCn, isFootball, isLol, isEsports, isBasketball, disp,
};
