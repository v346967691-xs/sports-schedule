// 把绘制指令光栅化成 PNG —— 零依赖（只用 Node 内置 zlib）
// 用途：本地验证构图。小程序端不跑这个，改由 canvas 2d 回放同一套指令。
//
// 用法：node tools/poster-raster.js <比赛id> <叙事> <变体> [宽] [高] [输出]

const fs = require('fs');
const zlib = require('zlib');

// ── CRC32 ──
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePNG(w, h, rgb) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 3);
    raw[off] = 0;
    rgb.copy(raw, off + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hex2rgb(h) {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

// ── 画布 ──
function makeCanvas(W, H) {
  const buf = Buffer.alloc(W * H * 3);
  let seed = 20260929;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

  function blend(x, y, rgb, a) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3;
    buf[i] = buf[i] * (1 - a) + rgb[0] * a;
    buf[i + 1] = buf[i + 1] * (1 - a) + rgb[1] * a;
    buf[i + 2] = buf[i + 2] * (1 - a) + rgb[2] * a;
  }

  function fillRect(x0, y0, x1, y1, rgb) {
    const xa = Math.max(0, Math.round(x0)); const xb = Math.min(W, Math.round(x1));
    const ya = Math.max(0, Math.round(y0)); const yb = Math.min(H, Math.round(y1));
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) {
      const i = (y * W + x) * 3;
      buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2];
    }
  }

  function fillCircle(cx, cy, r, rgb) {
    const xa = Math.max(0, Math.floor(cx - r)); const xb = Math.min(W, Math.ceil(cx + r));
    const ya = Math.max(0, Math.floor(cy - r)); const yb = Math.min(H, Math.ceil(cy + r));
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) {
      const dx = x + 0.5 - cx; const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) {
        const i = (y * W + x) * 3;
        buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2];
      }
    }
  }

  function fillRing(cx, cy, r, wd, rgb) {
    const ro = r + wd / 2; const ri = r - wd / 2;
    const xa = Math.max(0, Math.floor(cx - ro)); const xb = Math.min(W, Math.ceil(cx + ro));
    const ya = Math.max(0, Math.floor(cy - ro)); const yb = Math.min(H, Math.ceil(cy + ro));
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) {
      const d2 = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
      if (d2 <= ro * ro && d2 >= ri * ri) {
        const i = (y * W + x) * 3;
        buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2];
      }
    }
  }

  // 扫描线多边形填充（奇偶规则）
  function fillPoly(pts, rgb) {
    let minY = Infinity; let maxY = -Infinity;
    pts.forEach(([px, py]) => { if (py < minY) minY = py; if (py > maxY) maxY = py; });
    const ya = Math.max(0, Math.floor(minY)); const yb = Math.min(H, Math.ceil(maxY));
    for (let y = ya; y < yb; y++) {
      const yc = y + 0.5;
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[(i + 1) % pts.length];
        if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) {
          xs.push(x1 + (yc - y1) / (y2 - y1) * (x2 - x1));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        fillRect(Math.round(xs[k]), y, Math.round(xs[k + 1]), y + 1, rgb);
      }
    }
  }

  function grain(density, alpha, rgb) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (rnd() < density) blend(x, y, rgb, alpha);
    }
  }

  return { buf, fillRect, fillCircle, fillRing, fillPoly, grain };
}

// ── 回放指令 ──
function render(ops, W, H) {
  const c = makeCanvas(W, H);
  ops.forEach((o) => {
    const rgb = hex2rgb(o.color);
    if (o.op === 'bg') c.fillRect(0, 0, W, H, rgb);
    else if (o.op === 'rect') c.fillRect(o.x * W, o.y * H, (o.x + o.w) * W, (o.y + o.h) * H, rgb);
    else if (o.op === 'circle') c.fillCircle(o.cx * W, o.cy * H, o.r * W, rgb);
    else if (o.op === 'ring') c.fillRing(o.cx * W, o.cy * H, o.r * W, o.w * W, rgb);
    else if (o.op === 'poly') c.fillPoly(o.pts.map(([x, y]) => [x * W, y * H]), rgb);
    else if (o.op === 'grain') c.grain(o.density, o.alpha, rgb);
  });
  return encodePNG(W, H, c.buf);
}

module.exports = { render, encodePNG, makeCanvas, hex2rgb };

// CLI
if (require.main === module) {
  const M = require('../data/matches.js');
  const DSL = require('./poster-dsl.js');
  const Wr = require('./brief-write.js');
  const [id, nar, v, w, h, out] = process.argv.slice(2);
  const m = M.find((x) => x.id === id) || M.filter((x) => x.status === 'finished')[0];
  const narrative = nar || Wr.narrative(m).key;
  const p = DSL.posterOps(m, narrative, Number(v || 0));
  const W = Number(w || 600); const H = Number(h || 800);
  const png = render(p.ops, W, H);
  const f = out || 'data/brief/images/poster-' + narrative + '-' + (v || 0) + '.png';
  fs.mkdirSync(require('path').dirname(f), { recursive: true });
  fs.writeFileSync(f, png);
  console.log('叙事 ' + narrative + ' 变体 ' + (v || 0) + '　配色 ' + p.palette.primary + '/' + p.palette.secondary);
  console.log('输出 ' + f + '　' + W + 'x' + H + '　' + Math.round(png.length / 1024) + ' KB');
}
