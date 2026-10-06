const share = require('../../utils/share')
const poster = require('../../utils/poster')
const data = require('../../utils/data')
const view = require('../../utils/view')
const fmt = require('../../utils/format')
const favorites = require('../../utils/favorites')
const nav = require('../../utils/nav')
const { appInstance } = require('../../utils/app-instance')
const kplView = require('../../utils/kpl-view')

const RESULT_ZH = { W: '胜', D: '平', L: '负' }

/** 实时比分轮询间隔（与赛程页同值，服务端 live_scores 也是 60 秒刷一次） */
const LIVE_POLL_MS = 60 * 1000

/** 首发阵容的位置归组与中文标签。顺序就是首发列表的展示顺序。 */
const LINEUP_POS = [['G', '门将'], ['D', '后卫'], ['M', '中场'], ['F', '前锋']]

/**
 * 篮球单场球员数据要展示的列（上游给了 14 列，手机放不下那么多）。
 * ⚠️ 左侧是**上游的英文列名**，靠它在 `box.l` 里查下标 —— 不能直接写死下标，
 *    上游一改列顺序数字就全错位了（比缺数据严重得多）。
 */
const BASKET_COLS = [
  ['PTS', '得分'],
  ['REB', '篮板'],
  ['AST', '助攻'],
  ['FG', '投篮'],
  ['3PT', '三分'],
  ['MIN', '分钟'],
]

/**
 * 首发阵容：payload 里是 `{home:[{n,j,p,st}], away:[...]}`（见 tools/match-detail.js 的 pickLineups），
 * 这里整理成「按位置分组 + 替补席」的可渲染结构。
 *
 * ⚠️ 两个必须守住的点：
 *  ① **先用 `st` 分首发/替补，再按位置分组**。替补的位置在 ESPN 那边是 Substitute，
 *     抽出来就是空 —— 若先按位置分组，替补会被当成「位置缺失的首发」混进首发列表。
 *  ② 位置缺失的首发（上游没给）单独兜底一组，**不能丢人**。
 *
 * 没有 `lineups` 是常态（NBA 没有；未开赛的比赛上游不标首发；超出 48 小时窗口的
 * 日桶会被裁掉）—— 页面据此整块隐藏，不报错也不留白块。
 */
function buildLineups(d, sideName) {
  if (!d || !d.lineups || !d.lineups.home || !d.lineups.away) return null
  const rowOf = (p) => ({ j: p.j || '', n: p.n || '' })
  const side = (key, list) => {
    const all = (list || []).filter((p) => p && p.n)
    const starters = all.filter((p) => p.st)
    const groups = []
    LINEUP_POS.forEach(([code, label]) => {
      const rows = starters.filter((p) => (p.p || '') === code).map(rowOf)
      if (rows.length) groups.push({ key: code, label, rows })
    })
    const rest = starters.filter((p) => !LINEUP_POS.some(([code]) => code === (p.p || ''))).map(rowOf)
    if (rest.length) groups.push({ key: 'X', label: '首发', rows: rest })
    const bench = all.filter((p) => !p.st).map(rowOf)
    if (!groups.length) return null
    return { key, side: sideName(key), groups, bench, hasBench: bench.length > 0, count: starters.length }
  }
  const rows = [side('home', d.lineups.home), side('away', d.lineups.away)].filter(Boolean)
  return rows.length ? rows : null
}

/**
 * 篮球单场球员数据：payload 里是 `{l:[列名], home:[{n,j,p,s}], away:[...]}`
 * （见 tools/match-detail.js 的 pickBasketballPlayers）。
 *
 * ⚠️ 只有篮球有这份数据：足球的 `boxscore.players` 是空的（足球的球员维度数据在
 *    `rosters` 里，已经由 `lineups` 覆盖）。`box` 为 null 是常态 → 整块隐藏。
 * ⚠️ 列按需 `box.l` 里查下标，查不到（上游改了列）就**整块返回 null**，绝不错位显示。
 */
function buildBox(d, sideName) {
  if (!d || !d.box || !d.box.home || !d.box.away) return null
  const labels = d.box.l || []
  const idx = BASKET_COLS.map(([k]) => labels.indexOf(k))
  if (idx.some((i) => i < 0)) return null
  const side = (key, list) => {
    const rows = (list || [])
      .map((p, i) => {
        const s = String(p.s || '').split('|')
        return { i, j: p.j || '', n: p.n || '', st: p.t ? 1 : 0, cells: idx.map((x) => s[x] || '-') }
      })
      .filter((r) => r.n)
    if (!rows.length) return null
    return { key, side: sideName(key), rows }
  }
  const blocks = [side('home', d.box.home), side('away', d.box.away)].filter(Boolean)
  if (!blocks.length) return null
  return { cols: BASKET_COLS.map(([, zh]) => zh), blocks }
}

/**
 * 篮球分节比分：`utils/data.js` 的实时补丁会把上游的 linescores 挂到比赛对象的
 * `linescores` 上（`{h:[...], a:[...]}`）。这里整理成「表头 + 两队两行」。
 *
 * ⚠️ 列数不写死：常规赛 4 节，加时会多出 1~2 列，直接按最长那队的节数生成表头。
 * ⚠️ 只认篮球 —— 足球没有 linescores，`hasQuarters` 为 false 时整块隐藏。
 */
function buildQuarters(match, sideName) {
  const ls = match && match.linescores
  if (!ls || !(ls.h || []).length || !(ls.a || []).length) return null
  const n = Math.max(ls.h.length, ls.a.length)
  const cols = []
  for (let i = 0; i < n; i += 1) cols.push(i < 4 ? `第${i + 1}节` : `加时${i - 3}`)
  const pad = (arr) => {
    const out = []
    for (let i = 0; i < n; i += 1) out.push(i < arr.length ? String(arr[i]) : '-')
    return out
  }
  return {
    cols,
    rows: [
      { side: sideName('home'), scores: pad(ls.h) },
      { side: sideName('away'), scores: pad(ls.a) },
    ],
  }
}


/**
 * 把云端详情整理成页面直接可用的形状。
 *
 * 两处需要算而不能直出：
 *  ① 换人事件一场能有 8~10 条，全铺开会比进球/牌多几倍，默认折叠掉。
 *  ② 技术统计的对比条要归一化到 100：计数类（射门）按占比分，
 *     百分比类（控球率、传球成功率）用主队值，客队补 100-h —— 否则两条加起来
 *     超过 100 会把容器撑破。
 */
function decorateDetail(d, match) {
  const sideName = (side) => (match[side] && (match[side].zhName || match[side].name)) || ''
  // ⚠️ 必须把队名拼进类型 —— 光有圆点颜色分不出主客（两队队服常同色系），
  //    用户真机反馈「进球只有球员名，不知道是哪个队」
  const events = (d.events || []).map((e, i) => {
    const teamName = e.side ? sideName(e.side) : ''
    return {
      idx: i,
      m: e.m,
      t: e.t,
      s: e.s,
      side: e.side,
      teamName,
      tLabel: e.t + (teamName ? ` · ${teamName}` : ''),
      goal: !!e.goal,
      key: e.t !== '换人',
    }
  })
  const keyEvents = events.filter((e) => e.key)
  // 对比条：两边都从中间往外长，**值大的那边占满自己那一半**，小的按比例缩。
  // 用「值 / 最大值」而不是「值 / 总和」—— 这样控球率 53.7/46.3 和射门 12/19
  // 看起来是同一种语义（谁强谁满），不会出现 54%+46% 两边都半截的怪相。
  const stats = (d.stats || []).map((s) => {
    const hs = String(s.h)
    const as = String(s.a)
    const h = parseFloat(hs.replace('%', '')) || 0
    const a = parseFloat(as.replace('%', '')) || 0
    const max = Math.max(h, a, 1)
    const hp = Math.round((h / max) * 100)
    const ap = Math.round((a / max) * 100)
    return { k: s.k, h: hs, a: as, hp, ap }
  })
  const formRows = ['home', 'away']
    .map((side) => ({
      idx: side,
      side: sideName(side),
      list: ((d.form && d.form[side]) || []).map((g, i) => ({
        i,
        at: g.at,
        opp: g.opp,
        sc: g.sc,
        r: g.r,
        rText: RESULT_ZH[g.r] || '',
      })),
    }))
    .filter((r) => r.list.length)
  const h2h = d.h2h
    ? Object.assign({}, d.h2h, {
        list: (d.h2h.list || []).map((e, i) => Object.assign({ i }, e)),
      })
    : null
  const lineups = buildLineups(d, sideName)
  const box = buildBox(d, sideName)
  const quarters = buildQuarters(match, sideName)
  const kpl = kplView.buildKpl(d, sideName('home'), sideName('away'))
  return {
    // 赛前预览：未开赛的比赛只有「近况 + 交锋」两块（ESPN 这时也给不出事件和统计）。
    // 没有它的话用户会以为详情页坏了 —— 得显式说明赛后会换成什么。
    isPre: match.status === 'upcoming',
    events,
    keyEvents,
    shownEvents: keyEvents,
    subCount: events.length - keyEvents.length,
    hasTimeline: events.length > 0,
    stats,
    hasStats: stats.length > 0,
    lineups,
    hasLineups: !!lineups,
    box,
    hasBox: !!box,
    quarters,
    hasQuarters: !!quarters,
    kpl,
    hasKpl: !!kpl,
    formRows,
    hasForm: formRows.length > 0,
    h2h,
    hasH2H: !!(h2h && h2h.list && h2h.list.length),
  }
}

Page({
  data: {
    match: null,
    comp: null,
    rows: [],
    isFav: false,
    favBusy: false,
    authState: 'unknown',
    hasStandings: false,  // 该赛事有没有积分榜（有才显示入口）
    detail: null,        // 比赛详情（事件时间轴 / 近况 / 交锋 / 技术统计），没有就整块隐藏
    detailAll: false,    // 是否展开换人事件
    shareImage: '',      // 转发卡图（离屏 canvas 画好后存这里）
    loading: false,
    loadError: '',
  },

  /**
   * ⚠️ 从分享卡片进来时，本地包里的比分几乎一定是过期的 —— 比分每 15 分钟由
   *   同步任务写进云端，而 data/matches.js 是发版那一刻的快照。
   *   以前这里只读本地包，结果别人点开分享看到的是「还没比分」的比赛。
   *   现在改成：本地先落地渲染（秒开），再拉一次云端并重新渲染。
   */
  async onLoad(query) {
    const id = query && query.id ? decodeURIComponent(query.id) : ''
    this.matchId = id

    // 1) 本地有的先渲染 —— 不等网络，点开分享立刻能看到内容
    const raw = data.findMatch(id)
    if (raw) {
      this.applyMatch(raw)
    } else {
      this.setData({ loading: true })
    }

    // 2) 再拉云端补最新比分（本地包是发版那一刻的快照，比分一定落后）。
    //    加超时兜底：网络差的时侯不能让页面一直停在加载态，本地数据已经渲染出来了，够了。
    const r = await Promise.race([
      data.refresh(),
      new Promise((resolve) => setTimeout(() => resolve({ updated: false, reason: 'timeout' }), 6000)),
    ])
    if (r && r.updated) {
      const fresh = data.findMatch(id)
      if (fresh) this.applyMatch(fresh)
    }
    if (!this.data.match) {
      this.setData({
        loading: false,
        loadError: '找不到这场比赛，它可能已经从赛程里下架了。',
      })
    }
  },

  /**
   * 比赛详情：独立于主流程异步加载，拿不到就整块不显示。
   * 详情只覆盖「进行中 + 近 48 小时已结束」的比赛，老比赛本来就没有，这不是错误。
   */
  async loadDetail(match) {
    const raw = await data.matchDetail(match)
    if (!raw || !this.data.match || this.data.match.id !== match.id) return
    this.setData({ detail: decorateDetail(raw, match), detailAll: false })
  },

  onToggleSubs() {
    const d = this.data.detail
    if (!d) return
    const next = !this.data.detailAll
    this.setData({ 'detail.shownEvents': next ? d.events : d.keyEvents, detailAll: next })
  },

  /** 用一场比赛对象刷新整页（onLoad 与云端回补共用同一套逻辑） */
  applyMatch(raw) {
    const app = appInstance()
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
      loading: false,
      loadError: '',
      isFav: app.isFav(match.id),
      authState: app.globalData.authState,
      hasStandings: !!data.standingsOf(match.comp),
    }, () => {
      this.buildShareImage()
      this.loadDetail(match)
    })
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
    // 从后台切回来时同步一次：进行中的比分可能已经变了
    if (this.matchId) {
      data.refresh().then((r) => {
        if (!r || !r.updated) return
        const m2 = data.findMatch(this.matchId)
        if (m2 && m2 !== this.data.match) this.applyMatch(m2)
      })
      // 🔴 大表 15 分钟才刷一次，进行中的比赛得靠实时小表（60 秒）才跟得上
      data.refreshLive().then((r) => {
        if (!r || !r.patched) return
        const m2 = data.findMatch(this.matchId)
        if (m2 && m2 !== this.data.match) this.applyMatch(m2)
      })
    }
    if (!this.data.match) return
    this.setData({
      isFav: app.isFav(this.data.match.id),
      authState: app.globalData.authState,
    })
    this.syncLivePoll()
  },

  onHide() { this.stopLivePoll() },
  onUnload() { this.stopLivePoll() },

  /**
   * 详情页的比分轮询：**只有这场比赛正在进行中才起**定时器。
   * 用户点进一场 live 比赛就是想盯着看，60 秒一轮；比赛一结束（status 变 finished）就停。
   */
  syncLivePoll() {
    const m = this.data.match
    if (!m || m.status !== 'live') { this.stopLivePoll(); return }
    if (this.liveTimer) return
    this.startLivePoll()
  },

  startLivePoll() {
    if (this.liveTimer) return
    this.liveTimer = setInterval(() => {
      data.refreshLive(true).then((r) => {
        if (!r || !r.patched) return
        const m2 = data.findMatch(this.matchId)
        if (!m2) return
        this.applyMatch(m2)
        if (m2.status !== 'live') this.stopLivePoll()
      })
    }, LIVE_POLL_MS)
  },

  stopLivePoll() {
    if (!this.liveTimer) return
    clearInterval(this.liveTimer)
    this.liveTimer = null
  },

  /** 切换 KPL 单局 tab（数据一次全在 payload 里，切换是纯前端，零请求） */
  onKplRound(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const kpl = this.data.detail && this.data.detail.kpl
    if (!kpl || !kpl.rounds || !kpl.rounds[idx] || idx === kpl.active) return
    this.setData({ 'detail.kpl.active': idx })
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
  /** 点队名 → 球队详情页（排名 / 近期战绩 / 未来赛程） */
  onTeamTap(e) {
    const m = this.data.match
    if (!m) return
    const side = (e.currentTarget.dataset || {}).side
    const team = side === 'home' ? m.home : m.away
    // 未确定的对阵（待定 / TBD）不是一支球队，点了也没东西可看
    if (!team || !team.id || String(team.id) === 'TBD' || team.name === '待定') return
    wx.navigateTo({
      url: `/pages/team/team?comp=${encodeURIComponent(m.comp)}&id=${encodeURIComponent(String(team.id))}`,
      fail() {
        wx.showToast({ title: '暂时打不开球队页', icon: 'none' })
      },
    })
  },

  onStandingsTap() {
    const m = this.data.match
    if (!m) return
    // ⚠️ 积分榜是 tabBar 页面，navigateTo 会静默失败，必须走 nav.toRank
    nav.toRank(m.comp)
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

module.exports = { decorateDetail, buildLineups, buildBox, buildQuarters, BASKET_COLS }
