// 图片体检：零依赖 PNG 解码 + 像素统计
// 用途：① 检测是否有强制水印（看底部区域是否出现异常的非背景像素聚集）
//      ② 输出 ASCII 缩略图，让人在不打开图片的情况下确认画面构图
// 用法：node tools/img-inspect.js <png路径> [ascii列数]

const fs = require('fs');
const zlib = require('zlib');

function readPNG(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8;
  let w = 0; let h = 0; let bitDepth = 0; let colorType = 0;
  const idat = [];
  let plte = null; let trns = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('仅支持 8bit，实际 ' + bitDepth);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('不支持的 colorType ' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);

  // PNG filter 逐行还原
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = raw.slice(rp, rp + stride); rp += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }

  // 统一转 RGB
  function px(x, y) {
    const i = y * stride + x * bpp;
    if (colorType === 2) return [out[i], out[i + 1], out[i + 2]];
    if (colorType === 6) return [out[i], out[i + 1], out[i + 2]];
    if (colorType === 0) { const g = out[i]; return [g, g, g]; }
    if (colorType === 4) { const g = out[i]; return [g, g, g]; }
    if (colorType === 3) {
      const idx = out[i];
      const r = plte[idx * 3]; const g = plte[idx * 3 + 1]; const b = plte[idx * 3 + 2];
      return [r, g, b];
    }
    return [0, 0, 0];
  }
  return { w, h, px, colorType };
}

const file = process.argv[2];
const cols = Number(process.argv[3] || 64);
const img = readPNG(file);
const { w, h, px } = img;

console.log('文件：' + file);
console.log('尺寸：' + w + ' x ' + h + '　colorType=' + img.colorType);

// ── 1. 主色统计 ──
const hist = new Map();
for (let y = 0; y < h; y += 3) {
  for (let x = 0; x < w; x += 3) {
    const [r, g, b] = px(x, y);
    const k = (r >> 4) + ',' + (g >> 4) + ',' + (b >> 4);
    hist.set(k, (hist.get(k) || 0) + 1);
  }
}
const total = Array.from(hist.values()).reduce((a, b) => a + b, 0);
console.log('\n主色（前 6）：');
Array.from(hist.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6).forEach(([k, c]) => {
  const [r, g, b] = k.split(',').map((n) => parseInt(n, 10) * 16 + 8);
  console.log('  rgb(' + String(r).padStart(3) + ',' + String(g).padStart(3) + ',' + String(b).padStart(3) + ')  ' + (c / total * 100).toFixed(1) + '%');
});

// ── 2. 水印检测：逐行看「颜色熵」，背景应该是大面积纯色 ──
// 水印是有细密笔画的文字，会让局部颜色数突增
function rowEntropy(y) {
  const set = new Set();
  for (let x = 0; x < w; x++) {
    const [r, g, b] = px(x, y);
    set.add((r >> 3) + ',' + (g >> 3) + ',' + (b >> 3));
  }
  return set.size;
}
console.log('\n逐区块颜色数（找水印：右下/底部若突然变复杂，多半有字）');
const step = Math.floor(h / 12);
for (let i = 0; i < 12; i++) {
  const ys = i * step;
  const outs = [];
  for (let k = 0; k < 4; k++) outs.push(rowEntropy(Math.min(h - 1, ys + k * Math.floor(step / 4))));
  const avg = Math.round(outs.reduce((a, b) => a + b, 0) / outs.length);
  const bar = '#'.repeat(Math.min(60, Math.round(avg / 2)));
  console.log('  y=' + String(ys).padStart(4) + '~' + String(Math.min(h - 1, ys + step)).padStart(4) + '  ' + String(avg).padStart(3) + '  ' + bar);
}

// ── 2b. 高精度四角检测：水印会让某个角落的复杂度远高于其他角落 ──
function cornerEntropy(x0, y0, x1, y1) {
  const set = new Set();
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const [r, g, b] = px(x, y);
    set.add((r >> 3) + ',' + (g >> 3) + ',' + (b >> 3));
  }
  return set.size;
}
if (w >= 480 && h >= 240) {
  const regions = [
    ['左上', 0, 0], ['右上', w - 240, 0],
    ['左下', 0, h - 120], ['右下', w - 240, h - 120],
  ];
  console.log('\n四角 240x120 区域颜色数（水印会让某个角落明显复杂）：');
  const vals = regions.map(([name, x0, y0]) => {
    const v = cornerEntropy(x0, y0, x0 + 240, y0 + 120);
    console.log('  ' + name + '　' + String(v).padStart(4));
    return v;
  });
  const byName = {};
  regions.forEach(([name, x0, y0], i) => { byName[name] = vals[i]; });
  const mx = Math.max(...vals); const mn = Math.min(...vals);
  console.log('  最复杂 ' + mx + ' / 最简单 ' + mn + '，全图比值 ' + (mx / mn).toFixed(2));
  // ⚠️ 关键判据是「同侧上下比」，不是四个角一起比：
  // risograph 画面本身经常一半有油墨颗粒、一半是平涂，
  // 四角一起比会把「构图不对称」误报成水印（实测踩过：左 311/338 vs 右 102/128）。
  // 水印只出现在某一个角（通常是右下），所以要拿右下跟**右上**比。
  const r = byName['右下'] / Math.max(1, byName['右上']);
  const l = byName['左下'] / Math.max(1, byName['左上']);
  console.log('  右下/右上 = ' + r.toFixed(2) + '　左下/左上 = ' + l.toFixed(2)
    + (Math.max(r, l) > 2.5 ? '　⚠️ 疑似水印' : '　✓ 同侧上下复杂度接近，未见水印'));
}

// ── 3. 底部 96px 的左右对比：水印通常在右下 ──
const START = h - 96;
function regionEntropy(x0, x1, y0, y1) {
  const set = new Set();
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    const [r, g, b] = px(x, y);
    set.add((r >> 3) + ',' + (g >> 3) + ',' + (b >> 3));
  }
  return set.size;
}
if (w >= 256 && h >= 128) {
  console.log('\n底部 96px 分区颜色数（右下角若远高于左侧，就是水印）：');
  const halves = ['左下', '中下', '右下'];
  const vals = [];
  for (let i = 0; i < 3; i++) {
    const x0 = Math.floor(w * i / 3); const x1 = Math.floor(w * (i + 1) / 3);
    const v = regionEntropy(x0, x1, START, h);
    vals.push(v);
    console.log('  ' + halves[i] + '：' + String(v).padStart(4));
  }
  const mx = Math.max(...vals); const mn = Math.min(...vals);
  console.log('  → 右下/左下 比值 ' + (vals[2] / Math.max(1, vals[0])).toFixed(2)
    + (vals[2] > vals[0] * 1.5 ? '　⚠️ 右下明显复杂，疑似水印' : '　（未见明显右下水印）'));
}

// ── 4. ASCII 缩略图：确认构图 ──
console.log('\nASCII 缩略图（亮度：暗=@ 亮=空格）：');
const rows = Math.max(1, Math.round(cols * (h / w) * 0.5));
const chars = '@%#*+=-:. ';
for (let ry = 0; ry < rows; ry++) {
  let line = '';
  for (let rx = 0; rx < cols; rx++) {
    const x = Math.floor(rx * w / cols);
    const y = Math.floor(ry * h / rows);
    const [r, g, b] = px(x, y);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    line += chars[Math.min(chars.length - 1, Math.floor(lum * chars.length))];
  }
  console.log('  ' + line);
}
