const share = require('../../utils/share')
const data = require('../../utils/data')
const view = require('../../utils/view')
const fmt = require('../../utils/format')
const nav = require('../../utils/nav')
const poster = require('../../utils/poster')
const { appInstance } = require('../../utils/app-instance')

const CATS = [
  { key: 'football', name: '足球' },
  { key: 'basketball', name: '篮球' },
  { key: 'esports', name: '电竞' },
]

const PAGE_SIZE = 3
/** 赛程卡片上给每队挂几个近况色块。5 个是足球 App 的通例，再多会挤到队名 */
const FORM_N = 5
/** 实时比分轮询间隔。服务端 live_scores 60 秒刷一次，客户端也按 60 秒拉，不多打接口 */
const LIVE_POLL_MS = 60 * 1000

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
    /** 转发卡图：onShareAppMessage 是同步的，必须提前画好存这里 */
    shareImage: '',
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
    this.syncLivePoll()
  },

  onHide() { this.stopLivePoll() },
  onUnload() { this.stopLivePoll() },

  /* ------------------------------------------------------------ 实时比分轮询
   *
   * 🔴 为什么页面要自己起定时器：`schedule_cache` 15 分钟才刷一次，篮球一节才 12 分钟，
   *    光靠 onShow 拉云端，用户盯着页面看比分是**不动**的。
   *    实时表 `live_scores` 只有 ~2KB（服务端 60 秒刷一次），所以这里 60 秒轮询一次很便宜。
   * ⚠️ 没有进行中的比赛就**不起**定时器（凌晨没比赛时不白耗电）；
   *    页面切走（onHide/onUnload）必须清掉，否则后台还在跑。
   */
  syncLivePoll() {
    data.refreshLive().then((r) => {
      if (r.patched) this.reload()
      if (data.hasLive()) this.startLivePoll()
      else this.stopLivePoll()
    })
  },

  startLivePoll() {
    if (this.liveTimer) return
    this.liveTimer = setInterval(() => {
      // force：轮询是用户主动盯着看的场景，不该被 45 秒节流挡住
      data.refreshLive(true).then((r) => {
        if (r.patched) this.reload()
        if (!data.hasLive()) this.stopLivePoll()
      })
    }, LIVE_POLL_MS)
  },

  stopLivePoll() {
    if (!this.liveTimer) return
    clearInterval(this.liveTimer)
    this.liveTimer = null
  },

  /**
   * 拉云端赛程缓存。
   * 🔴 不管有没有换上新数据都要重绘一次:首页那套「陈旧」警告的结论依赖「云端探测完了没」，
   *    只看 updated 的话，换不上新数据时警告会不肯消失（详见 utils/data.js 的 staleInfo）。
   *    一次 setData 换一个准确的提示，比少一次渲染值。
   */
  cloudRefresh() {
    data.refresh().then(() => {
      this.reload()
      this.syncLivePoll()
    })
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
    // 前瞻只在「看未来赛程」时有意义：已完赛的比赛结果就摆在比分上，再挂近况是噪声
    this._showForm = mode === 'upcoming' && !fallback

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
    }, () => this.buildShareImage())
  },

  /**
   * 转发卡图：画「日期 + 共 N 场 + 前 4 场对阵」。
   * 必须提前画 —— onShareAppMessage 是同步的，等分享时再画来不及。
   */
  async buildShareImage() {
    const d = this.data
    // 🔴 只取**第一个比赛日**的场次（2026-10-08 修）：
    //    以前标题写的是「筛选结果的总场次数」（跨很多天），日期却写第一组的
    //    dayLabel（「今天」/「明天」）→ 拼出「今天 NBA 84 场」这种误导性信息。
    //    标题里的「N 场」必须和上面的日期严格对应，所以两者都取自同一组。
    const first = (this.allGroups || [])[0]
    const items = (first && first.items) || []
    if (!items.length) return
    const img = await poster.build(this, 'share-canvas', 'schedule', {
      dateText: (first && first.dayLabel) || '',
      title: d.compName
        ? `${d.compName} · ${items.length} 场`
        : `${items.length} 场赛程`,
      // ⚠️ allGroups 里是**未 decorate 的原始 match**：队名字段是 `zh`（不是 `zhName`），
      //    也没有 `_compName`（那是 view.decorateList 才加的）→ 这里自己取赛事中文名。
      rows: items.slice(0, 4).map((m) => ({
        time: m.time || '',
        home: (m.home && (m.home.zh || m.home.name)) || '',
        away: (m.away && (m.away.zh || m.away.name)) || '',
        comp: (data.compOf(m.comp) || {}).name || '',
      })),
      accent: (d.activeComp && (data.compOf(d.activeComp) || {}).accent) || '#2E7CF6',
    })
    if (img) this.setData({ shareImage: img })
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
    const showForm = !!this._showForm
    groups.slice(0, Math.min(n, groups.length)).forEach((g) => {
      rows.push({ type: 'head', key: `h-${g.date}`, date: g.date, dayLabel: g.dayLabel, count: g.items.length })
      g.items.forEach((m) => {
        if (showForm) {
          // 🔴 近况**从赛程快照算**（data.teamForm），不读 match_detail ——
          //    详情里那份 form 覆盖不到 10% 的比赛，而这里要覆盖所有未来赛程。
          //    实测 60 场 × 2 队 = 6ms，性能完全够。
          m._homeForm = data.teamForm(m.comp, m.home.id, FORM_N).map((f) => f.result)
          m._awayForm = data.teamForm(m.comp, m.away.id, FORM_N).map((f) => f.result)
        }
        rows.push({ type: 'match', key: `m-${m.id}`, match: m })
      })
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
    const d = this.data
    // 有选中赛事就把赛事名写进标题，比通用文案更值得点
    const title = d.compName
      ? `${d.compName} · ${d.totalMatches} 场赛程 · 闪现赛程助手`
      : '闪现赛程助手 · 按赛事查赛程与比分'
    return share.message({
      title,
      path: d.activeComp
        ? `/pages/schedule/schedule?comp=${encodeURIComponent(d.activeComp)}`
        : '/pages/schedule/schedule',
      imageUrl: d.shareImage,
    })
  },

  onShareTimeline() {
    const d = this.data
    const title = d.compName
      ? `${d.compName} · ${d.totalMatches} 场赛程`
      : '闪现赛程助手 · 按赛事查赛程与比分'
    return share.timeline({
      title,
      query: d.activeComp ? `comp=${encodeURIComponent(d.activeComp)}` : '',
      imageUrl: d.shareImage,
    })
  },
})
