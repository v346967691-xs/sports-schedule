/**
 * 分享卡图（小程序端 canvas 2d 实时绘制）
 * ============================================================
 * 用途：比赛详情页 / 日报页转发给好友或群时，卡片上带一张**定制图**：
 *   - 比赛 → 对阵双方 + 比分
 *   - 日报 → 「X月X日 闪现早/晚报」
 *
 * 为什么现画而不是预生成：
 *   云端只有 Auth/Database/Storage/LLM，**没有云函数**，没法在服务端出图；
 *   比分和期次又是随时变的，预生成必然过期。端上 canvas 画完即传，零存储、零流量。
 *
 * 好友卡尺寸：500 × 400；MVP 长图宽 750，高度随本场数据自适应。
 *
 * ⚠️ onShareAppMessage 是同步返回，canvas 绘制却是异步的 ——
 *    所以必须在数据就绪后**提前**画好存进 data，分享时直接取 tempFilePath。
 *    见 pages/detail/detail.js 与 pages/brief/brief.js 里的 buildShareImage()。
 */

const W = 500
const H = 400
const PAPER = '#f2ede2'
const INK = '#1f2430'
const MUTED = '#8A93A6'
const mvpLong = require('./lol-mvp-poster')

/**
 * 底图（模板图）路径 —— 留空则用代码画的纯色底。
 *
 * 底图由外部设计/生成后放进 images/ 目录，这里填上路径即可生效，
 * 绘制时先贴图、再往上写动态文字（队名/比分/日期/日报标题）。
 * ⚠️ 底图自带品牌元素时，代码就不再重复画水印。
 */
const BG = {
  match: '/images/share-match-football.jpg',
  matches: {
    football: '/images/share-match-football.jpg',
    basketball: '/images/share-match-basketball.jpg',
    esports: '/images/share-match-esports.jpg',
    tennis: '/images/share-match-tennis.jpg',
  },
  brief: '/images/share-brief.jpg',
}

/** 载入底图；失败或没配置都返回 null，绘制时自动退回纯色底，不崩 */
function loadBg(canvas, src) {
  return new Promise((resolve) => {
    if (!src || !canvas || !canvas.createImage) return resolve(null)
    try {
      const img = canvas.createImage()
      img.onload = () => resolve(img)
      img.onerror = () => resolve(null)
      img.src = src
    } catch (e) {
      resolve(null)
    }
  })
}

/** 截到指定宽度内，超出加省略号 */
function ellipsis(ctx, text, maxWidth) {
  const s = String(text || '')
  if (ctx.measureText(s).width <= maxWidth) return s
  let out = s
  while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) {
    out = out.slice(0, -1)
  }
  return out + '…'
}

/** 按宽度折行，最多 maxLines 行，最后一行加省略号 */
function wrap(ctx, text, maxWidth, maxLines) {
  const s = String(text || '').trim()
  if (!s) return []
  const lines = []
  let cur = ''
  for (const ch of s) {
    if (ctx.measureText(cur + ch).width > maxWidth && cur) {
      lines.push(cur)
      cur = ch
      if (lines.length === maxLines) break
    } else {
      cur += ch
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur)
  if (lines.length === maxLines) {
    const joined = lines.join('')
    if (joined !== s) lines[maxLines - 1] = ellipsis(ctx, lines[maxLines - 1] + s.slice(joined.length), maxWidth)
  }
  return lines
}

function font(size, weight) {
  return `${weight || 400} ${size}px -apple-system, "PingFang SC", "Helvetica Neue", sans-serif`
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** 底部品牌水印 */
function brand(ctx, color) {
  ctx.fillStyle = color
  ctx.font = font(15)
  ctx.textAlign = 'right'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText('闪现赛程助手', W - 24, H - 22)
  ctx.textAlign = 'left'
}

/** 明确月日，避免转发后「今天/明天」失效。输入已经是北京时间。 */
function matchDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''))
  if (m) return `${Number(m[2])}月${Number(m[3])}日`
  return /今天|明天|昨天|后天|前天/.test(String(date || '')) ? '' : String(date || '')
}

/** 两行均衡折行，英文 ID 是完整单元；中文优先在城市、姓名分界处断开。 */
function matchNameLines(ctx, value, width, cat) {
  const text = String(value || '待定').trim() || '待定'
  if (ctx.measureText(text).width <= width) return [text]
  const tokens = text.match(/[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*|[^A-Za-z0-9]/g) || []
  const city = /^(俄克拉荷马城|明尼苏达|洛杉矶|金州|新奥尔良|波特兰|圣安东尼奥|费城|布鲁克林|萨克拉门托|克利夫兰|孟菲斯|密尔沃基|夏洛特|达拉斯|波士顿|丹佛|底特律|休斯敦|印第安纳|迈阿密|纽约|奥兰多|菲尼克斯|多伦多|犹他|华盛顿|芝加哥|亚特兰大|杭州|苏州|重庆|深圳|成都|广州|武汉|北京|上海)/.exec(text)
  let best = null
  for (let i = 1; i < tokens.length; i++) {
    const left = tokens.slice(0, i).join('').trim()
    const right = tokens.slice(i).join('').trim()
    if (!left || !right || /^[·.]/.test(right)) continue
    // NBA 城市名完整保留；必要时继续缩字，避免拆成「俄克拉荷 / 马城雷霆」。
    if (cat === 'basketball' && city && ctx.measureText(city[0]).width <= width && left !== city[0]) continue
    const lw = ctx.measureText(left).width
    const rw = ctx.measureText(right).width
    if (lw > width || rw > width) continue
    let penalty = Math.abs(lw - rw)
    if (cat === 'tennis' && left.endsWith('·')) penalty -= width
    if (cat !== 'tennis' && city && left === city[0]) penalty -= width
    if (!best || penalty < best.penalty) best = { lines: [left, right], penalty }
  }
  return best ? best.lines : null
}

function matchNames(ctx, home, away, width, cat) {
  // 单行略缩字；超过这个范围后用两行，双方始终统一字号。
  for (let size = 34; size >= 28; size--) {
    ctx.font = font(size, 700)
    if ([home, away].every(s => ctx.measureText(s || '待定').width <= width)) {
      return { size, home: [home || '待定'], away: [away || '待定'] }
    }
  }
  for (let size = 30; size >= 25; size--) {
    ctx.font = font(size, 700)
    const h = matchNameLines(ctx, home, width, cat)
    const a = matchNameLines(ctx, away, width, cat)
    if (h && a) return { size, home: h, away: a }
  }
  // 极端超长单词无法完整放下时才截断；不把电竞 ID 拆成两段。
  return { size: 25, home: [ellipsis(ctx, home || '待定', width)], away: [ellipsis(ctx, away || '待定', width)] }
}

/** 四角信息完整单行展示；右侧锚定末字，向左延伸，过长时双方同比缩字。 */
function matchCornerRow(ctx, left, right, y) {
  left = String(left || '')
  right = String(right || '')
  ctx.font = font(20, 700)
  const total = ctx.measureText(left).width + ctx.measureText(right).width
  const available = W - 56 - (left && right ? 18 : 0)
  if (total > available) ctx.font = font(20 * available / total, 700)
  ctx.textAlign = 'right'
  if (right) ctx.fillText(right, W - 28, y)
  ctx.textAlign = 'left'
  if (left) ctx.fillText(left, 28, y)
}

/** 比赛分享卡：横向对阵，小号 VS、大号浅金比分、明确日期。 */
function drawMatch(ctx, opt) {
  const o = opt || {}
  const hasScore = o.status !== 'upcoming' && Number.isFinite(o.homeScore) && Number.isFinite(o.awayScore)
  const score = hasScore ? `${o.homeScore}-${o.awayScore}` : 'VS'
  // 三位数采用紧凑排版，仍大于队名字号，给两侧长队名留出空间。
  const scoreSize = hasScore ? (Math.max(String(o.homeScore).length, String(o.awayScore).length) >= 3 ? 40 : 56) : 20
  if (o.bg) ctx.drawImage(o.bg, 0, 0, W, H)
  else {
    ctx.fillStyle = '#182e49'
    ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = 'rgba(199,124,64,0.24)'
    ctx.fillRect(0, H - 8, W, 8)
  }
  // 蒙层压住局部灯光，让四角和队名始终清楚。
  ctx.fillStyle = 'rgba(8,20,36,0.18)'
  ctx.fillRect(0, 0, W, H)
  // 边缘渐变承托四角信息，中央保持通透，不增加图片资源。
  ;[[0, 100], [H, H - 100]].forEach(([edge, inner]) => {
    const shade = ctx.createLinearGradient(0, edge, 0, inner)
    shade.addColorStop(0, 'rgba(5,17,35,0.82)')
    shade.addColorStop(0.45, 'rgba(5,17,35,0.54)')
    shade.addColorStop(1, 'rgba(5,17,35,0)')
    ctx.fillStyle = shade
    ctx.fillRect(0, Math.min(edge, inner), W, 100)
  })
  ctx.fillStyle = '#ffffff'
  ctx.shadowColor = 'rgba(0,0,0,0.65)'
  ctx.shadowBlur = 3
  ctx.shadowOffsetY = 1
  ctx.textBaseline = 'middle'
  matchCornerRow(ctx, o.comp, o.stage, 34)

  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.shadowOffsetY = 0
  ctx.font = font(scoreSize, hasScore ? 800 : 600)
  const gap = Math.max(64, ctx.measureText(score).width + 24)
  const columnWidth = (W - 56 - gap) / 2
  const names = matchNames(ctx, o.home, o.away, columnWidth, o.cat)
  ctx.textAlign = 'center'
  ctx.font = font(names.size, 700)
  const lineHeight = names.size * 1.28
  const centerY = 192
  ;[[names.home, 28 + columnWidth / 2], [names.away, W - 28 - columnWidth / 2]].forEach(([lines, x]) => {
    lines.forEach((line, i) => ctx.fillText(line, x, centerY + (i - (lines.length - 1) / 2) * lineHeight))
  })
  ctx.font = font(scoreSize, hasScore ? 800 : 600)
  ctx.fillStyle = hasScore ? '#ffe0a3' : '#ffffff'
  ctx.fillText(score, W / 2, centerY)

  ctx.fillStyle = '#ffffff'
  ctx.shadowColor = 'rgba(0,0,0,0.65)'
  ctx.shadowBlur = 3
  ctx.shadowOffsetY = 1
  const bottom = [matchDate(o.date || o.dateText), o.timeText].filter(Boolean).join(' ')
  matchCornerRow(ctx, bottom, o.statusText, H - 28)
  ctx.shadowColor = 'transparent'
  ctx.shadowBlur = 0
  ctx.shadowOffsetY = 0
  ctx.textBaseline = 'alphabetic'
}

/**
 * 日报卡：X月X日 + 闪现早/晚报
 * opt: { dateText (如 9月30日), kindZh (早报/晚报), sub (副标题/摘要), accent }
 */
function drawBrief(ctx, opt) {
  const o = opt || {}
  const accent = o.accent || '#C8952A'

  if (o.bg) {
    ctx.drawImage(o.bg, 0, 0, W, H)
  } else {
    ctx.fillStyle = PAPER
    ctx.fillRect(0, 0, W, H)
    // 顶部色条
    ctx.fillStyle = accent
    ctx.fillRect(0, 0, W, 10)
  }

  // 标题上提，日期以小号粗体放在标题右侧，整组居中。
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.font = font(50, 700)
  const title = `闪现${o.kindZh || '日报'}`
  const titleWidth = ctx.measureText(title).width
  ctx.font = font(18, 700)
  const date = ellipsis(ctx, o.dateText || '', 140)
  const dateWidth = date ? ctx.measureText(date).width + 16 : 0
  const titleX = (W - titleWidth - dateWidth) / 2
  ctx.fillStyle = INK
  ctx.font = font(50, 700)
  ctx.fillText(title, titleX, 136)
  if (date) {
    ctx.fillStyle = MUTED
    ctx.font = font(18, 700)
    ctx.fillText(date, titleX + titleWidth + 16, 142)
  }

  // 单行居中；多行以最长行确定居中的文字块，块内左对齐。
  if (o.sub) {
    ctx.fillStyle = '#5A6272'
    ctx.font = font(24, 700)
    ctx.textAlign = 'center'
    const lines = wrap(ctx, o.sub, 400, 2)
    const blockWidth = Math.max(...lines.map(line => ctx.measureText(line).width), 0)
    if (lines.length > 1) ctx.textAlign = 'left'
    lines.forEach((ln, i) => {
      ctx.fillText(ln, lines.length > 1 ? (W - blockWidth) / 2 : W / 2, 210 + i * 34)
    })
  }

  // 底部小徽标：仅在无底图的兜底模式画（2026-09-30 用户定：底图模式下整个去掉，
  // 底部波浪区放"晚报"两字反而干扰画面）
  if (!o.bg) {
    ctx.fillStyle = accent
    roundRect(ctx, W / 2 - 46, H - 78, 92, 32, 16)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.font = font(16, 600)
    ctx.fillText(o.kindZh || '日报', W / 2, H - 62)
  }

  ctx.textAlign = 'left'
  // 底图自带品牌元素，代码就不重复画
  if (!o.bg) brand(ctx, MUTED)
}

/* ════════════════════════════════════════════════════════════
 * 2026-10-08 新增四张卡：榜单 / 球员 / 球队 / 赛程
 *
 * 🔴 **这四张一律「代码画」，不配底图** —— 包体积余量只有 331KB，
 *    而一张底图 ~110KB（现有 share-match 110KB / share-brief 122KB），
 *    4 张就是 440KB 直接超包。代码绘制零图片成本，视觉上朴素一些但能落地。
 *    以后要给某一张配底图，先算清楚余量，并且记得文字配色要跟着换。
 *
 * 共用纸底 PAPER + 顶部 accent 色条，跟 drawBrief 的无底图兜底模式一致，
 * 四张卡摆在一起是一个系列。
 * ════════════════════════════════════════════════════════════ */

/** 纸底 + 顶部色条 */
function paper(ctx, accent) {
  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = accent
  ctx.fillRect(0, 0, W, 10)
}

/** 分隔线 */
function rule(ctx, y) {
  ctx.fillStyle = 'rgba(31,36,48,0.10)'
  ctx.fillRect(32, y, W - 64, 1)
}

/** 近况色块：胜绿 / 平灰 / 负红（足球 App 通行口径；与 standings 的 zone 同色系） */
const FORM_COLOR = { W: '#2F7A52', D: '#8A93A6', L: '#C33A3A' }
const FORM_TEXT = { W: '胜', D: '平', L: '负' }

/** 有底图就贴图，否则纸底（新卡默认走纸底） */
function base(ctx, o, accent) {
  if (o.bg) ctx.drawImage(o.bg, 0, 0, W, H)
  else paper(ctx, accent)
}

/**
 * 榜单卡：赛事 + 榜名 + Top5（前三高亮）
 * opt: { comp, boardName, rows: [{ pos, name, val }], accent }
 */
function drawRank(ctx, o) {
  const accent = o.accent || '#2E7CF6'
  base(ctx, o, accent)

  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillStyle = MUTED
  ctx.font = font(18)
  ctx.fillText(ellipsis(ctx, o.comp || '', 400), 32, 54)

  ctx.fillStyle = INK
  ctx.font = font(36, 700)
  ctx.fillText(ellipsis(ctx, o.boardName || '排行榜', 380), 32, 102)

  rule(ctx, 134)

  const rows = (o.rows || []).slice(0, 5)
  rows.forEach((r, i) => {
    const y = 172 + i * 42
    const top = i < 3 // 前三加粗 + 数值用 accent 色
    ctx.textAlign = 'left'
    ctx.fillStyle = top ? INK : '#5A6272'
    ctx.font = font(top ? 20 : 19, top ? 600 : 400)
    ctx.fillText(String(r.pos || i + 1), 32, y)
    ctx.fillText(ellipsis(ctx, r.name || '', 296), 78, y)
    ctx.textAlign = 'right'
    ctx.fillStyle = top ? accent : MUTED
    ctx.font = font(top ? 22 : 20, top ? 700 : 500)
    ctx.fillText(String(r.val == null ? '' : r.val), W - 32, y)
  })

  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  brand(ctx, MUTED)
}

/**
 * 球员卡：中文名（回落英文）+ 球队 + 3 项关键数据 + 榜内位次
 * opt: { comp, name, en, team, rankText, stats: [{ k, v }], accent }
 */
function drawPlayer(ctx, o) {
  const accent = o.accent || '#2E7CF6'
  base(ctx, o, accent)

  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillStyle = MUTED
  ctx.font = font(18)
  ctx.fillText(ellipsis(ctx, o.comp || '', 300), 32, 54)
  if (o.rankText) {
    ctx.textAlign = 'right'
    ctx.fillStyle = accent
    ctx.font = font(18, 600)
    ctx.fillText(ellipsis(ctx, o.rankText, 150), W - 32, 54)
    ctx.textAlign = 'left'
  }

  ctx.fillStyle = INK
  ctx.font = font(40, 700)
  ctx.fillText(ellipsis(ctx, o.name || '', 400), 32, 108)

  const sub = [o.en, o.team].filter(Boolean).join(' · ')
  if (sub) {
    ctx.fillStyle = '#5A6272'
    ctx.font = font(18)
    ctx.fillText(ellipsis(ctx, sub, 420), 32, 146)
  }

  rule(ctx, 178)

  const stats = (o.stats || []).slice(0, 3)
  const colW = (W - 64) / Math.max(stats.length, 1)
  stats.forEach((s, i) => {
    const cx = 32 + colW * i + colW / 2
    ctx.textAlign = 'center'
    ctx.fillStyle = INK
    ctx.font = font(34, 700)
    ctx.fillText(ellipsis(ctx, String(s.v == null ? '-' : s.v), colW - 16), cx, 234)
    ctx.fillStyle = MUTED
    ctx.font = font(16)
    ctx.fillText(ellipsis(ctx, s.k || '', colW - 12), cx, 270)
  })

  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  brand(ctx, MUTED)
}

/** LOL 系列赛 MVP 分享卡：投票选手 + 跨局累计 K/D/A、补刀与经济。 */
function drawLolMvp(ctx, o) {
  const accent = o.accent || '#B99433'
  base(ctx, o, accent)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillStyle = MUTED
  ctx.font = font(18)
  ctx.fillText(ellipsis(ctx, o.comp || 'LOL', 340), 32, 52)
  ctx.textAlign = 'right'
  ctx.fillStyle = accent
  ctx.font = font(18, 700)
  ctx.fillText('系列赛 MVP', W - 32, 52)

  ctx.textAlign = 'left'
  ctx.fillStyle = INK
  ctx.font = font(40, 700)
  ctx.fillText(ellipsis(ctx, o.name || '', 420), 32, 112)
  ctx.fillStyle = '#5A6272'
  ctx.font = font(19)
  ctx.fillText(ellipsis(ctx, o.team || '', 420), 32, 150)
  const champions = (o.champions || []).map(c => c.name).filter(Boolean).join(' / ')
  if (champions) {
    ctx.fillStyle = MUTED
    ctx.font = font(17)
    ctx.fillText(ellipsis(ctx, `使用英雄：${champions}`, 420), 32, 184)
  }

  rule(ctx, 214)
  ctx.textAlign = 'center'
  ctx.fillStyle = INK
  ctx.font = font(42, 700)
  ctx.fillText(`${o.k || 0} / ${o.d || 0} / ${o.a || 0}`, W / 2, 264)
  ctx.fillStyle = MUTED
  ctx.font = font(17)
  ctx.fillText(`K / D / A · ${o.games || 0} 局累计`, W / 2, 294)
  ctx.textAlign = 'left'
  ctx.fillStyle = '#5A6272'
  ctx.font = font(18, 600)
  ctx.fillText(`补刀 ${o.cs || 0}`, 72, 344)
  ctx.textAlign = 'right'
  ctx.fillText(`经济 ${o.gold || 0}`, W - 72, 344)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  brand(ctx, MUTED)
}

/** 篮球、足球和 KPL 的 MVP 好友卡，字段全部来自本场候选人的统计。 */
function drawMatchMvp(ctx, o) {
  base(ctx, o, '#B99433')
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left'
  ctx.font = font(18); ctx.fillStyle = MUTED
  ctx.fillText(ellipsis(ctx, o.comp || '', 340), 32, 52)
  ctx.font = font(18, 700); ctx.fillStyle = '#B99433'; ctx.textAlign = 'right'
  ctx.fillText('我的MVP', W - 32, 52)
  ctx.textAlign = 'left'; ctx.fillStyle = INK; ctx.font = font(40, 700)
  ctx.fillText(ellipsis(ctx, o.name || '', 436), 32, 115)
  ctx.fillStyle = '#5A6272'; ctx.font = font(20)
  ctx.fillText(ellipsis(ctx, `${o.team || ''} · ${o.role || '选手'}`, 436), 32, 157)
  rule(ctx, 194)
  ctx.fillStyle = INK; ctx.font = font(22, 600)
  wrap(ctx, (o.stats || []).slice(0, 6).map(s => `${s.label} ${s.value}`).join(' · '), 436, 4)
    .forEach((line, i) => ctx.fillText(line, 32, 230 + i * 34))
  brand(ctx, MUTED)
}

/**
 * 球队卡：队名 + 排名/积分 + 近 5 场胜平负色块 + 下一场
 * opt: { comp, name, sub, form: ['W','D','L'…], nextText, accent }
 */
function drawTeam(ctx, o) {
  const accent = o.accent || '#2E7CF6'
  base(ctx, o, accent)

  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillStyle = MUTED
  ctx.font = font(18)
  ctx.fillText(ellipsis(ctx, o.comp || '', 400), 32, 54)

  ctx.fillStyle = INK
  ctx.font = font(38, 700)
  ctx.fillText(ellipsis(ctx, o.name || '', 400), 32, 100)

  if (o.sub) {
    ctx.fillStyle = '#5A6272'
    ctx.font = font(19)
    ctx.fillText(ellipsis(ctx, o.sub, 420), 32, 136)
  }

  const form = (o.form || []).slice(0, 5)
  if (form.length) {
    const size = 46
    const gap = 12
    form.forEach((f, i) => {
      const x = 32 + i * (size + gap)
      roundRect(ctx, x, 172, size, size, 10)
      ctx.fillStyle = FORM_COLOR[f] || FORM_COLOR.D
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.font = font(19, 600)
      ctx.textAlign = 'center'
      ctx.fillText(FORM_TEXT[f] || String(f), x + size / 2, 172 + size / 2)
    })
    ctx.textAlign = 'left'
  }

  if (o.nextText) {
    rule(ctx, 252)
    ctx.fillStyle = MUTED
    ctx.font = font(17)
    ctx.fillText('下一场', 32, 284)
    ctx.fillStyle = INK
    ctx.font = font(20, 600)
    ctx.fillText(ellipsis(ctx, o.nextText, 420), 32, 316)
  }

  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  brand(ctx, MUTED)
}

/**
 * 赛程卡：日期 + 标题 + 最多 4 场（时间 + 对阵 + 赛事）
 * opt: { dateText, title, rows: [{ time, home, away, comp }], accent }
 */
function drawSchedule(ctx, o) {
  const accent = o.accent || '#2E7CF6'
  base(ctx, o, accent)

  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillStyle = MUTED
  ctx.font = font(18)
  ctx.fillText(ellipsis(ctx, o.dateText || '', 300), 32, 54)

  ctx.fillStyle = INK
  ctx.font = font(34, 700)
  ctx.fillText(ellipsis(ctx, o.title || '今日赛程', 380), 32, 100)

  rule(ctx, 132)

  const rows = (o.rows || []).slice(0, 4)
  rows.forEach((r, i) => {
    const y = 168 + i * 46
    // 🔴 时间是赛程卡里**最重要的信息**（2026-10-08 用户提：不该比同行的队名更弱）
    //    → 时间用 22px / 700 粗体 + 主色，队名降到 20px / 500。
    //    以前时间是 18px 常规 + MUTED 灰，队名反而是 21px/600 深色，主次完全颠倒。
    ctx.textAlign = 'left'
    ctx.fillStyle = INK
    ctx.font = font(22, 700)
    ctx.fillText(String(r.time || ''), 32, y)
    ctx.fillStyle = INK
    ctx.font = font(20, 500)
    ctx.fillText(ellipsis(ctx, `${r.home || ''} VS ${r.away || ''}`, 284), 104, y)
    if (r.comp) {
      ctx.textAlign = 'right'
      ctx.fillStyle = MUTED
      ctx.font = font(16)
      ctx.fillText(ellipsis(ctx, r.comp, 110), W - 32, y)
      ctx.textAlign = 'left'
    }
  })

  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  brand(ctx, MUTED)
}

/**
 * 在页面隐藏 canvas 上画好分享图，返回 tempFilePath（失败返回空串）
 * @param {object} page   页面 this（用于 SelectorQuery）
 * @param {string} id     canvas 的 id
 * @param {string} kind   'match' | 'brief' | 'rank' | 'player' | 'team' | 'schedule' | 'lol-mvp' | 'match-mvp' | 'lol-mvp-long' | 'match-mvp-long'
 * @param {object} opt    绘制参数
 */
let buildQueue = Promise.resolve()

function build(page, id, kind, opt) {
  const current = buildQueue.then(() => buildCanvas(page, id, kind, opt))
  buildQueue = current.catch(() => '')
  return current
}

function buildCanvas(page, id, kind, opt) {
  opt = require('./nba-names').payload(opt)
  return new Promise((resolve) => {
    if (!wx.createSelectorQuery) return resolve('')
    const q = wx.createSelectorQuery().in(page)
    q.select('#' + id).fields({ node: true, size: true }).exec((res) => {
      const info = res && res[0]
      if (!info || !info.node) return resolve('')
      const canvas = info.node
      const ctx = canvas.getContext && canvas.getContext('2d')
      if (!ctx) return resolve('')
      let dpr = 2
      try {
        const sys = wx.getWindowInfo ? wx.getWindowInfo() : (wx.getSystemInfoSync ? wx.getSystemInfoSync() : null)
        if (sys && sys.pixelRatio) dpr = sys.pixelRatio
      } catch (e) { /* 拿不到就用 2 */ }
      if (dpr > 3) dpr = 3

      const isMvpLong = kind === 'lol-mvp-long' || kind === 'match-mvp-long'
      const width = isMvpLong ? mvpLong.WIDTH : W
      const height = isMvpLong ? mvpLong.measure(ctx, opt) : H
      if (isMvpLong) dpr = Math.min(dpr, 2)
      canvas.width = width * dpr
      canvas.height = height * dpr
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, width, height)

      // 比赛按类别选择底图；其他卡片保持原有绘制方式。
      const bgSrc = isMvpLong ? '/images/worlds-miniprogram.jpg' : kind === 'brief' ? BG.brief : kind === 'match' ? (BG.matches[opt && opt.cat] || BG.match) : ''
      loadBg(canvas, bgSrc).then((bg) => {
        if (isMvpLong && !bg) return resolve('')
        const full = Object.assign({}, opt, { bg: bg || null })
        if (isMvpLong) mvpLong.draw(ctx, Object.assign({}, opt, { qr: bg }))
        else if (kind === 'brief') drawBrief(ctx, full)
        else if (kind === 'rank') drawRank(ctx, full)
        else if (kind === 'player') drawPlayer(ctx, full)
        else if (kind === 'lol-mvp') drawLolMvp(ctx, full)
        else if (kind === 'match-mvp') drawMatchMvp(ctx, full)
        else if (kind === 'team') drawTeam(ctx, full)
        else if (kind === 'schedule') drawSchedule(ctx, full)
        else drawMatch(ctx, full)
        wx.canvasToTempFilePath({
          canvas,
          x: 0, y: 0, width, height,
          destWidth: width * dpr, destHeight: height * dpr,
          fileType: 'jpg',
          quality: 0.92,
          success: (r) => resolve(r.tempFilePath || ''),
          fail: () => resolve(''),
        })
      })
    })
  })
}

module.exports = {
  build,
  drawMatch,
  matchNames,
  matchDate,
  drawBrief,
  drawRank,
  drawPlayer,
  drawLolMvp,
  drawMatchMvp,
  drawTeam,
  drawSchedule,
  wrap,
  ellipsis,
  loadBg,
  BG,
  W,
  H,
  FORM_COLOR,
  FORM_TEXT,
}
