const data = require('../../utils/data')
const view = require('../../utils/view')
const tennisEvent = require('../../utils/tennis-event')
const tree = require('../../utils/tournament-bracket')
const bracketWindow = require('../../utils/bracket-window')
const follows = require('../../utils/team-follows')
const share = require('../../utils/share')
const fmt = require('../../utils/format')

function eventLevel(event) {
  if (typeof data.tennisTournamentLevel === 'function') {
    // 上游分站日期可能包含资格赛；按正赛日期核对等级，不能只用分站首日匹配日历。
    const dates = [event.start].concat(data.tennisEventMatches(event.key).map(match => match.date))
    for (const date of dates) {
      const level = data.tennisTournamentLevel(event.comp, event.title, String(date || '').slice(0, 10))
      if (level) return level
    }
  }
  return event.comp.toUpperCase()
}

Page({
  data: {
    event: null, relatedEvents: [], tours: [], activeTour: '', tab: 'schedule',
    courts: [], courtFilter: '', dates: [], dateFilter: '', groups: [], shown: 30, total: 0,
    statusFilter: '', statuses: [{ key: '', name: '全部状态' }, { key: 'live', name: '进行中' },
      { key: 'upcoming', name: '未开始' }, { key: 'finished', name: '已结束' }],
    bracket: null, zoom: 1, treeWidth: 0, treeHeight: 0, bracketPages: [], roundNavigation: [], bracketIndex: 0, error: '', updatedAt: '',
  },
  onLoad(query) {
    this.readWindowSize()
    this.eventKey = query && query.event ? decodeURIComponent(query.event) : ''
    this.matchId = query && query.id ? decodeURIComponent(query.id) : ''
    const options = query || {}
    this.pendingRound = options.round !== undefined && Number.isFinite(Number(options.round)) ? Number(options.round) : null
    this.initialDateSet = !!options.date
    this.setData({ tab: options.tab === 'bracket' ? 'bracket' : 'schedule',
      activeTour: ['all', 'atp', 'wta'].includes(options.tour) ? options.tour : '',
      courtFilter: options.court ? decodeURIComponent(options.court) : '',
      dateFilter: options.date || '', statusFilter: ['live', 'upcoming', 'finished'].includes(options.status) ? options.status : '' })
  },
  onShow() {
    this.visible = true
    this.build()
    data.refresh().then(() => { if (this.visible) this.build() })
    data.refreshLive().then(() => { if (this.visible) this.build() })
  },
  onHide() { this.visible = false; this.stopPoll() },
  onUnload() { this.visible = false; this.stopPoll() },
  stopPoll() { if (this.timer) clearInterval(this.timer); this.timer = null },
  build() {
    const events = data.tennisEvents()
    const fromMatch = this.matchId && data.tennisEventForMatch(data.findMatch(this.matchId))
    const event = events.find(event => event.key === this.eventKey) || events.find(event => fromMatch && event.key === fromMatch.key)
    if (!event) { this.setData({ event: null, error: '暂时没有这站赛事的数据，请稍后刷新。' }); this.stopPoll(); return }
    this.eventKey = event.key
    event.year = event.start.slice(0, 4)
    event.startLabel = event.start.slice(0, 10)
    event.endLabel = `— ${event.end.slice(0, 10)}`
    // 同站 ATP/WTA 分项共用一个入口；年份分开，不能混入另一届签表。
    const relatedEvents = events.filter(other => other.title === event.title
      && Date.parse(other.start) <= Date.parse(event.end) && Date.parse(other.end) >= Date.parse(event.start))
    event.levelLabel = relatedEvents.map(eventLevel).join(' / ')
    let activeTour = this.data.activeTour
    if (!activeTour) activeTour = this.data.tab === 'schedule' && relatedEvents.length > 1 ? 'all' : event.comp
    if (this.data.tab === 'bracket' && activeTour === 'all') activeTour = event.comp
    if (activeTour !== 'all' && !relatedEvents.some(item => item.comp === activeTour)) activeTour = event.comp
    const tours = (relatedEvents.length > 1 && this.data.tab === 'schedule' ? [{ key: 'all', name: '全部单打' }] : [])
      .concat(relatedEvents.map(item => ({ key: item.comp, name: `${item.comp.toUpperCase()} 单打` })))
    const selectedEvents = relatedEvents.filter(item => activeTour === 'all' || item.comp === activeTour)
    const all = selectedEvents.flatMap(item => data.tennisEventMatches(item.key)).filter(match=>match.status!=='canceled')
    const courtMap = new Map()
    all.forEach(match => { const court = tennisEvent.courtOf(match); courtMap.set(court.key, court) })
    const courts = [...courtMap.values()].sort(tennisEvent.compareCourts)
    const courtFilter = courts.some(court => court.key === this.data.courtFilter) ? this.data.courtFilter : ''
    const dates = [...new Set(all.map(match => match.date))].sort().map(date => ({ key: date, name: `${date.slice(5)} ${fmt.weekdayLabel(date)}` }))
    let dateFilter = dates.some(date => date.key === this.data.dateFilter) ? this.data.dateFilter : ''
    if (!this.initialDateSet) {
      const today = fmt.todayStr()
      if (dates.some(date => date.key === today)) dateFilter = today
      this.initialDateSet = true
    }
    const filtered = all.filter(match => (!courtFilter || tennisEvent.courtOf(match).key === courtFilter)
      && (!dateFilter || match.date === dateFilter) && (!this.data.statusFilter || match.status === this.data.statusFilter))
      .sort((a, b) => String(a.start).localeCompare(String(b.start)))
    const grouped = view.groupByDate(filtered.slice(0, this.data.shown), { compOf: data.compOf, tennisTournamentLevel: data.tennisTournamentLevel })
    grouped.forEach(group => group.items.forEach(match => { match.courtName = tennisEvent.courtOf(match).name }))
    const selected = selectedEvents[0]
    const selectedMatches = selected ? data.tennisEventMatches(selected.key) : []
    const players = follows.asFilter().filter(player => selected && player.comp === selected.comp)
    const followedIds = [...new Set(selectedMatches.flatMap(match => [match.home, match.away])
      .filter(side => side && players.some(player => data.matchHasTeam({ comp: selected.comp, home: side, away: { id: '_other' } }, player)))
      .map(player => String(player.id))) ]
    const bracket = tree.build(tree.tennisEntries(selectedMatches), { followedIds })
    if (this.bracketKey !== (selected && selected.key)) {
      this.bracketKey = selected && selected.key; this.manualZoom = null; this.pairIndex = 0
    }
    const bracketState = this.bracketState(bracket)
    this.setData({ event, relatedEvents, tours, activeTour, courts, courtFilter, dates, dateFilter, groups: grouped,
      total: filtered.length, bracket, error: '', updatedAt: data.generatedAt(),
      ...bracketState })
    wx.setNavigationBarTitle({ title: event.name })
    if (all.some(match => data.needsLivePoll(match))) {
      if (this.visible && !this.timer) this.timer = setInterval(() => data.refreshLive().then(() => { if (this.visible) this.build() }), 60000)
    } else this.stopPoll()
  },
  onTab(e) { this.setData({ tab: e.currentTarget.dataset.key }, () => this.build()) },
  onTour(e) { this.setData({ activeTour: e.currentTarget.dataset.key, shown: 30 }, () => this.build()) },
  onCourt(e) { this.setData({ courtFilter: e.currentTarget.dataset.key || '', shown: 30 }, () => this.build()) },
  onDate(e) { this.setData({ dateFilter: e.currentTarget.dataset.key || '', shown: 30 }, () => this.build()) },
  onStatus(e) { this.setData({ statusFilter: e.currentTarget.dataset.key || '', shown: 30 }, () => this.build()) },
  loadMore() { this.setData({ shown: this.data.shown + 30 }, () => this.build()) },
  readWindowSize(size) {
    if (!size) {
      try { size = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : typeof wx.getSystemInfoSync === 'function' ? wx.getSystemInfoSync() : {} }
      catch (err) { size = {} }
    }
    this.windowSize = {width: size.windowWidth || 375, height: (size.windowHeight || 667) * 0.68}
  },
  onResize(e) { this.readWindowSize(e.size); this.manualZoom = null; if (this.data.bracket) this.setData(this.bracketState(this.data.bracket)) },
  bracketState(bracket) {
    if (this.pendingRound !== null && this.pendingRound !== undefined && bracket.columns.length) {
      const index = bracket.columns.findIndex(column => column.order === this.pendingRound)
      if (index >= 0) this.pairIndex = index
      this.pendingRound = null
    }
    const state = bracketWindow.layout(bracket, {...this.windowSize, current: this.pairIndex || 0, zoom: this.manualZoom})
    this.pairIndex = state.current
    const pane = state.pages[state.current]
    return {bracketPages: state.pages, roundNavigation: state.navigation, bracketIndex: state.current,
      zoom: state.zoom, zoomLabel: Math.round(state.zoom * 100), autoFit: !Number.isFinite(this.manualZoom),
      treeWidth: pane ? pane.treeWidth : 0, treeHeight: pane ? pane.treeHeight : 0}
  },
  selectBracketPair(index) {
    if (!this.data.bracket) return
    const next = Math.max(0, Math.min(index, Math.max(0, this.data.bracket.columns.length - 2)))
    if (next === this.pairIndex) return
    this.pairIndex = next; this.manualZoom = null
    this.setData(this.bracketState(this.data.bracket))
  },
  onBracketSwipe(e) { this.selectBracketPair(Number(e.detail.current)) },
  onBracketRound(e) { this.selectBracketPair(Number(e.currentTarget.dataset.index)) },
  onAutoFit() { if (this.data.bracket) { this.manualZoom = null; this.setData(this.bracketState(this.data.bracket)) } },
  onZoom(e) {
    if (!this.data.bracket) return
    this.manualZoom = Math.max(0.4, Math.min(1.6, Math.round((this.data.zoom + Number(e.currentTarget.dataset.step)) * 100) / 100))
    this.setData(this.bracketState(this.data.bracket))
  },
  goDetail(e) { wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(e.currentTarget.dataset.id)}` }) },
  onPullDownRefresh() {
    data.refresh().then(() => { if (this.visible) this.build() }).finally(() => wx.stopPullDownRefresh())
  },
  shareQuery() {
    const state = this.data
    const selected = state.relatedEvents.find(item => item.comp === state.activeTour)
    const params = [`event=${encodeURIComponent(selected ? selected.key : this.eventKey)}`, `tab=${state.tab}`, `tour=${state.activeTour}`]
    if (state.tab === 'schedule') {
      if (state.courtFilter) params.push(`court=${encodeURIComponent(state.courtFilter)}`)
      if (state.dateFilter) params.push(`date=${state.dateFilter}`)
      if (state.statusFilter) params.push(`status=${state.statusFilter}`)
    } else if (state.bracket && state.bracket.columns[state.bracketIndex]) {
      params.push(`round=${state.bracket.columns[state.bracketIndex].order}`)
    }
    return params.join('&')
  },
  onShareAppMessage() {
    return share.message({ title: `${this.data.event ? this.data.event.name : '网球分站'} · ${this.data.tab === 'bracket' ? '晋级图' : '球场赛程'}`,
      path: `/pages/tournament/tournament?${this.shareQuery()}` })
  },
  onShareTimeline() { return share.timeline({ title: `${this.data.event ? this.data.event.name : '网球分站'} · 赛程与晋级图`, query: this.shareQuery() }) },
})
