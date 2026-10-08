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
 * 尺寸：500 × 400（5:4，微信分享卡推荐比例）。
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

/**
 * 底图（模板图）路径 —— 留空则用代码画的纯色底。
 *
 * 底图由外部设计/生成后放进 images/ 目录，这里填上路径即可生效，
 * 绘制时先贴图、再往上写动态文字（队名/比分/日期/日报标题）。
 * ⚠️ 底图自带品牌元素时，代码就不再重复画水印。
 */
const BG = {
  match: '/images/share-match.jpg',
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

/**
 * 比赛卡：赛事 + 对阵双方 + 比分
 * opt: { comp, stage, home, away, homeScore, awayScore, dateText, timeText, statusText, accent }
 */
function drawMatch(ctx, opt) {
  const o = opt || {}
  const accent = o.accent || '#2E7CF6'
  const hasScore = typeof o.homeScore === 'number' && typeof o.awayScore === 'number'
  const score = hasScore ? `${o.homeScore} - ${o.awayScore}` : 'VS'

  // 背景：有底图就贴图，没有才用代码画的纯色 + 蒙层
  if (o.bg) {
    ctx.drawImage(o.bg, 0, 0, W, H)
  } else {
    ctx.fillStyle = accent
    ctx.fillRect(0, 0, W, H)
    // 半透明深色蒙层，保证白字可读
    ctx.fillStyle = 'rgba(10,14,24,0.42)'
    ctx.fillRect(0, 0, W, H)
  }

  // 顶部：赛事名 · 阶段
  ctx.fillStyle = 'rgba(255,255,255,0.86)'
  ctx.font = font(17)
  ctx.textBaseline = 'middle'
  ctx.fillText(ellipsis(ctx, o.comp || '', 300), 28, 40)
  if (o.stage) {
    ctx.fillStyle = 'rgba(255,255,255,0.62)'
    ctx.font = font(15)
    ctx.textAlign = 'right'
    ctx.fillText(ellipsis(ctx, o.stage, 200), W - 28, 40)
    ctx.textAlign = 'left'
  }

  // 分隔线（装饰元素：底图自带设计时就不画，免得压在图上）
  if (!o.bg) {
    ctx.fillStyle = 'rgba(255,255,255,0.18)'
    ctx.fillRect(28, 62, W - 56, 1)
  }

  // 中部：主队 / 比分 / 客队
  ctx.textAlign = 'center'
  ctx.fillStyle = '#ffffff'
  ctx.font = font(30, 600)
  ctx.fillText(ellipsis(ctx, o.home || '', 420), W / 2, 140)

  ctx.font = font(hasScore ? 62 : 46, 700)
  ctx.fillText(score, W / 2, 218)

  ctx.font = font(30, 600)
  ctx.fillText(ellipsis(ctx, o.away || '', 420), W / 2, 296)
  ctx.textAlign = 'left'

  // 底部：日期 + 时间 + 状态
  const bottom = [o.dateText, o.timeText].filter(Boolean).join(' ')
  ctx.fillStyle = 'rgba(255,255,255,0.72)'
  ctx.font = font(16)
  ctx.textBaseline = 'alphabetic'
  if (bottom) ctx.fillText(ellipsis(ctx, bottom, 260), 28, H - 22)
  if (o.statusText) {
    ctx.textAlign = 'right'
    ctx.fillText(ellipsis(ctx, o.statusText, 150), W - 150, H - 22)
    ctx.textAlign = 'left'
  }
  // 品牌放右下角，和状态错开
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
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

  // 日期
  ctx.fillStyle = MUTED
  ctx.font = font(22)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(ellipsis(ctx, o.dateText || '', 380), W / 2, 92)

  // 主标题：闪现早/晚报
  ctx.fillStyle = INK
  ctx.font = font(50, 700)
  ctx.fillText(`闪现${o.kindZh || '日报'}`, W / 2, 168)

  // 副标题（头条标题或前瞻导语），最多两行。
  // 2026-09-30 用户定：换行后左对齐（整块仍水平居中），第二行不再居中
  if (o.sub) {
    ctx.fillStyle = '#5A6272'
    ctx.font = font(19)
    ctx.textAlign = 'left'
    const lines = wrap(ctx, o.sub, 400, 2)
    lines.forEach((ln, i) => {
      ctx.fillText(ln, W / 2 - 200, 236 + i * 30)
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
    ctx.textAlign = 'left'
    ctx.fillStyle = MUTED
    ctx.font = font(18)
    ctx.fillText(String(r.time || ''), 32, y)
    ctx.fillStyle = INK
    ctx.font = font(21, 600)
    ctx.fillText(ellipsis(ctx, `${r.home || ''} VS ${r.away || ''}`, 292), 96, y)
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
 * @param {string} kind   'match' | 'brief' | 'rank' | 'player' | 'team' | 'schedule'
 * @param {object} opt    绘制参数
 */
function build(page, id, kind, opt) {
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

      canvas.width = W * dpr
      canvas.height = H * dpr
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, W, H)

      // 🔴 只有 match / brief 配了底图；四张新卡是代码画的，bgSrc 为空 → bg = null
      const bgSrc = kind === 'brief' ? BG.brief : kind === 'match' ? BG.match : ''
      loadBg(canvas, bgSrc).then((bg) => {
        const full = Object.assign({}, opt, { bg: bg || null })
        if (kind === 'brief') drawBrief(ctx, full)
        else if (kind === 'rank') drawRank(ctx, full)
        else if (kind === 'player') drawPlayer(ctx, full)
        else if (kind === 'team') drawTeam(ctx, full)
        else if (kind === 'schedule') drawSchedule(ctx, full)
        else drawMatch(ctx, full)
        wx.canvasToTempFilePath({
          canvas,
          x: 0, y: 0, width: W, height: H,
          destWidth: W * dpr, destHeight: H * dpr,
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
  drawBrief,
  drawRank,
  drawPlayer,
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
