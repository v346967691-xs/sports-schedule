const share = require('../../utils/share')
const data = require('../../utils/data')
const fmt = require('../../utils/format')
const reminders = require('../../utils/reminders')
const { appInstance } = require('../../utils/app-instance')

Page({
  data: {
    list: [],
    count: 0,
    lead: reminders.LEAD_MINUTES,
  },

  onLoad() {
    this.build()
  },

  async onShow() {
    // 登录后先把云端提醒并回本地，换设备设的提醒也能看到
    if (appInstance().globalData.authState === 'signed-in') {
      await reminders.pullFromCloud()
    }
    this.build()
  },

  build() {
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
          time: r.time,
          dateLabel: fmt.dayLabel(r.date),
          when: started ? '已开赛' : (r.startAt ? fmt.countdownText(r.startAt) : ''),
          started,
          startAt: r.startAt || '',
        }
      })
      .sort((a, b) => (a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : 0))
    this.setData({ list, count: list.length })
  },

  onRemove(e) {
    const id = e.currentTarget.dataset.id
    reminders.remove(id)
    this.build()
    wx.showToast({ title: '已取消提醒', icon: 'none' })
  },

  /** 已开赛的提醒会越积越多，一键清掉 */
  onClearStarted() {
    const started = this.data.list.filter((r) => r.started)
    if (!started.length) {
      wx.showToast({ title: '没有已开赛的提醒', icon: 'none' })
      return
    }
    const self = this
    wx.showModal({
      title: '清理已开赛提醒',
      content: `将取消 ${started.length} 条已开赛的提醒，确定吗？`,
      confirmText: '清理',
      cancelText: '取消',
      success(res) {
        if (!res.confirm) return
        started.forEach((r) => reminders.remove(r.matchId))
        self.build()
        wx.showToast({ title: '已清理', icon: 'none' })
      },
    })
  },

  goSchedule() {
    wx.switchTab({ url: '/pages/schedule/schedule' })
  },
  onShareAppMessage() {
    return share.message({ title: '闪现赛程助手 · 开赛提醒', path: '/pages/index/index' })
  },

  onShareTimeline() {
    return share.timeline({ title: '闪现赛程助手 · 开赛提醒' })
  },
})
