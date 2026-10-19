const share = require('../../utils/share')
const data = require('../../utils/data')
const view = require('../../utils/view')
const fmt = require('../../utils/format')
const nav = require('../../utils/nav')
const poster = require('../../utils/poster')
const bracket = require('../../utils/bracket')
const boardController = require('../../utils/elimination-board').controller
const competitionFormat = require('../../utils/competition-format')
const tennis = require('../../utils/tennis')
const tennisEvent = require('../../utils/tennis-event')
const competitionOrder = require('../../utils/competition-order')
const { appInstance } = require('../../utils/app-instance')

const CATS = [
  { key: 'football', name: '足球' },
  { key: 'basketball', name: '篮球' },
  { key: 'esports', name: '电竞' },
  { key: 'tennis', name: '网球' },
]

const PAGE_SIZE = 3
const FORM_N = 5
/** 实时比分轮询间隔。服务端 live_scores 60 秒刷一次，客户端也按 60 秒拉，不多打接口 */
const LIVE_POLL_MS = 60 * 1000

/** 一场比赛属于哪个阶段（轮次）。与卡片小字共用 view.roundLabel，保证筛选条和卡片是同一个词 */
function stageOf(m) {
  if (tennis.isTennis(m)) return tennis.roundOf(m)
  const comp = data.compOf(m.comp) || {}
  return view.roundLabel(m.stage, comp.name)
}

/**
 * 阶段筛选条的可选项（含各阶段场次数）。
 *
 * 出现条件由数据决定，不写死赛事名：足球联赛 / NBA 常规赛的 stage 就是赛事名本身，
 * 只有一个取值，再挂一条「全部阶段」的筛选纯属噪音；而全球总决赛（入围赛 / 瑞士轮 /
 * 淘汰赛）、LPL（第 1~N 周）、KPL（擂台赛 / 常规赛）这类天生按轮次走的，筛选很有用。
 *
 * 🔴 只在选了**具体赛事**时给选项：选「全部」时各赛事的 stage 混在一起，
 *    足球那些 stage 就是赛事名，会拼出一条把每个联赛都列一遍的垃圾筛选条。
 * ⚠️ 排序按「各阶段最早一场」而不是列表顺序 —— 已结束模式的列表是倒序的，
 *    照列表顺序排会把决赛顶到最前面。
 */
function stageChipsOf(list) {
  const count = {}
  const first = {}
  list.forEach((m) => {
    const k = stageOf(m)
    if (!k) return
    count[k] = (count[k] || 0) + 1
    const t = Date.parse(m.start)
    if (Number.isFinite(t) && (first[k] === undefined || t < first[k])) first[k] = t
  })
  return Object.keys(count)
    .sort((a, b) => (first[a] || 0) - (first[b] || 0))
    .map((k) => ({ key: k, count: count[k] }))
}

Page({
  ...boardController,
  data: {
    cats: CATS,
    activeCat: 'football',
    catComps: [],
    compSortRows: [],
    showCompSort: false,
    compSortDragIndex: -1,
    compSortDragOffset: 0,
    activeComp: '',
    teamFilter: null,
    mode: 'upcoming',
    /** 阶段（轮次）筛选条：只有一个阶段时不渲染，见 stageChipsOf */
    stageChips: [],
    stageFilter: '',
    tournamentChips: [],
    tournamentFilter: '',
    tournamentLabel: '',
    courtFilter: '',
    courtChips: [],
    /** 淘汰赛对阵树（只在选中淘汰赛轮次时有值，见 doReload） */
    bracket: null,
    rows: [],
    shownGroups: PAGE_SIZE,
    totalGroups: 0,
    totalMatches: 0,
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
    let cat = query && CATS.some(c => c.key === query.cat) ? query.cat : 'football'
    let comp = ''
    if (query && query.comp) {
      comp = decodeURIComponent(query.comp)
      const found = data.compMap()[comp]
      if (found) cat = found.cat
    }
    const tennisQuery = cat === 'tennis' ? {
      tournamentFilter: query && query.tournament ? decodeURIComponent(query.tournament) : '',
      stageFilter: query && query.round ? decodeURIComponent(query.round) : '',
      courtFilter: query && query.court ? decodeURIComponent(query.court) : '',
      mode: query && ['upcoming', 'live', 'finished'].includes(query.mode) ? query.mode : 'upcoming',
    } : {}
    this.setData({ activeCat: cat, activeComp: comp, ...tennisQuery })
    this.applyCat(cat)
    this.cloudRefresh()
  },

  onShow() {
    this.liveVisible = true
    this.syncFavorites()
    const app = appInstance()
    const pending = app.globalData.pendingComp
    if (pending) {
      const found = data.compMap()[pending]
      app.globalData.pendingComp = ''
      if (found) {
        this.setData({ activeCat: found.cat, activeComp: pending, teamFilter: null, shownGroups: PAGE_SIZE, stageFilter: '', tournamentFilter: '' })
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
          // 🔴 刻意**不**把 activeComp 锁到这支球队所属的那个赛事。
          //    关注/球队页的语义是「看这支球队的比赛」，而同一支队会跨赛事出场
          //    （巴萨在西甲 liga + 欧冠 ucl，id 都是 83）。锁了 activeComp 之后
          //    下面的 `comps` 只剩一个赛事，等于把刚修好的跨赛事过滤又挡回去。
          activeComp: '',
          teamFilter: pendingTeam,
          shownGroups: PAGE_SIZE,
          stageFilter: '',
          tournamentFilter: '',
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

  onHide() { this.liveVisible = false; this.stopLivePoll() },
  onUnload() { this.liveVisible = false; this.stopLivePoll() },

  /** 先用本地关注态渲染，再同步登录用户的关注；详情页返回时也更新。 */
  syncFavorites() {
    return appInstance().refreshAuth().then(() => {
      if (this.liveVisible) this.setData({ rows: this.buildRows(this.data.shownGroups) })
    }).catch(err => console.warn('[赛程助手] 同步比赛关注失败', err))
  },

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
      if (!this.liveVisible) return
      if (r.patched) this.reload()
      this.startLivePoll()
    })
  },

  startLivePoll() {
    if (this.liveTimer) return
    this.liveTimer = setInterval(() => {
      if (!data.needsLivePoll()) return
      // force：轮询是用户主动盯着看的场景，不该被 45 秒节流挡住
      data.refreshLive(true).then((r) => {
        if (r.patched) this.reload()
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
    const categories = data.categories()
    const compKeys = (categories.find((c) => c.key === cat) || {}).competitions || []
    const compMap = data.compMap()
    const orderedKeys = competitionOrder.orderKeys(compKeys, categories)
    const catComps = orderedKeys.map((key) => compMap[key]).filter(Boolean)
    this.setData({
      catComps,
      compSortRows: catComps.map((comp) => ({ ...comp })),
      activeCat: cat,
      teamFilter: null,
    })
    this.reload()
  },

  /** 打开当前运动类别的赛事排序面板 */
  onCompSortOpen() {
    const categories = data.categories()
    const compMap = data.compMap()
    const categoryNames = Object.fromEntries(categories.map((category) => [category.key, category.name]))
    const rows = competitionOrder.getOrder(categories).map((key) => ({
      ...compMap[key],
      categoryName: categoryNames[(compMap[key] || {}).cat] || '',
    })).filter((comp) => comp.key)
    this.setData({ compSortRows: rows, showCompSort: true, compSortDragIndex: -1, compSortDragOffset: 0 })
  },

  onCompSortClose() {
    this._compSortDrag = null
    this.setData({ showCompSort: false, compSortDragIndex: -1, compSortDragOffset: 0 })
  },

  stopCompSortTap() {},

  /** 上下移动即保存，离开页面后顺序仍保留在本机 */
  onCompSortMove(e) {
    const index = Number(e.currentTarget.dataset.index)
    const direction = Number(e.currentTarget.dataset.direction)
    const nextIndex = index + direction
    const rows = competitionOrder.moveItem(this.data.compSortRows, index, nextIndex)
    if (rows.every((row, i) => row.key === this.data.compSortRows[i].key)) return
    if (!competitionOrder.setOrder(rows.map((comp) => comp.key))) {
      console.warn('[赛程助手] 保存赛事顺序失败')
    }
    this.setData({ compSortRows: rows, catComps: rows.filter((comp) => comp.cat === this.data.activeCat) })
  },

  onCompSortPin(e) {
    const index = Number(e.currentTarget.dataset.index)
    const rows = competitionOrder.moveToFront(this.data.compSortRows, index)
    if (rows.every((row, i) => row.key === this.data.compSortRows[i].key)) return
    if (!competitionOrder.setOrder(rows.map((comp) => comp.key))) console.warn('[赛程助手] 保存赛事顺序失败')
    this.setData({ compSortRows: rows, catComps: rows.filter((comp) => comp.cat === this.data.activeCat) })
  },

  onCompSortDragStart(e) {
    const index = Number(e.currentTarget.dataset.index)
    const rows = this.data.compSortRows || []
    const touch = (e.touches || [])[0]
    if (!Number.isInteger(index) || index < 0 || index >= rows.length || !touch) return
    this._compSortDrag = { startIndex: index, startY: touch.clientY, rows: rows.slice() }
    this.setData({ compSortDragIndex: index, compSortDragOffset: 0 })
  },

  onCompSortDragMove(e) {
    const drag = this._compSortDrag
    const touch = (e.touches || [])[0]
    if (!drag || !touch) return
    const width = (wx.getSystemInfoSync().windowWidth || 375)
    const rowHeight = width * 84 / 750
    const delta = touch.clientY - drag.startY
    const offset = Math.round(delta / rowHeight)
    const target = Math.max(0, Math.min(drag.rows.length - 1, drag.startIndex + offset))
    const rows = competitionOrder.moveItem(drag.rows, drag.startIndex, target)
    this._compSortDrag.target = target
    this.setData({ compSortRows: rows, compSortDragIndex: target, compSortDragOffset: delta - (target - drag.startIndex) * rowHeight })
  },

  onCompSortDragEnd() {
    const drag = this._compSortDrag
    if (!drag) return
    this._compSortDrag = null
    const rows = this.data.compSortRows.slice()
    if (rows.some((row, i) => row.key !== drag.rows[i].key)
      && !competitionOrder.setOrder(rows.map((comp) => comp.key))) console.warn('[赛程助手] 保存赛事顺序失败')
    this.setData({ compSortRows: rows, compSortDragIndex: -1, compSortDragOffset: 0,
      catComps: rows.filter((comp) => comp.cat === this.data.activeCat) })
  },

  onCompSortReset() {
    const categories = data.categories()
    const categoryNames = Object.fromEntries(categories.map((category) => [category.key, category.name]))
    const compMap = data.compMap()
    if (!competitionOrder.resetOrder(categories)) console.warn('[赛程助手] 恢复赛事默认顺序失败')
    const rows = competitionOrder.getOrder(categories).map((key) => ({
      ...compMap[key],
      categoryName: categoryNames[(compMap[key] || {}).cat] || '',
    })).filter((comp) => comp.key)
    this.setData({ compSortRows: rows, catComps: rows.filter((comp) => comp.cat === this.data.activeCat) })
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

    const { activeCat, activeComp, mode, shownGroups, teamFilter, stageFilter } = this.data
    const comps = activeComp ? [activeComp] : []
    let list = mode === 'finished'
      ? data.finished({ cat: activeCat, comps, team: teamFilter })
      : mode === 'live'
        ? data.query({ cat: activeCat, comps, team: teamFilter, status: 'live' })
        : data.upcoming({ cat: activeCat, comps, team: teamFilter, status: 'upcoming' })
    // 阶段筛选。选项按**未筛选**的列表算，否则选完某阶段后选项本身就没了，切不回来。
    // 筛掉的阶段在 totalMatches / totalGroups 里也不出现，所以「共 N 场」跟眼睛看到的一致。
    const tournamentChips = activeCat === 'tennis' ? tennis.tournamentChipsOf(list, data.tennisTournamentLevel).map(c => ({
      ...c, label: activeComp ? c.label : `${c.comp.toUpperCase()} · ${c.label}`,
    })) : []
    const selectedTournament = tournamentChips.find(c => c.key === this.data.tournamentFilter)
    const tournamentFilter = selectedTournament ? selectedTournament.key : ''
    if (tournamentFilter) list = list.filter(m => tennis.tournamentOf(m).key === tournamentFilter)
    const courtMap = new Map()
    if (activeCat === 'tennis' && tournamentFilter) {
      data.query({ cat: 'tennis', comps }).filter(m => tennis.tournamentOf(m).key === tournamentFilter)
        .forEach(m => { const court = tennisEvent.courtOf(m); courtMap.set(court.key, court) })
    }
    const courtChips = [...courtMap.values()].sort(tennisEvent.compareCourts)
    const courtFilter = courtChips.some(court => court.key === this.data.courtFilter) ? this.data.courtFilter : ''
    const stageChips = activeCat === 'tennis'
      ? (tournamentFilter ? stageChipsOf(list) : [])
      : (activeComp ? stageChipsOf(list) : [])
    const stage = stageChips.some((c) => c.key === stageFilter) ? stageFilter : ''
    if (stage) list = list.filter((m) => stageOf(m) === stage)
    if (courtFilter) list = list.filter(m => tennisEvent.courtOf(m).key === courtFilter)

    const compName = activeComp ? data.compOf(activeComp).name : ''

    /**
     * 淘汰赛对阵树。
     *
     * 🔴 只在选中了淘汰赛轮次（八强 / 半决赛 / 决赛）时出现 —— 挂在「全部阶段」上会常年
     *    占掉首屏一大块，而用户点「四分之一决赛」时才是真的想看整张树。
     * 🔴 数据用**没被轮次筛过**的整份赛事赛程：树天生要跨轮次（八强 → 半决赛 → 决赛），
     *    拿筛过的 list 去建永远只能出一列，直接返回 null。
     * 对阵树跨轮次展示，不受列表的三种比赛状态筛选影响。
     */
    const koTree = activeCat !== 'tennis' && activeComp && bracket.koIndexOf(stage) >= 0
      ? bracket.buildBracket(data.query({ comps: [activeComp], team: teamFilter }), compName)
      : null

    this.allGroups = view.groupByDate(list, { compOf: data.compOf, tennisTournamentLevel: data.tennisTournamentLevel })
    this.allGroups.forEach(group => group.items.forEach(match => {
      if (tennis.isTennis(match)) match._courtLabel = tennisEvent.courtOf(match).name
    }))
    this.setData({
      rows: this.buildRows(shownGroups),
      totalGroups: this.allGroups.length,
      totalMatches: list.length,
      stageChips,
      stageFilter: stage,
      tournamentChips,
      tournamentFilter,
      courtChips,
      courtFilter,
      tournamentLabel: selectedTournament ? selectedTournament.label : '',
      bracket: koTree,
      ...this.bracketState(koTree, activeComp),
      formatModel: activeCat !== 'tennis' && activeComp ? competitionFormat.build(data.query({ comps: [activeComp] }), {
        comp: activeComp, cat: activeCat, compName, stage, table: data.standingsOf(activeComp), updatedAt: data.standingsGeneratedAt(),
      }) : null,
      updatedAt: this.updatedLabel(),
      stale: data.staleInfo().stale,
      staleLabel: this.staleLabel(),
      source: data.source(),
      // 只在选中了具体赛事、且该赛事真有积分榜时才给入口（杯赛 / 国字号没有）
      hasStandings: !!activeComp && !!data.standingsOf(activeComp),
      compName,
    }, () => this.buildShareImage())
  },

  goFormatMatch(e) { this.goDetail({ currentTarget: { dataset: { id: e.detail.id } } }) },

  /**
   * 转发卡图：画「日期 + 共 N 场 + 前 4 场对阵」。
   * 必须提前画 —— onShareAppMessage 是同步的，等分享时再画来不及。
   */
  /**
   * 分享用的「哪天 · 多少场」——**卡图和标题必须共用这一份**。
   *
   * 🔴 2026-10-08 修了两次才修全：
   *    第一次只发现卡图上「日期写今天、场次数写总数」→ 拼出「今天 NBA 84 场」；
   *    改完卡图后用户又发现**分享标题还是总数** —— 卡图说 4 场、标题说 84 场，
   *    两条信息对不上，同样是误导。根因是两处各自取数，没有共用同一份。
   */
  shareHeadline() {
    const first = (this.allGroups || [])[0]
    const items = (first && first.items) || []
    const stage = [this.data.tournamentLabel, this.data.stageFilter].filter(Boolean).join(' · ')
    const day = (first && first.dayLabel) || ''
    // 三个出口（卡图 / 给朋友 / 朋友圈）共用这一份。2026-10-09 加阶段：
    // 筛到「瑞士轮」后只说「8 场」等于没说清楚是哪 8 场，标题必须带上阶段。
    const head = [this.data.compName, stage, day].filter(Boolean).join(' · ') || '赛程'
    return { first, items, n: items.length, day, stage, head }
  },

  async buildShareImage() {
    const d = this.data
    const { items, day, stage } = this.shareHeadline()
    if (!items.length) return
    const img = await poster.build(this, 'share-canvas', 'schedule', {
      dateText: [stage, day].filter(Boolean).join(' · '),
      title: d.compName
        ? `${d.compName} · ${items.length} 场`
        : `${items.length} 场赛程`,
      // ⚠️ allGroups 里是**未 decorate 的原始 match**：队名字段是 `zh`（不是 zhName），
      //    也没有 `_compName`（那是 view.decorateList 才加的）→ 这里自己取赛事中文名。
      //    队名走 view.nameOf：未定对阵要显示「待定」，不能把接口的 TBD 原样印在卡上。
      rows: items.slice(0, 4).map((m) => ({
        time: m.time || '',
        home: view.nameOf(m.home),
        away: view.nameOf(m.away),
        comp: tennis.isTennis(m) ? [!d.activeComp ? m.comp.toUpperCase() : '', tennis.tournamentLabel(m, data.tennisTournamentLevel), tennis.roundOf(m)].filter(Boolean).join(' · ') : (data.compOf(m.comp) || {}).name || '',
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
    const showForm = this.data.mode === 'upcoming'
    const app = appInstance()
    const rows = []
    groups.slice(0, Math.min(n, groups.length)).forEach((g) => {
      rows.push({ type: 'head', key: `h-${g.date}`, date: g.date, dayLabel: g.dayLabel, count: g.items.length })
      g.items.forEach((m) => {
        rows.push({ type: 'match', key: `m-${m.id}`, match: { ...m, _isFav: app.isFav(m.id),
          _homeForm: showForm ? data.teamForm(m.comp, m.home.id, FORM_N).map(f => f.result) : [],
          _awayForm: showForm ? data.teamForm(m.comp, m.away.id, FORM_N).map(f => f.result) : [] } })
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
    this.setData({ activeCat: cat, activeComp: '', shownGroups: PAGE_SIZE, stageFilter: '', stageChips: [], tournamentFilter: '', courtFilter: '' })
    this.applyCat(cat)
  },

  onCompTap(e) {
    const key = e.currentTarget.dataset.key
    const next = key === this.data.activeComp ? '' : key
    this.setData({ activeComp: next, shownGroups: PAGE_SIZE, teamFilter: null, stageFilter: '', tournamentFilter: '', courtFilter: '' })
    this.reload()
  },

  /**
   * 阶段筛选。再点一次当前阶段 = 取消筛选（与赛事 chip 同款交互，不额外放「全部」按钮之外的状态）。
   * 换阶段要重置分页：阶段之间的比赛日数量差很多，沿用上一阶段的页码会直接看到空白。
   */
  onStageTap(e) {
    const key = e.currentTarget.dataset.key || ''
    const next = key === this.data.stageFilter ? '' : key
    if (next === this.data.stageFilter) return
    this.setData({ stageFilter: next, shownGroups: PAGE_SIZE })
    this.reload()
  },

  onTournamentTap(e) {
    const key = e.currentTarget.dataset.key || ''
    const next = key === this.data.tournamentFilter ? '' : key
    this.setData({ tournamentFilter: next, stageFilter: '', courtFilter: '', shownGroups: PAGE_SIZE })
    this.reload()
  },

  onCourtTap(e) {
    this.setData({ courtFilter: e.currentTarget.dataset.key || '', shownGroups: PAGE_SIZE })
    this.reload()
  },

  goTournament() {
    const match = data.query({ cat: 'tennis' }).find(m => tennis.tournamentOf(m).key === this.data.tournamentFilter)
    const event = data.tennisEventForMatch(match)
    if (event) wx.navigateTo({ url: `/pages/tournament/tournament?event=${encodeURIComponent(event.key)}` })
  },

  /** 取消「只看某队」 */
  onClearTeam() {
    this.setData({ teamFilter: null, activeComp: '', shownGroups: PAGE_SIZE, stageFilter: '', tournamentFilter: '' })
    this.reload()
  },

  onModeTap(e) {
    const mode = e.currentTarget.dataset.mode
    if (['upcoming', 'live', 'finished'].indexOf(mode) === -1) return
    if (mode === this.data.mode) return
    // 模式换了，阶段选项的池子也换了（已结束模式里没有未开赛的阶段）→ 一并清掉
    this.setData({ mode, shownGroups: PAGE_SIZE, stageFilter: '' })
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
  shareQuery() {
    const d = this.data
    const params = d.activeComp ? [`comp=${encodeURIComponent(d.activeComp)}`] : []
    if (d.activeCat === 'tennis') {
      if (!d.activeComp) params.push('cat=tennis')
      if (d.tournamentFilter) params.push(`tournament=${encodeURIComponent(d.tournamentFilter)}`)
      if (d.stageFilter) params.push(`round=${encodeURIComponent(d.stageFilter)}`)
      if (d.courtFilter) params.push(`court=${encodeURIComponent(d.courtFilter)}`)
      params.push(`mode=${d.mode}`)
    }
    return params.join('&')
  },
  onShareAppMessage() {
    const d = this.data
    // ⚠️ 标题里的「N 场」必须和卡图一致（共用 shareHeadline），否则两条信息打架
    const { n, head } = this.shareHeadline()
    const title = `${head} ${n} 场`
    return share.message({
      title,
      path: '/pages/schedule/schedule' + (this.shareQuery() ? `?${this.shareQuery()}` : ''),
      imageUrl: d.shareImage,
    })
  },

  onShareTimeline() {
    const d = this.data
    const { n, head } = this.shareHeadline()
    const title = `${head} ${n} 场`
    return share.timeline({
      title,
      query: this.shareQuery(),
      imageUrl: d.shareImage,
    })
  },
})
