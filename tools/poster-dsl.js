// 热点图的「视觉语法」：把叙事类型翻译成几何绘制指令
//
// 为什么不用 AI 生图：日报每天一张、绑定当天具体比赛，不能靠人工出图；
// 云端 SDK 只有 chat.completions，没有生图通道（已确认）；
// 走第三方图像 API 又要额外 key 与费用，且会引入失败点。
// 而 risograph 版画的本质 —— 有限专色、几何色块、错位套印、纸纹噪点 ——
// 恰好是算法最擅长、生成模型最不稳定的东西。
//
// 产物是**平台无关的绘制指令**（归一化坐标 0-1）：
//   Node 侧    → poster-raster.js 光栅化成 PNG，用于本地验证构图
//   小程序侧   → canvas type="2d" 回放同一套指令，实时出图、零存储、零流量
// 两侧共用一个真源，不会出现「本地好看、端上跑偏」。

const PAPER = '#f2ede2';

// ── 基础形状 ──
function bg(c) { return { op: 'bg', color: c }; }
function rect(x, y, w, h, c) { return { op: 'rect', x, y, w, h, color: c }; }
function circle(cx, cy, r, c) { return { op: 'circle', cx, cy, r, color: c }; }
function ring(cx, cy, r, wd, c) { return { op: 'ring', cx, cy, r, w: wd, color: c }; }
function poly(pts, c) { return { op: 'poly', pts, color: c }; }
function grain(d, a, c) { return { op: 'grain', density: d, alpha: a, color: c }; }

// 错位套印：同一形状用专色画两遍，第二遍轻微偏移 —— risograph 的招牌特征
function misreg(shape, dx, dy) {
  return [shape, Object.assign({}, shape, { x: (shape.x || 0) + dx, y: (shape.y || 0) + dy })];
}

// 锯齿竖线：从 (x, y0) 到 (x, y1)，带 n 段左右摆动的折线
function zigzagX(x, y0, y1, amp, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([x + (i % 2 === 0 ? amp : -amp), y0 + (y1 - y0) * t]);
  }
  return pts;
}

// ── 各叙事的构图 ──
// 每个函数返回指令数组。c1 = 主队色，c2 = 客队色，s = 变体序号
const GRAMMAR = {
  // 夺冠：基座 → 阶梯 → 顶端光轮
  champion(s, c1, c2) {
    const v = s % 3;
    if (v === 1) {
      // 山顶：层叠的云线 + 露出的一座尖峰
      const o = [bg(PAPER)];
      for (let i = 0; i < 5; i++) {
        const y = 0.52 + i * 0.09;
        o.push(rect(0, y, 1, 0.045, i % 2 === 0 ? c1 : c2));
      }
      o.push(poly([[0.5, 0.16], [0.72, 0.55], [0.28, 0.55]], c1));
      o.push(rect(0, 0.52, 1, 0.035, PAPER));
      return o;
    }
    if (v === 2) {
      // 旗帜：一根杆 + 一面被风撕开的旗
      const o = [bg(PAPER)];
      o.push(rect(0.47, 0.28, 0.022, 0.5, c2));
      o.push(poly([[0.492, 0.3], [0.78, 0.34], [0.492, 0.46]], c1));
      o.push(poly([[0.492, 0.47], [0.72, 0.52], [0.492, 0.6]], c1));
      o.push(rect(0.2, 0.78, 0.6, 0.03, c2));
      return o;
    }
    // 加冕：阶梯向上 + 光轮
    const o = [bg(PAPER)];
    for (let i = 0; i < 4; i++) {
      const w = 0.34 - i * 0.07;
      o.push(rect(0.5 - w / 2, 0.68 - i * 0.11, w, 0.075, i % 2 === 0 ? c1 : c2));
    }
    o.push(circle(0.5, 0.2, 0.078, c1));
    o.push(circle(0.5, 0.2, 0.05, PAPER));
    return o;
  },

  // 冷门：高塔 + 一道贯穿的裂缝
  upset(s, c1, c2) {
    const v = s % 3;
    if (v === 1) {
      // 王冠滚落：台阶 + 一个倾斜的冠形
      const o = [bg(PAPER)];
      for (let i = 0; i < 4; i++) o.push(rect(0.12, 0.62 + i * 0.08, 0.76, 0.05, c1));
      o.push(poly([[0.3, 0.5], [0.36, 0.34], [0.44, 0.44], [0.52, 0.3], [0.6, 0.44], [0.68, 0.34], [0.74, 0.5]], c2));
      o.push(rect(0.3, 0.5, 0.44, 0.05, c2));
      return o;
    }
    if (v === 2) {
      // 巨物的长影：一个巨大的暗块 + 拖出的平行四边形阴影
      const o = [bg(PAPER)];
      o.push(poly([[0.34, 0.2], [0.66, 0.2], [0.86, 0.62], [0.14, 0.62]], c1));
      o.push(poly([[0.14, 0.62], [0.86, 0.62], [0.98, 0.84], [0.02, 0.84]], c2));
      return o;
    }
    // 高塔裂缝
    const o = [bg(PAPER)];
    o.push(rect(0.41, 0.1, 0.18, 0.78, c1));
    const pts = [];
    const n = 7;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push([0.5 + (i % 2 === 0 ? 0.035 : -0.02), 0.1 + 0.78 * t]);
    }
    for (let i = n; i >= 0; i--) {
      const t = i / n;
      pts.push([0.5 + (i % 2 === 0 ? 0.035 : -0.02) + 0.022, 0.1 + 0.78 * t]);
    }
    o.push(poly(pts, PAPER));
    // 落尘
    const dust = [[0.31, 0.66], [0.28, 0.74], [0.69, 0.6], [0.72, 0.7], [0.33, 0.5], [0.68, 0.48]];
    dust.forEach(([x, y]) => o.push(rect(x, y, 0.028, 0.028, c2)));
    return o;
  },

  // 血洗：一道横贯的洪流 + 散落的碎块
  rout(s, c1, c2) {
    const o = [bg(PAPER)];
    o.push(poly([[0, 0.34], [1, 0.2], [1, 0.62], [0, 0.76]], c1));
    const blocks = [[0.12, 0.82], [0.24, 0.86], [0.38, 0.81], [0.52, 0.87], [0.66, 0.82], [0.8, 0.85]];
    blocks.forEach(([x, y], i) => o.push(rect(x, y, 0.05 + (i % 3) * 0.02, 0.035, c2)));
    o.push(rect(0, 0.28, 1, 0.02, c2));
    return o;
  },

  bigwin(s, c1, c2) {
    const o = [bg(PAPER)];
    // 潮线漫过一排标记
    o.push(rect(0, 0.55, 1, 0.45, c1));
    for (let i = 0; i < 6; i++) {
      const x = 0.12 + i * 0.14;
      o.push(rect(x, 0.44 - (i % 3) * 0.03, 0.035, 0.16 + (i % 3) * 0.03, c2));
    }
    return o;
  },

  // 德比：两块沿锯齿垂直接缝对撞
  derby(s, c1, c2) {
    const o = [bg(PAPER)];
    const n = 9;
    const y0 = 0.08; const y1 = 0.92;
    const left = [[0, y0]];
    const right = [[1, y0]];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const y = y0 + (y1 - y0) * t;
      left.push([0.5 + (i % 2 === 0 ? 0.055 : -0.045), y]);
      right.unshift([0.5 - (i % 2 === 0 ? 0.045 : -0.055), y]);
    }
    left.push([0, y1]);
    right.push([1, y1]);
    o.push(poly(left, c1));
    o.push(poly(right, c2));
    return o;
  },

  // 打满五局：五根柱，前四根倒、最后一根立
  thriller(s, c1, c2) {
    const o = [bg(PAPER)];
    for (let i = 0; i < 4; i++) {
      const y = 0.6 + i * 0.075;
      o.push(rect(0.1 + i * 0.06, y, 0.5, 0.05, c1));
    }
    o.push(rect(0.62, 0.22, 0.1, 0.66, c2));
    o.push(rect(0.1, 0.88, 0.8, 0.03, c1));
    return o;
  },

  // 横扫：三条等距、无变化的粗带
  sweep(s, c1, c2) {
    const o = [bg(PAPER)];
    for (let i = 0; i < 3; i++) o.push(rect(0.08, 0.24 + i * 0.19, 0.84, 0.11, c1));
    o.push(rect(0.08, 0.24, 0.84, 0.012, c2));
    return o;
  },

  // 险胜：两块几乎相接，中间一道极细的亮线
  nailbiter(s, c1, c2) {
    const o = [bg(PAPER)];
    o.push(rect(0.06, 0.1, 0.88, 0.39, c1));
    o.push(rect(0.06, 0.51, 0.88, 0.39, c2));
    o.push(rect(0.0, 0.492, 1, 0.012, PAPER));
    o.push(rect(0.06, 0.5, 0.88, 0.005, c2 === PAPER ? c1 : PAPER));
    return o;
  },

  // 平局：两个等大的圆，中轴对称
  draw(s, c1, c2) {
    const o = [bg(PAPER)];
    o.push(circle(0.32, 0.5, 0.175, c1));
    o.push(circle(0.68, 0.5, 0.175, c2));
    o.push(rect(0.498, 0.16, 0.004, 0.68, PAPER));
    return o;
  },

  // 互交白卷：一个空的圆环
  goalless(s, c1, c2) {
    const o = [bg(PAPER)];
    o.push(ring(0.5, 0.5, 0.26, 0.045, c1));
    o.push(ring(0.5, 0.5, 0.15, 0.03, c2));
    return o;
  },

  // 零封：完整的一块，底部漏一线光
  shutout(s, c1, c2) {
    const o = [bg(PAPER)];
    o.push(rect(0.22, 0.14, 0.56, 0.68, c1));
    o.push(rect(0.22, 0.84, 0.56, 0.045, c2 === PAPER ? '#e8c400' : PAPER));
    o.push(rect(0.22, 0.14, 0.56, 0.02, c2));
    return o;
  },

  // 进球大战：同心环 + 放射线
  goalfest(s, c1, c2) {
    const o = [bg(PAPER)];
    for (let i = 0; i < 5; i++) {
      o.push(ring(0.5, 0.5, 0.08 + i * 0.075, 0.028, i % 2 === 0 ? c1 : c2));
    }
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const x0 = 0.5 + Math.cos(a) * 0.42;
      const y0 = 0.5 + Math.sin(a) * 0.42;
      o.push(rect(x0 - 0.008, y0 - 0.008, 0.016, 0.016, i % 2 === 0 ? c1 : c2));
    }
    return o;
  },

  // 五局内解决：四格里填三格
  dominant(s, c1, c2) {
    const o = [bg(PAPER)];
    for (let i = 0; i < 4; i++) {
      const x = 0.12 + i * 0.2;
      if (i < 3) o.push(rect(x, 0.3, 0.16, 0.4, c1));
      else o.push(ring(x + 0.08, 0.5, 0.07, 0.02, c2));
    }
    return o;
  },

  // 三局苦战：三格里只填最后一格
  close_series(s, c1, c2) {
    const o = [bg(PAPER)];
    for (let i = 0; i < 3; i++) {
      const x = 0.16 + i * 0.24;
      if (i === 2) o.push(rect(x, 0.3, 0.2, 0.4, c2));
      else o.push(ring(x + 0.1, 0.5, 0.09, 0.02, c1));
    }
    return o;
  },

  // 强强对话：两阵相向，中间一道空隙
  clash(s, c1, c2) {
    const o = [bg(PAPER)];
    for (let i = 0; i < 3; i++) {
      o.push(rect(0.1, 0.24 + i * 0.19, 0.3 - i * 0.04, 0.11, c1));
      o.push(rect(0.9 - (0.3 - i * 0.04), 0.24 + i * 0.19, 0.3 - i * 0.04, 0.11, c2));
    }
    return o;
  },

  // 一般取胜：一行标记，最后一个偏移
  plain(s, c1, c2) {
    const o = [bg(PAPER)];
    for (let i = 0; i < 5; i++) {
      const x = 0.14 + i * 0.17;
      o.push(rect(x, 0.45, 0.09, 0.09, c1));
    }
    o.push(rect(0.14 + 5 * 0.17, 0.38, 0.09, 0.09, c2));
    return o;
  },
};

// 生成一期热点图的绘制指令
// m: 比赛对象（取队色）；nar: 叙事 key；seq: 变体序号
function posterOps(m, nar, seq) {
  const N = require('./team-nickname.js');
  const I = require('./brief-image.js');
  const pal = I.palette(m);
  const g = GRAMMAR[nar] || GRAMMAR.plain;
  const ops = g(seq || 0, pal.primary, pal.secondary);
  // 纸纹：所有构图之后统一叠一层噪点
  ops.push(grain(0.07, 0.16, '#3a3a3a'));
  return {
    ops,
    palette: pal,
    narrative: nar,
    variant: (seq || 0) % 3,
  };
}

module.exports = { GRAMMAR, posterOps, PAPER };
