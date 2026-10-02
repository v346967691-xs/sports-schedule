const share = require('../../utils/share')
const poster = require('../../utils/poster')
const data = require('../../utils/data')
const view = require('../../utils/view')
const fmt = require('../../utils/format')
const favorites = require('../../utils/favorites')
const reminders = require('../../utils/reminders')
const { appInstance } = require('../../utils/app-instance')

Page({
  data: {
    match: null,
    comp: null,
    rows: [],
    isFav: false,
    favBusy: false,
    isRemind: false,
    authState: 'unknown',
    shareImage: '',      // 转发卡图（离屏 canvas 画好后存这里）
  },

  onLoad(query) {
    const app = appInstance()
    const id = query && query.id ? decodeURIComponent(query.id) : ''
    const raw = data.findMatch(id)
    if (!raw) {
      wx.showToast({ title: '找不到这场比赛', icon: 'none' })
      return
    }
    const match = view.decorate.call({ compOf: data.compOf }, raw)
    const comp = data.compOf(match.comp)
    const rows = [
      { label: '开赛时间', value: `${fmt.dayLabel(match.date)} ${match.time}（北京时间）` },
      { label: '比赛状态', value: match.status === 'upcoming' ? `未开始 · ${fmt.countdownText(match.start)}` : match.status === 'live' ? '进行中' : (match.statusText || '已结束') },
      { label: '所属阶段', value: match.stage || comp.full },
    ]
    if (match._bo) rows.push({ label: '赛制', value: match._bo + ' 淘汰制' })
    if (match.venue) rows.push({ label: '比赛场地', value: match.venue })
    if (match.broadcast && match.broadcast.length) rows.push({ label: '转播', value: match.broadcast.join(' / ') })
    rows.push({ label: '赛事', value: comp.full })

    this.setData({
      match,
      comp,
      rows,
      isFav: app.isFav(match.id),
      isRemind: reminders.has(match.id),
      authState: app.globalData.authState,
    }, () => this.buildShareImage())
  },

  /**
   * 转发卡图：画「对阵双方 + 比分」。
   * 必须提前画 —— onShareAppMessage 是同步的，等分享时再画来不及。
   */
  async buildShareImage() {
    const m = this.data.match
    const comp = this.data.comp || {}
    if (!m) return
    const img = await poster.build(this, 'share-canvas', 'match', {
      comp: comp.full || comp.name || '',
      stage: m.stage || '',
      home: m.home.zhName || m.home.name,
      away: m.away.zhName || m.away.name,
      homeScore: m.home.score,
      awayScore: m.away.score,
      dateText: fmt.dayLabel(m.date),
      timeText: m.time,
      statusText: m.status === 'upcoming' ? '未开始' : (m.statusText || '已结束'),
      accent: comp.accent || '#2E7CF6',
    })
    if (img) this.setData({ shareImage: img })
  },

  onShow() {
    const app = appInstance()
    if (!this.data.match) return
    this.setData({
      isFav: app.isFav(this.data.match.id),
      isRemind: reminders.has(this.data.match.id),
      authState: app.globalData.authState,
    })
  },

  /** 开赛前 30 分钟提醒：本地优先存储，登录后自动同步到云端 */
  onRemindTap() {
    const match = this.data.match
    if (!match) return
    if (this.data.isRemind) {
      reminders.remove(match.id)
      wx.showToast({ title: '已取消开赛提醒', icon: 'none' })
    } else {
      const res = reminders.add(match)
      wx.showToast({
        title: res.already ? '已经设过提醒了' : '已设置，开赛前 30 分钟提醒你',
        icon: 'none',
      })
    }
    this.setData({ isRemind: reminders.has(match.id) })
  },

  goReminders() {
    wx.navigateTo({ url: '/pages/reminders/reminders' })
  },

  async onFavTap() {
    const app = appInstance()
    if (this.data.favBusy) return
    this.setData({ favBusy: true })

    if (app.globalData.authState !== 'signed-in') {
      await app.refreshAuth()
      this.setData({ authState: app.globalData.authState })
    }
    if (app.globalData.authState === 'unavailable') {
      wx.showModal({
        title: '云服务未就绪',
        content: '关注功能需要云服务支持。请在微信开发者工具中执行「构建 npm」后重新预览。',
        showCancel: false,
      })
      this.setData({ favBusy: false })
      return
    }
    if (app.globalData.authState !== 'signed-in') {
      wx.showModal({
        title: '需要登录',
        content: '登录后才能把比赛收藏到「我的」，换设备也不会丢失。要现在去登录吗？',
        confirmText: '去登录',
        cancelText: '稍后',
        success: (res) => {
          if (res.confirm) wx.switchTab({ url: '/pages/mine/mine' })
        },
      })
      this.setData({ favBusy: false })
      return
    }

    const match = this.data.match
    if (this.data.isFav) {
      const res = await favorites.remove(match.id)
      if (res.error) wx.showToast({ title: res.error.message, icon: 'none' })
      await app.refreshFavorites()
      this.setData({ isFav: app.isFav(match.id) })
    } else {
      const res = await favorites.add(match)
      if (res.error) {
        wx.showToast({ title: res.error.message, icon: 'none' })
      } else {
        wx.showToast({ title: '已加入关注', icon: 'success' })
      }
      await app.refreshFavorites()
      this.setData({ isFav: app.isFav(match.id) })
    }
    this.setData({ favBusy: false })
  },

  onCompTap() {
    const app = appInstance()
    const comp = this.data.comp
    if (!comp) return
    app.globalData.pendingComp = comp.key
    wx.switchTab({ url: '/pages/schedule/schedule' })
  },
  onShareAppMessage() {
    const m = this.data.match
    if (!m) return share.message()
    const h = m.home.zhName || m.home.name
    const a = m.away.zhName || m.away.name
    const hasScore = typeof m.home.score === 'number' && typeof m.away.score === 'number'
    // 有比分就把结果写进标题，比「赛程与比分」更值得点；没比分用 VS（与卡图一致）
    const tail = hasScore ? `${m.home.score}-${m.away.score}` : (m.status === 'live' ? '进行中' : 'VS')
    return share.message({
      title: `${h} ${tail} ${a}`,
      path: `/pages/detail/detail?id=${encodeURIComponent(m.id)}`,
      imageUrl: this.data.shareImage,
    })
  },

  onShareTimeline() {
    const m = this.data.match
    if (!m) return share.timeline()
    const h = m.home.zhName || m.home.name
    const a = m.away.zhName || m.away.name
    const hasScore = typeof m.home.score === 'number' && typeof m.away.score === 'number'
    const tail = hasScore ? `${m.home.score}-${m.away.score}` : 'VS'
    return share.timeline({
      title: `${h} ${tail} ${a}`,
      imageUrl: this.data.shareImage,
    })
  },
})
