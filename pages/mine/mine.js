const data = require('../../utils/data')
const fmt = require('../../utils/format')
const view = require('../../utils/view')
const favorites = require('../../utils/favorites')
const follows = require('../../utils/team-follows')
const reminders = require('../../utils/reminders')
const briefApi = require('../../utils/brief')
const { appInstance } = require('../../utils/app-instance')

Page({
  data: {
    authState: 'unknown',
    cloudReady: true,
    logging: false,
    favs: [],
    teams: [],
    teamMatches: [],
    reminderList: [],
    remindCount: 0,
    stat: { matches: 0, upcoming: 0, comps: 0, range: '' },
    loadingFavs: false,
    brief: null,
  },

  async onLoad() {
    const app = appInstance()
    this.setData({ cloudReady: app.globalData.cloudReady, authState: app.globalData.authState })
    this.buildStat()
    this.buildReminders()
    this.loadBrief()
    data.refresh().then((r) => { if (r.updated) this.buildStat() })
  },

  async onShow() {
    const app = appInstance()
    if (this.data.authState === 'unknown') {
      await app.refreshAuth()
      this.setData({ authState: app.globalData.authState, cloudReady: app.globalData.cloudReady })
    }
    await this.loadFavs()
    // 登录后先把云端关注球队并回本地，再渲染，换设备也能看到
    if (appInstance().globalData.authState === 'signed-in') {
      await follows.pullFromCloud()
      await reminders.pullFromCloud()
    }
    this.buildTeams()
    this.buildReminders()
    data.refresh().then((r) => { if (r.updated) { this.buildTeams(); this.buildStat() } })
  },

  /** 日报入口：只取最新一期的一句话摘要，取不到就保持默认文案 */
  async loadBrief() {
    try {
      const res = await briefApi.fetchBriefs(1)
      const one = (res.list || [])[0]
      const tip = briefApi.teaser(one)
      if (!tip) return
      this.setData({ brief: { tip, kindZh: one.kindZh, pubText: briefApi.fmtPubAt(one.pubAt) } })
    } catch (err) {
      console.warn('[赛程助手] 日报摘要读取失败', err)
    }
  },

  goBrief() {
    wx.navigateTo({ url: '/pages/brief/brief' })
  },

  /** 我设的开赛提醒（只列最近 3 条，完整管理在「我的开赛提醒」页） */
  buildReminders() {
    const now = Date.now()
    const list = reminders
      .all()
      .map((r) => {
        const ts = r.startAt ? Date.parse(r.startAt) : NaN
        const started = Number.isFinite(ts) && ts <= now
        return {
          matchId: r.matchId,
          compName: data.compOf(r.comp).name,
          accent: data.compOf(r.comp).accent,
          home: r.home,
          away: r.away,
          when: started ? '已开赛' : (r.startAt ? fmt.countdownText(r.startAt) : ''),
          startAt: r.startAt || '',
        }
      })
      .sort((a, b) => (a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : 0))

    this.setData({ reminderList: list.slice(0, 3), remindCount: list.length })
  },

  goReminders() {
    wx.navigateTo({ url: '/pages/reminders/reminders' })
  },

  /** 点提醒 → 跳到那场比赛的详情页（可在那里取消提醒） */
  onReminderTap(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}` })
  },

  /** 我关注的球队 + 他们的待开赛比赛 */
  buildTeams() {
    const list = follows.all()
    const teams = list.map((t) => Object.assign({}, t, {
      k: follows.key(t.comp, t.id),
      compName: data.compOf(t.comp).name,
      accent: data.compOf(t.comp).accent,
    }))
    const matches = list.length
      ? data.query({ teams: follows.asFilter(), status: ['upcoming', 'live'] }).slice(0, 8)
      : []
    this.setData({
      teams,
      teamMatches: view.decorateList(matches, { compOf: data.compOf }),
    })
  },

  buildStat() {
    const all = data.matches()
    const comps = Object.keys(data.compMap()).length
    const range = `${data.meta.range.from} ~ ${data.meta.range.to}`
    this.setData({ stat: { matches: all.length, upcoming: all.filter((m) => m.status === 'upcoming').length, comps, range } })
  },

  async loadFavs() {
    const app = appInstance()
    if (app.globalData.authState !== 'signed-in') {
      this.setData({ favs: [], loadingFavs: false })
      return
    }
    this.setData({ loadingFavs: true })
    const res = await favorites.list()
    const map = data.compMap()
    const favs = (res.data || []).map((row) => ({
      id: row.id,
      matchId: row.match_id,
      compName: (map[row.comp] || {}).name || row.comp,
      accent: (map[row.comp] || {}).accent || '#6B7280',
      title: `${row.home} vs ${row.away}`,
      time: `${fmt.dayLabel(row.date)} ${row.time}`,
      past: row.date < fmt.todayStr(),
    }))
    this.setData({ favs, loadingFavs: false })
    if (res.error) wx.showToast({ title: res.error.message, icon: 'none' })
  },

  async onLogin() {
    const app = appInstance()
    if (this.data.logging) return
    if (!app.globalData.cloudReady) {
      wx.showModal({
        title: '云服务未就绪',
        content: '登录需要云服务支持。请在微信开发者工具中执行「构建 npm」后重新预览。',
        showCancel: false,
      })
      return
    }
    this.setData({ logging: true })
    const cloud = require('../../utils/cloud')
    const { error } = await cloud.signInWithWechat()
    this.setData({ logging: false })
    if (error) {
      wx.showToast({ title: error.message || '登录失败，请重试', icon: 'none' })
      return
    }
    await app.refreshAuth()
    await this.loadFavs()
    this.setData({ authState: app.globalData.authState })
    wx.showToast({ title: '登录成功', icon: 'success' })
  },

  async onLogout() {
    const app = appInstance()
    const res = await require('../../utils/cloud').signOut()
    if (res && res.error) {
      wx.showToast({ title: res.error.message, icon: 'none' })
      return
    }
    app.globalData.authState = 'signed-out'
    app.globalData.favIds = []
    this.setData({ authState: 'signed-out', favs: [] })
  },

  onFavTap(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}` })
  },

  goTeams() {
    wx.navigateTo({ url: '/pages/teams/teams' })
  },

  /** 点关注的球队 → 跳赛程页只看这支队的比赛 */
  onTeamTap(e) {
    const idx = e.currentTarget.dataset.index
    const team = this.data.teams[idx]
    if (!team) return
    appInstance().globalData.pendingTeam = { comp: team.comp, id: team.id, display: team.display }
    wx.switchTab({ url: '/pages/schedule/schedule' })
  },

  onTeamMatchTap(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}` })
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' })
  },
})
