const favorites = require('./utils/favorites')
const { isReady, getSession } = require('./utils/cloud')
const data = require('./utils/data')

App({
  globalData: {
    /** 已关注的 match_id 集合 */
    favIds: [],
    /** 云登录状态：unknown | signed-in | signed-out | unavailable */
    authState: 'unknown',
    userLabel: '',
    cloudReady: isReady(),
  },

  onLaunch() {
    // 尽早拉一次云端赛程缓存，让首个页面更可能直接展示最新比分（无需重新发布）
    data.refresh()
    this.refreshAuth()
  },

  /** 检查会话并加载关注列表，页面可在 onShow 里调用 */
  async refreshAuth() {
    if (!isReady()) {
      this.globalData.authState = 'unavailable'
      this.globalData.favIds = []
      return this.globalData.authState
    }
    const { data: session, error } = await getSession()
    if (error || !session) {
      this.globalData.authState = 'signed-out'
      this.globalData.userLabel = ''
      this.globalData.favIds = []
      return this.globalData.authState
    }
    this.globalData.authState = 'signed-in'
    await this.refreshFavorites()
    return this.globalData.authState
  },

  async refreshFavorites() {
    const res = await favorites.favoritesByMatch()
    if (res.data) this.globalData.favIds = Object.keys(res.data)
    return this.globalData.favIds
  },

  isFav(matchId) {
    return this.globalData.favIds.indexOf(matchId) > -1
  },
})
