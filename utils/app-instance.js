/**
 * 延迟获取 App 实例
 *
 * 页面模块顶层不要写 `const app = getApp()`。
 * 小程序（尤其体验版 / 正式版）在页面 JS 被求值时不保证 App() 已经注册完成，
 * 这时 getApp() 返回 undefined，后面一访问 app.globalData 就抛错 ——
 * 页面模块加载中断，屏幕上就是一整片空白，而且开发者工具里往往复现不出来。
 *
 * 这里统一包一层：拿不到就返回一个结构一致的空壳，页面照常渲染，
 * 只是云相关能力降级，不会白屏。
 */

const EMPTY = {
  globalData: {
    favIds: [],
    pendingComp: '',
    authState: 'unknown',
    userLabel: '',
    cloudReady: false,
  },
  isFav() {
    return false
  },
  async refreshAuth() {
    return 'unavailable'
  },
  async refreshFavorites() {
    return []
  },
}

function appInstance() {
  try {
    const inst = typeof getApp === 'function' ? getApp() : null
    if (inst && inst.globalData) return inst
  } catch (err) {
    console.error('[赛程助手] getApp() 调用失败', err)
  }
  return EMPTY
}

module.exports = { appInstance }
