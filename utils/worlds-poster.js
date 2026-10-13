/** S 赛晨报长图。页面与 Node 设计样张复用相同排版，不依赖远程绘图服务。 */
const WIDTH = 750
const BLUE = '#14235c', GOLD = '#c5a263', INK = '#192747', MUTED = '#758096'
function font(ctx, size, weight) { ctx.font = `${weight || 400} ${size}px "Microsoft YaHei", "PingFang SC", sans-serif` }
function lines(ctx, text, width) {
  const out = []; let line = ''
  for (const ch of String(text || '')) {
    if (ch === '\n' || (line && ctx.measureText(line + ch).width > width)) { out.push(line); line = ch === '\n' ? '' : ch }
    else line += ch
  }
  if (line) out.push(line)
  return out.length ? out : ['']
}
function layout(ctx, report, draw, qr) {
  const r = report
  const rect = (x, y, w, h, color) => { if (draw) { ctx.fillStyle = color; ctx.fillRect(x, y, w, h) } }
  const text = (s, x, y, size, color, weight, width, align) => {
    font(ctx, size, weight)
    const wrapped = lines(ctx, s, width || 650)
    if (draw) {
      ctx.fillStyle = color; ctx.textAlign = align || 'left'; ctx.textBaseline = 'top'
      wrapped.forEach((line, i) => ctx.fillText(line, x, y + i * size * 1.55))
    }
    return wrapped.length * size * 1.55
  }
  rect(0, 0, WIDTH, 240, BLUE); rect(42, 46, 46, 4, GOLD)
  text('WORLDS 2026', 104, 32, 21, GOLD, 700)
  text('闪现 · S 赛晨报', 42, 82, 48, '#ffffff', 700)
  text(`${r.date.replace(/-/g, '.')}  /  ${r.phase}`, 42, 165, 21, '#bac5de', 400, 650)
  let y = 280
  y += text(r.title, 42, y, 42, INK, 700, 666) + 12
  y += text(r.lead, 42, y, 24, MUTED, 400, 666) + 25
  y += 8
  const section = (title, items, kind) => {
    if (!items.length) return
    rect(42, y, 666, 58, '#eef1f8')
    rect(42, y, 5, 58, GOLD)
    text(title, 60, y + 14, 27, BLUE, 700, 634)
    y += 74
    items.forEach(item => {
      const top = y
      if (kind === 'qualification') {
        y += text(`${item.record}  ·  ${item.text}`, 58, y + 14, 23, BLUE, 700, 634) + 12
        y += text(item.teams, 58, y, 23, MUTED, 400, 634) + 24
      } else {
        const title = `${item.home}  ${kind === 'next' || kind === 'waiting' ? 'VS' : item.score}  ${item.away}`
        y += text(title, 58, y + 14, 28, INK, 700, 634) + 13
        const detail = kind === 'next' || kind === 'waiting' ? item.time : `${item.stage} · ${item.statusText}`
        y += text(kind === 'waiting' ? `${detail} · 等待官方确认` : detail, 58, y, 20, MUTED, 400, 634) + 24
      }
      rect(42, y - 1, 666, 1, '#e4e8f0')
      if (y < top + 96) y = top + 96
    })
    y += 30
  }
  section('LPL 昨夜表现', r.lpl, 'result')
  section(r.lpl.length ? '其他已结束比赛' : '完整赛果', r.otherFinished || r.finished, 'result')
  section('比赛仍在进行', r.live, 'result')
  section('等待官方确认战况', r.waiting, 'waiting')
  section('瑞士轮晋级形势', r.qualification, 'qualification')
  section('下一比赛日 · 北京时间', r.next, 'next')
  if (!r.finished.length && !r.live.length && !r.waiting.length && !r.next.length) {
    y += text('官方对阵公布后，这里将呈现昨夜战况与下一比赛日安排。', 42, y, 25, MUTED, 400, 666) + 30
  }
  const stamp = new Date(Date.parse(r.updatedAt) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ')
  y += text(`整理于 ${stamp} 北京时间\n${r.note}`, 42, y, 18, MUTED, 400, 666) + 24
  rect(0, y, WIDTH, 255, BLUE)
  if (draw && qr) ctx.drawImage(qr, 48, y + 43, 168, 168)
  text('长按识别 · 闪现赛程助手', 246, y + 70, 27, '#ffffff', 700, 455)
  text('进入首页的 S 赛专区\n看实时比分、单局对位与赛后 MVP', 246, y + 122, 20, '#bac5de', 400, 455)
  return Math.ceil(y + 255)
}
function measure(ctx, report) { return layout(ctx, report, false, null) }
function draw(ctx, report, qr) {
  const height = measure(ctx, report)
  ctx.fillStyle = '#fafbfe'; ctx.fillRect(0, 0, WIDTH, height)
  layout(ctx, report, true, qr)
  return height
}
async function build(page, report) {
  const canvas = await new Promise(resolve => wx.createSelectorQuery().in(page).select('#worlds-long-canvas').fields({ node: true }).exec(res => resolve(res && res[0] && res[0].node)))
  if (!canvas) throw new Error('长图画布尚未就绪，请重试')
  const ctx = canvas.getContext('2d')
  const height = measure(ctx, report)
  const scale = height > 3900 ? 1 : 2
  if (height > 7800) throw new Error('本期内容较长，请分享小程序页面查看完整晨报')
  canvas.width = WIDTH * scale; canvas.height = height * scale
  ctx.scale(scale, scale)
  const qr = await new Promise((resolve, reject) => {
    const img = canvas.createImage()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('小程序码读取失败，请重试'))
    img.src = '/images/worlds-miniprogram.jpg'
  })
  draw(ctx, report, qr)
  return new Promise((resolve, reject) => wx.canvasToTempFilePath({
    canvas, x: 0, y: 0, width: WIDTH, height,
    destWidth: WIDTH * scale, destHeight: height * scale, fileType: 'jpg', quality: .95,
    success: res => resolve(res.tempFilePath), fail: () => reject(new Error('长图生成失败，请重试')),
  }))
}
module.exports = { WIDTH, measure, draw, build }
