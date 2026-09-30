/**
 * 页面分享配置
 * ============================================================
 * 为什么必须有它：
 *   微信小程序右上角的「转发给朋友」「复制链接」「分享到朋友圈」**默认全是灰的**——
 *   只有当页面里实现了 onShareAppMessage / onShareTimeline，按钮才会亮起来。
 *   而「复制链接」又依赖「转发给朋友」：后者不可用，前者也一定灰。
 *   （2026-09-30 踩到：想在公众号图文里挂小程序卡片，复制链接点不了，根因就在这里。）
 *
 * 每个页面都要单独挂，没有全局开关，所以统一从这里取，避免各页面文案跑偏。
 */

const DEFAULT_TITLE = '闪现赛程助手 · 足球 / NBA / 电竞赛程比分'
const DEFAULT_PATH = '/pages/index/index'

/** 分享给朋友（同时点亮「复制链接」） */
function message(opt) {
  const o = opt || {}
  const out = {
    title: o.title || DEFAULT_TITLE,
    path: o.path || DEFAULT_PATH,
  }
  if (o.imageUrl) out.imageUrl = o.imageUrl
  return out
}

/** 分享到朋友圈 */
function timeline(opt) {
  const o = opt || {}
  const out = { title: o.title || DEFAULT_TITLE }
  // 朋友圈分享不能用 path，用 query 带参数（key=value 形式，不带 ?）
  if (o.query) out.query = o.query
  if (o.imageUrl) out.imageUrl = o.imageUrl
  return out
}

module.exports = { message, timeline, DEFAULT_TITLE, DEFAULT_PATH }
