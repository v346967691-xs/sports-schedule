const share = require('../../utils/share')
const data = require('../../utils/data')
const view = require('../../utils/view')
const fmt = require('../../utils/format')
const nav = require('../../utils/nav')
const { appInstance } = require('../../utils/app-instance')

const CATS = [
  { key: 'football', name: '足球' },
  { key: 'basketball', name: '篮球' },
  { key: 'esports', name: '电竞' },
]

const PAGE_SIZE = 3

Page({
  data: {
    cats: CATS,
    activeCat: 'football',
    catComps: [],
    activeComp: '',
    teamFilter: null,
    mode: 'upcoming',
    rows: [],
    shownGroups: PAGE_SIZE,
    totalGroups: 0,
    totalMatches: 0,
    fallback: false,
    updatedAt: '',
    stale: false,
    staleLabel: '',
    loadError: '',
    hasStandings: false,
    compName: '',
  },

  onLoad(query) {
    let cat = 'football'
    let comp = ''
    if (query && query.comp) {
      comp = decodeURIComponent(query.comp)
      const found = data.compMap()[comp]
      if (found) cat = found.cat
    }
    this.setData({ activeCat: cat, activeComp: comp })
    this.applyCat(cat)
    this.cloudRefresh()
  },

  onShow() {
    const app = appInstance()
    const pending = app.globalData.pendingComp
    if (pending) {
      const found = data.compMap()[pending]
      app.globalData.pendingComp = ''
      if (found) {
        this.setData({ activeCat: found.cat, activeComp: pending, teamFilter: null, shownGroups: PAGE_SIZE })
        this.reload()
        this.cloudRefresh()
        return
      }
    }
    const pendingTeam = app.globalData.pendingTeam
    if (pendingTeam) {
      const found = data.compMap()[pendingTeam.comp]
      app.globalData.pendingTeam = ''
      if (found) {
        this.setData({
          activeCat: found.cat,
          activeComp: pendingTeam.comp,
          teamFilter: pendingTeam,
          shownGroups: PAGE_SIZE,
        })
        this.reload()
        this.cloudRefresh()
        return
      }
    }
    if (this.data.totalGroups) this.reload()
    this.cloudRefresh()
  },

  /** 拉云端赛程缓存，若比本地新则重建列表 */
  cloudRefresh() {
    data.refresh().then((r) => { if (r.updated) this.reload() })
  },

  applyCat(cat) {
    const catComps = (data.categories().find((c) => c.key === cat) || {}).competitions || []
    const compMap = data.compMap()
    this.setData({
      catComps: catComps.map((k) => compMap[k]).filter(Boolean),
      activeCat: cat,
      teamFilter: null,
    })
    this.reload()
  },

  /** 同首页：出错也要在页面上说清楚，不能留白 */
  reload() {
    try {
      this.doReload()
    } catch (err) {
      console.error('[赛程助手] 赛程页渲染失败', err)
      this.setData({ loadError: (err && err.message) || '赛程页渲染失败' })
    }
  },

  doReload() {
    if (!data.matches().length) {
      this.setData({
        loadError: '赛程数据没有打进小程序包。请在项目目录执行 npm run sync，再用开发者工具重新上传体验版。',
      })
      return
    }

    const { activeCat, activeComp, mode, shownGroups, teamFilter } = this.data
    const comps = activeComp ? [activeComp] : []
    let list = mode === 'finished'
      ? data.finished({ cat: activeCat, comps, team: teamFilter })
      : data.upcoming({ cat: activeCat, comps, team: teamFilter })

    // 赛季间歇期：没有未来赛程时自动展示最近对战，而不是丢给用户一个空列表
    const fallback = mode === 'upcoming' && list.length === 0
    if (fallback) list = data.finished({ cat: activeCat, comps, team: teamFilter }).slice(0, 40)

    this.allGroups = view.groupByDate(list, { compOf: data.compOf })
    this.setData({
      rows: this.buildRows(shownGroups),
      totalGroups: this.allGroups.length,
      totalMatches: list.length,
      fallback,
      updatedAt: this.updatedLabel(),
      stale: data.staleInfo().stale,
      staleLabel: this.staleLabel(),
      source: data.source(),
      // 只在选中了具体赛事、且该赛事真有积分榜时才给入口（杯赛 / 国字号没有）
      hasStandings: !!activeComp && !!data.standingsOf(activeComp),
      compName: activeComp ? data.compOf(activeComp).name : '',
    })
  },

  /** 看赛程时顺手查排名：跳到该赛事的积分榜 */
  onRankTap() {
    const comp = this.data.activeComp
    if (!comp) return
    // ⚠️ 积分榜是 tabBar 页面，navigateTo 会静默失败，必须走 nav.toRank
    nav.toRank(comp)
  },

  /**
   * 把分组拍平成「日期头 + 比赛卡」的单一列表，模板里一层循环逐场铺开。
   * 之前用嵌套 wx:for，部分运行时下内层取不到外层 item，导致只显示日期头。
   */
  buildRows(n) {
    const groups = this.allGroups || []
    const rows = []
    groups.slice(0, Math.min(n, groups.length)).forEach((g) => {
      rows.push({ type: 'head', key: `h-${g.date}`, date: g.date, dayLabel: g.dayLabel, count: g.items.length })
      g.items.forEach((m) => rows.push({ type: 'match', key: `m-${m.id}`, match: m }))
    })
    return rows
  },

  updatedLabel() {
    const gen = data.generatedAt()
    if (!gen) return ''
    const d = new Date(gen)
    return `${fmt.pad(d.getMonth() + 1)}-${fmt.pad(d.getDate())} ${fmt.pad(d.getHours())}:${fmt.pad(d.getMinutes())}`
  },

  /** 数据陈旧时给出「多久没更新」的人话说明，正常刷新时返回空串 */
  staleLabel() {
    const info = data.staleInfo()
    if (!info.stale) return ''
    const h = Math.floor(info.minutes / 60)
    const m = info.minutes % 60
    if (h <= 0) return `已 ${m} 分钟未更新`
    return m ? `已 ${h} 小时 ${m} 分钟未更新` : `已 ${h} 小时未更新`
  },

  onCatTap(e) {
    const cat = e.currentTarget.dataset.key
    this.setData({ activeCat: cat, activeComp: '', shownGroups: PAGE_SIZE })
    this.applyCat(cat)
  },

  onCompTap(e) {
    const key = e.currentTarget.dataset.key
    const next = key === this.data.activeComp ? '' : key
    this.setData({ activeComp: next, shownGroups: PAGE_SIZE, teamFilter: null })
    this.reload()
  },

  /** 取消「只看某队」 */
  onClearTeam() {
    this.setData({ teamFilter: null, activeComp: '', shownGroups: PAGE_SIZE })
    this.reload()
  },

  onModeTap(e) {
    const mode = e.currentTarget.dataset.mode
    if (mode === this.data.mode) return
    this.setData({ mode, shownGroups: PAGE_SIZE })
    this.reload()
  },

  onLoadMore() {
    const next = Math.min(this.data.shownGroups + PAGE_SIZE, this.data.totalGroups)
    this.setData({ shownGroups: next, rows: this.buildRows(next) })
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}` })
  },

  onPullDownRefresh() {
    this.reload()
    wx.stopPullDownRefresh()
  },
  onShareAppMessage() {
    return share.message({ title: '闪现赛程助手 · 按赛事查赛程与比分', path: '/pages/schedule/schedule' })
  },

  onShareTimeline() {
    return share.timeline({ title: '闪现赛程助手 · 按赛事查赛程与比分' })
  },
})
