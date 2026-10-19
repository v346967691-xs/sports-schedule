const data = require('../../utils/data')
const worlds = require('../../utils/worlds')
const follows = require('../../utils/team-follows')
const share = require('../../utils/share')
const boardController = require('../../utils/elimination-board').controller

Page({
  ...boardController,
  data: {
    filters: [{ key: 'all', name: '全部' }, { key: 'lpl', name: 'LPL' }, { key: 'followed', name: '我关注的' }],
    activeFilter: 'all', live: [], upcoming: [], finished: [], sections: [], swiss: [], bracket: null, next: null, total: 0,
  },
  onShow() {
    this.visible = true
    this.build()
    data.refresh().then(() => { if (this.visible) this.build() })
    data.loadWorldsArchive().then((list) => {
      this.archiveMatches = list
      if (this.visible) this.build()
    })
    this.refreshLive()
  },
  onHide() { this.visible = false; this.stopPoll() },
  onUnload() { this.visible = false; this.stopPoll() },
  refreshLive() {
    data.refreshLive().then(() => { if (this.visible) this.build() })
  },
  stopPoll() { if (this.timer) clearInterval(this.timer); this.timer = null },
  build() {
    const lplIds = []
    data.query({ comps: ['lpl'] }).forEach((m) => [m.home, m.away].forEach((t) => {
      if (t && t.id && t.id !== 'TBD' && lplIds.indexOf(String(t.id)) < 0) lplIds.push(String(t.id))
    }))
    const current = data.query({ comps: ['worlds'], from: worlds.FROM, to: worlds.TO })
    const currentIds = {}
    current.forEach((m) => { currentIds[m.id] = true })
    const all = current.concat((this.archiveMatches || []).filter((m) => !currentIds[m.id]))
    const model = worlds.build(all, {
      filter: this.data.activeFilter, lplIds, teams: follows.asFilter(), matchHasTeam: data.matchHasTeam, compOf: data.compOf,
    })
    this.setData(Object.assign({}, model, {
      ...this.bracketState(model.bracket, 'worlds'),
      sections: [{ key: 'live', title: '正在进行', items: model.live }, { key: 'upcoming', title: '接下来的比赛', items: model.upcoming }, { key: 'finished', title: '已结束', items: model.finished }],
      source: data.source(), updatedAt: data.generatedAt(), stale: data.staleInfo().stale,
    }))
    // 只有当前赛事存在进行中比赛才启动；切走或赛后立即清理。
    if (worlds.eventMatches(data.query({ comps: ['worlds'] })).some((m) => m.status === 'live')) {
      if (this.visible && !this.timer) this.timer = setInterval(() => data.refreshLive(true).then(() => { if (this.visible) this.build() }), 60000)
    } else this.stopPoll()
  },
  onFilterTap(e) { this.setData({ activeFilter: e.currentTarget.dataset.key }, () => this.build()) },
  goDetail(e) { wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(e.currentTarget.dataset.id)}` }) },
  goBrief() { wx.navigateTo({ url: '/pages/worlds-brief/worlds-brief' }) },
  goSwiss() { wx.navigateTo({ url: '/pages/worlds-swiss/worlds-swiss' }) },
  goTeams() { wx.navigateTo({ url: '/pages/teams/teams' }) },
  onShareAppMessage() { return share.message({ title: 'Worlds 2026 · 赛程、赛果与晋级形势', path: '/pages/worlds/worlds' }) },
})
