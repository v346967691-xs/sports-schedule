const data = require('../../utils/data')
const worlds = require('../../utils/worlds')
const model = require('./swiss-model')
const share = require('../../utils/share')
const SNAPSHOT_MS = 15 * 60000

Page({
  data: { rounds: [], activeRound: 1, scrollTarget: '', published: 0, qualified: [], eliminated: [], unplaced: [], focusedId: '', updatedAt: '' },
  onLoad(query) {
    this.focusedId = query && query.id || ''
    const round = Number(query && query.round)
    this.selectedRound = Number.isInteger(round) && round >= 1 && round <= 5 ? round : null
    this.setData({ focusedId: this.focusedId })
  },
  onShow() {
    this.visible = true
    this.build()
    this.refresh()
    if (!this.timer) this.timer = setInterval(() => this.tick(), 60000)
  },
  onHide() { this.visible = false; if (this.timer) clearInterval(this.timer); this.timer = null },
  onUnload() { this.onHide() },
  async refresh() {
    if (this.refreshing) return this.refreshing
    this.snapshotReadAt = Date.now()
    this.refreshing = Promise.all([data.refresh(), data.loadWorldsArchive(), data.refreshLive()]).then(([, archive]) => {
      this.archive = archive
      if (this.visible) this.build()
    }).catch(() => { if (this.visible) this.build() }).finally(() => { this.refreshing = null })
    return this.refreshing
  },
  tick() {
    if (!this.visible) return
    if (Date.now() - this.snapshotReadAt >= SNAPSHOT_MS) { this.refresh(); return }
    const live = this.matches && this.matches.some(m => /瑞士|swiss/i.test(m.stage || '') && data.needsLivePoll(m))
    if (live) data.refreshLive().then(() => { if (this.visible) this.build() })
  },
  build() {
    // Current data wins over archive; never let a historical copy restore an old score.
    this.matches = [...new Map([...(this.archive || []), ...data.query({ comps: ['worlds'], from: worlds.FROM, to: worlds.TO })].map(m => [m.id, m])).values()]
    const result = model.build(this.matches)
    const initial = result.roundByMatch[this.focusedId] || result.activeRound
    const activeRound = this.selectedRound || initial
    const stamp = Date.parse(data.meta.worldsRefreshedAt || data.generatedAt())
    const updatedAt = Number.isFinite(stamp) ? new Date(stamp + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16) : ''
    this.setData({ ...result, activeRound, updatedAt })
    if (!this.positioned && (!this.focusedId || result.roundByMatch[this.focusedId])) {
      this.setData({ scrollTarget: `swiss-round-${activeRound}` }); this.positioned = true
    }
  },
  onRoundTap(e) {
    const round = Number(e.currentTarget.dataset.round)
    if (!Number.isInteger(round) || round < 1 || round > 5) return
    this.selectedRound = round
    this.setData({ activeRound: round, scrollTarget: `swiss-round-${round}` })
  },
  onBoardScroll(e) {
    const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const step = 574 * (info.windowWidth || 375) / 750
    const round = Math.max(1, Math.min(5, Math.round(e.detail.scrollLeft / step) + 1))
    if (round !== this.data.activeRound) { this.selectedRound = round; this.setData({ activeRound: round }) }
  },
  goDetail(e) { wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(e.currentTarget.dataset.id)}` }) },
  onPullDownRefresh() { this.refresh().finally(() => wx.stopPullDownRefresh()) },
  onShareAppMessage() { return share.message({ title: 'S赛瑞士轮签表 · 对阵与晋级形势', path: `/pages/worlds-swiss/worlds-swiss?round=${this.data.activeRound}` }) },
})
