/** 我的 MVP 长图：LOL/KPL 按系列赛，足球/篮球按本场真实出场数据。 */
const WIDTH = 750
const BLUE = '#14235c', GOLD = '#c5a263', INK = '#192747', MUTED = '#758096'

function layout(ctx, o, draw) {
  const rect = (x, y, w, h, color) => {
    if (draw) { ctx.fillStyle = color; ctx.fillRect(x, y, w, h) }
  }
  const text = (value, x, y, size, color, weight, width, paint) => {
    ctx.font = `${weight || 400} ${size}px "Microsoft YaHei", "PingFang SC", sans-serif`
    const lines = []; let line = ''
    for (const ch of String(value == null ? '' : value)) {
      if (ch === '\n' || (line && ctx.measureText(line + ch).width > (width || 666))) {
        lines.push(line); line = ch === '\n' ? '' : ch
      } else line += ch
    }
    if (line) lines.push(line)
    if (draw && paint !== false) {
      ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'top'
      lines.forEach((s, i) => ctx.fillText(s, x, y + i * size * 1.5))
    }
    return lines.length * size * 1.5
  }
  // 长赛事名也完整换行，头部高度随内容扩展。
  const compHeight = text(o.comp || 'LOL', 42, 122, 24, GOLD, 600, 666, false)
  const dateText = `${o.dateText || ''} ${o.timeText || ''} · 北京时间`
  const dateY = 132 + compHeight
  const dateHeight = text(dateText, 42, dateY, 20, '#bac5de', 400, 666, false)
  const headerHeight = Math.max(225, dateY + dateHeight + 30)
  rect(0, 0, WIDTH, headerHeight, BLUE)
  text('闪现 · 我的MVP', 42, 42, 45, '#ffffff', 700)
  text(o.comp || 'LOL', 42, 122, 24, GOLD, 600)
  text(dateText, 42, dateY, 20, '#bac5de')
  let y = headerHeight + 36
  const hasScore = typeof o.homeScore === 'number' && typeof o.awayScore === 'number'
  y += text(`${o.home || ''}  ${hasScore ? `${o.homeScore} : ${o.awayScore}` : 'VS'}  ${o.away || ''}`, 42, y, 30, INK, 700) + 26
  const series = !o.kind || o.kind === 'kpl'
  y += text(series ? '我选 TA 为本场系列赛 MVP' : '我选 TA 为本场 MVP', 42, y, 24, MUTED) + 14
  y += text(o.name, 42, y, 54, BLUE, 800) + 6
  y += text(`${o.team || ''} · ${o.role || '选手'}`, 42, y, 26, MUTED) + 30
  rect(42, y, 666, 58, '#eef1f8'); rect(42, y, 5, 58, GOLD)
  text(series ? '系列赛累计数据' : '本场表现', 60, y + 12, 28, BLUE, 700); y += 84
  if (!o.kind) {
    y += text(`${o.k} / ${o.d} / ${o.a}`, 60, y, 56, INK, 700, 630) + 2
    y += text('击杀 / 死亡 / 助攻', 60, y, 23, MUTED) + 25
  }
  const metrics = o.kind ? (o.stats || []).map(s => [s.label, s.value])
    : [['出场', `${o.games} 局`], ['补刀', String(o.cs)], ['经济', String(o.gold)]]
  for (let i = 0; i < metrics.length; i += 3) {
    const row = metrics.slice(i, i + 3)
    const heights = row.map(([label, value]) => 34 + text(label, 0, 0, 22, MUTED, 400, 182, false)
      + text(value, 0, 0, 30, BLUE, 700, 182, false))
    const height = Math.max(112, ...heights)
    row.forEach(([label, value], index) => {
      const x = 42 + index * 226
      rect(x, y, 214, height, '#eef1f8')
      const labelHeight = text(label, x + 16, y + 14, 22, MUTED, 400, 182)
      text(value, x + 16, y + 24 + labelHeight, 30, BLUE, 700, 182)
    })
    y += height + 28
  }
  const champions = (o.champions || []).map(c => c.name || c.id).filter(Boolean)
  if (champions.length || !o.kind) {
    rect(42, y, 666, 58, '#eef1f8'); rect(42, y, 5, 58, GOLD)
    text('本场使用英雄', 60, y + 12, 28, BLUE, 700); y += 80
    y += text(champions.join(' / ') || '暂无英雄信息', 60, y, 27, INK, 600, 630) + 30
  }
  y += text(`TA 获得 ${o.votes || 0} 票 · 本场共 ${o.totalVotes || 0} 票`, 42, y, 28, BLUE, 700) + 10
  y += text(`${o.note || (series ? '数据为该选手实际出场的各局累计。' : '数据为该球员本场实际出场表现。')}票数截至本次页面更新。`, 42, y, 20, MUTED) + 30
  rect(0, y, WIDTH, 230, BLUE)
  if (draw && o.qr) ctx.drawImage(o.qr, 42, y + 34, 162, 162)
  text('长按识别 · 闪现赛程助手', 236, y + 58, 27, '#ffffff', 700, 472)
  text('看赛程、比分与选手表现\n为你心中的 MVP 投票', 236, y + 111, 22, '#bac5de', 400, 472)
  return Math.ceil(y + 230)
}

const measure = (ctx, o) => layout(ctx, o, false)
function draw(ctx, o) {
  const height = measure(ctx, o)
  ctx.fillStyle = '#fafbfe'; ctx.fillRect(0, 0, WIDTH, height)
  layout(ctx, o, true)
  return height
}
module.exports = { WIDTH, measure, draw }
