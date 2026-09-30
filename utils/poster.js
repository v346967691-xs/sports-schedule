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

/**
 * 在页面隐藏 canvas 上画好分享图，返回 tempFilePath（失败返回空串）
 * @param {object} page   页面 this（用于 SelectorQuery）
 * @param {string} id     canvas 的 id
 * @param {string} kind   'match' | 'brief'
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

      const bgSrc = kind === 'brief' ? BG.brief : BG.match
      loadBg(canvas, bgSrc).then((bg) => {
        const full = Object.assign({}, opt, { bg: bg || null })
        if (kind === 'brief') drawBrief(ctx, full)
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

module.exports = { build, drawMatch, drawBrief, wrap, ellipsis, loadBg, BG, W, H }
