// 每日热点图的 prompt 生成 —— 本产品的卖点
//
// 用户定的调子：「图片要有风格和思考，只做当天最重要 1 条消息的艺术延展，
//               切忌单纯的赛况赛果展示。」
//
// 怎么保证不画成赛况图：靠 STYLE 后缀里的硬约束 ——
//   no human figures / no text / no lettering / no logos / no scoreboards / no jerseys
// 没有人、没有字、没有记分牌，就画不出「赛况」；剩下的只能是隐喻。
//
// 隐喻从「叙事类型」推导，而不是从比分推导。同样是 1-0，
// 皇马赢贝蒂斯（强队小胜）和贝蒂斯赢皇马（冷门）画的是完全不同的两张图：
//   前者 → 巨石稳立、光线穿过云层
//   后者 → 高塔出现裂缝、王冠滚落台阶
// 这才是「有思考」的部分。

const T = require('./teams-tier.js');
const N = require('./team-nickname.js');
const { narrative, stageBonus } = (() => {
  const w = require('./brief-write.js');
  const s = require('./brief-score.js');
  return { narrative: w.narrative, stageBonus: s.stageBonus };
})();

// 统一风格后缀 —— 全站唯一风格来源，改这里就能改整个日报的调性。
// 选 risograph 丝网版画：它正是传统纸媒的视觉语言，与「体育报纸」的定位同源。
const STYLE = 'risograph print poster, limited 3-color palette, bold flat geometric shapes, '
  + 'heavy ink texture on warm off-white paper, slight misregistration, high contrast, '
  + 'editorial illustration, no human figures, no text, no lettering, no logos, '
  + 'no scoreboards, no jerseys, no trophies';

// 隐喻库：每个叙事给 3 个变体，按天轮换，避免连续几天撞意象
const CONCEPT = {
  champion: [
    { zh: '加冕', en: 'a single ascending staircase of light rising into a vast dark sky, a small circle of radiance at the top' },
    { zh: '山顶', en: 'a lone summit breaking through a sea of flat cloud layers, dawn light spilling from behind' },
    { zh: '旗帜', en: 'a large flag planted on a ridge, its fabric dissolving into wind strokes, distant tiny landscape below' },
  ],
  upset: [
    { zh: '高塔裂缝', en: 'a tall rigid tower with a single crack running down its side, dust falling, sky still calm' },
    { zh: '王冠滚落', en: 'a crown tumbling down empty stone steps, motion blurred, no one in frame' },
    { zh: '巨物倾倒阴影', en: 'the long shadow of a falling monolith cast across a flat empty plaza' },
  ],
  rout: [
    { zh: '洪流', en: 'a wide flood of ink sweeping across a flat valley, small geometric blocks scattered in its path' },
    { zh: '雪崩', en: 'a white avalanche pouring down a faceted mountain face, the mountain reduced to flat planes' },
    { zh: '风暴过境', en: 'diagonal storm bands tearing through a still horizon line, debris as tiny triangles' },
  ],
  bigwin: [
    { zh: '潮水漫过', en: 'a rising tide line overtaking a row of small markers on a flat shore' },
    { zh: '推土', en: 'a broad geometric wedge pushing a pile of smaller shapes off a flat plane' },
  ],
  thriller: [
    { zh: '天平两端', en: 'a balance scale holding two equal glowing spheres, perfectly level, suspended over void' },
    { zh: '第五根柱', en: 'a row of five pillars, the last one still standing while four have fallen' },
    { zh: '悬崖绳索', en: 'a taut rope stretched between two cliff edges, a single knot at its center' },
  ],
  sweep: [
    { zh: '三道刻痕', en: 'three clean parallel cuts through a solid slab, precise and unhesitating' },
    { zh: '一面墙', en: 'an unbroken wall of color blocking the entire frame, no opening' },
  ],
  dominant: [
    { zh: '阶梯', en: 'a staircase climbing out of frame with one step left unfinished at the top' },
    { zh: '压痕', en: 'a heavy rectangular impression pressed into a soft flat surface' },
  ],
  close_series: [
    { zh: '最后一格', en: 'a grid of three squares, the final one filled solid while two stay hollow' },
  ],
  derby: [
    { zh: '两色对撞', en: 'two solid color fields colliding along a single jagged vertical seam' },
    { zh: '双河交汇', en: 'two rivers of different colors merging into one channel at the horizon' },
    { zh: '同城两光', en: 'two separate beams of light rising from one shared block of city rooftops' },
  ],
  nailbiter: [
    { zh: '一线之间', en: 'a razor-thin bright line separating two vast dark fields' },
    { zh: '悬停', en: 'a single sphere balanced on the very tip of a narrow spire' },
    { zh: '窄门', en: 'a barely-open door leaking a thin blade of light into a dark room' },
  ],
  draw: [
    { zh: '镜像', en: 'two identical shapes facing each other across a still reflective surface' },
    { zh: '静止', en: 'a perfectly still horizon with two equal suns at opposite ends' },
  ],
  goalless: [
    { zh: '空网', en: 'an empty net rendered as flat geometric lattice, nothing passing through it' },
    { zh: '零', en: 'a large empty circle centered on blank paper, its outline incomplete' },
  ],
  shutout: [
    { zh: '未开之门', en: 'a heavy closed gate with light spilling only underneath it' },
    { zh: '密闭', en: 'a sealed rectangular vessel, no seam visible, set against a dark field' },
  ],
  goalfest: [
    { zh: '迸发', en: 'multiple bursts of color radiating from a single point, overlapping halos' },
    { zh: '对撞', en: 'two waves crashing into each other, spray frozen mid-air as dots' },
  ],
  clash: [
    { zh: '两阵', en: 'two opposing formations of flat shapes facing off across empty ground' },
    { zh: '相持', en: 'two massive blocks leaning against each other, neither yielding' },
  ],
  plain: [
    { zh: '一行足迹', en: 'a single line of footprints crossing an otherwise blank field' },
    { zh: '路标', en: 'a lone signpost at a fork in a flat empty road under a wide sky' },
  ],
};

// 队色 → 调色板。取双方主色 + 一个纸色。
// ⚠️ 两队同色时（ESPN 常给一样的默认色）必须做偏移，否则整张图只有一个颜色
function palette(m) {
  const hc = N.color(m.home.color);
  const ac = N.color(m.away.color);
  let c2 = ac;
  if (hc.toLowerCase() === ac.toLowerCase()) {
    // 同色：把客队色做色相旋转，保证画面仍有对撞
    const r = parseInt(ac.slice(1, 3), 16);
    const g = parseInt(ac.slice(3, 5), 16);
    const b = parseInt(ac.slice(5, 7), 16);
    c2 = '#' + [b, r, g].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  return { primary: hc, secondary: c2, paper: '#f2ede2' };
}

// 程序化海报指令（主力方案，见文件头注释）
// 与 AI prompt 并存：poster 用于小程序 canvas 实时绘制，prompt 作为外部生图模型的备选。
function posterPlan(m, narKey, seq) {
  const DSL = require('./poster-dsl.js');
  return DSL.posterOps(m, narKey || narrative(m).key, seq);
}

// 生成完整 prompt
function imageConcept(m, seq) {
  const nar = narrative(m);
  const list = CONCEPT[nar.key] || CONCEPT.plain;
  const c = list[(seq || 0) % list.length];
  const pal = palette(m);
  const comp = require('./brief-write.js').compZh(m.comp);

  const prompt = [
    c.en,
    'color palette: ' + pal.primary + ' and ' + pal.secondary + ' on ' + pal.paper + ' paper',
    'mood: ' + MOOD[nar.key],
    STYLE,
  ].join('. ');

  const poster = posterPlan(m, nar.key, seq);
  return {
    conceptZh: c.zh,
    narrative: nar.key,
    narrativeZh: nar.label || '',
    sceneEn: c.en,
    palette: pal,
    prompt,
    // 程序化绘制指令：小程序 canvas 直接回放即可出图，不需要任何图像文件或外部服务
    poster: { ops: poster.ops, variant: poster.variant, palette: poster.palette },
    // 给日报页面用的中文图注 —— 说明这张图在说什么，但绝不写比分
    caption: '当日头条：' + comp + '，' + nar.label + '。图为「' + c.zh + '」的艺术延展。',
  };
}

// 情绪词：让画面不只是构图，还有情绪
const MOOD = {
  champion: 'solemn and elevated',
  upset: 'quiet shock, stillness after collapse',
  rout: 'overwhelming force',
  bigwin: 'inevitable momentum',
  thriller: 'taut suspense held at the breaking point',
  sweep: 'absolute and clean',
  dominant: 'controlled and composed',
  close_series: 'narrow escape',
  derby: 'opposing weight, two equals',
  nailbiter: 'held breath',
  draw: 'unresolved equilibrium',
  goalless: 'absence, emptiness',
  shutout: 'sealed, impenetrable',
  goalfest: 'chaotic abundance',
  clash: 'contained tension',
  plain: 'steady, unremarkable',
};

module.exports = { imageConcept, palette, STYLE, CONCEPT, MOOD };
