// 强队名单 —— 选题算法做「冷门探测」和「强强对话」判断的依据
// 名字必须与 data/matches.js 里的 home.zh / away.zh 完全一致（已对照实际数据核对）
// 本文件只在构建期被 tools/* 引用，不进小程序包（project.config.json 已 ignore tools/）

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
const LOL_STRONG = [
  // LPL
  '哔哩哔哩', '滔搏电竞', '京东电竞', "Anyone's Legend", '微博电竞', 'LNG', 'IG', 'EDG',
  // LCK
  'T1', 'Gen.G', '韩华生命', 'DK', 'KT Rolster',
  // LEC
  'G2 Esports', 'Fnatic', 'Karmine Corp', 'Movistar KOI', 'Team Vitality', 'SK Gaming',
  // 其他赛区
  'FlyQuest', '100 Thieves', 'Team Liquid', '中信飞牡蛎', 'PSG Talon', 'Vivo Keyd Stars',
];

// 中国关联：出现即加权，国内用户天然关心
const CN_TEAMS = ['中国男足', '中国女足', '中国U17', '中国U20', '中国U23'];

// LPL（中国大陆赛区）俱乐部。注意：即使是在 worlds / msi 这类国际赛事里，
// LPL 队伍出战对国内用户依然是最有话题的，所以按队伍而非按赛事来判断。
const CN_CLUBS = [
  '哔哩哔哩', '滔搏电竞', '京东电竞', "Anyone's Legend", '微博电竞',
  'LNG', 'IG', 'EDG', 'NIP', 'WE', 'TT', 'LGD', 'FPX', 'RNG', 'OMG', 'UP',
];

const ALL_STRONG = new Set([
  ...FOOTBALL_T1, ...FOOTBALL_T2, ...NATIONAL_STRONG, ...LOL_STRONG,
]);

const FOOTBALL_COMPS = new Set(['epl', 'liga', 'seriea', 'bundesliga', 'ligue1', 'ucl', 'uel', 'nations', 'chn']);
const LOL_COMPS = new Set(['lpl', 'lck', 'lec', 'worlds', 'msi']);

function isStrong(name) { return !!name && ALL_STRONG.has(name); }
function isT1(name) { return !!name && (FOOTBALL_T1.includes(name) || NATIONAL_T1.includes(name)); }
function isCn(name) { return !!name && (CN_TEAMS.includes(name) || CN_CLUBS.includes(name)); }
function isFootball(comp) { return FOOTBALL_COMPS.has(comp); }
function isLol(comp) { return LOL_COMPS.has(comp); }

module.exports = {
  FOOTBALL_T1, FOOTBALL_T2, NATIONAL_T1, NATIONAL_STRONG, LOL_STRONG, CN_TEAMS, CN_CLUBS,
  isStrong, isT1, isCn, isFootball, isLol,
};
