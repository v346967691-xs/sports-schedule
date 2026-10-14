const share = require('../../utils/share')
const poster = require('../../utils/poster')
const data = require('../../utils/data')
const lolView = require('../../utils/lol-view')
const view = require('../../utils/view')
const fmt = require('../../utils/format')
const favorites = require('../../utils/favorites')
const notificationConfig = require('../../utils/match-notification-config')
const notifications = require('../../utils/match-notifications')
const nav = require('../../utils/nav')
const { appInstance } = require('../../utils/app-instance')
const kplView = require('../../utils/kpl-view')
const lolMvpVote = require('../../utils/lol-mvp')
const matchMvpVote = require('../../utils/match-mvp')
const matchMvpView = require('../../utils/match-mvp-view')

const RESULT_ZH = { W: '胜', D: '平', L: '负' }

/** 实时比分轮询间隔（与赛程页同值，服务端 live_scores 也是 60 秒刷一次） */
const LIVE_POLL_MS = 60 * 1000

/** 电竞分享标题把战队与选手 ID 连写，避免缩略卡上难以辨认归属。 */
function mvpShareName(match, candidate) {
  const name = String(candidate && candidate.name || '').trim()
  const team = String(candidate && candidate.team || '').trim()
  if (!name || !team || !match || data.compOf(match.comp).cat !== 'esports') return name
  const player = name.startsWith(`${team}.`) ? name.slice(team.length + 1)
    : name.startsWith(`${team} `) ? name.slice(team.length + 1) : name
  return player ? `${team}.${player}` : name
}

function notificationAvailability(match) {
  const start = Date.parse(match && match.start || '')
  const upcoming = !!match && match.status === 'upcoming' && Number.isFinite(start)
  return {
    canRequestPre15: upcoming && start > Date.now(),
    canRequestPre60: upcoming && start > Date.now() + 15 * 60 * 1000,
  }
}

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
  const lol = lolView.buildLol(d, sideName('home'), sideName('away'))
  const lolMvpCandidates = lolView.buildMvpCandidates(d, sideName('home'), sideName('away'))
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
    lol,
    hasLol: !!lol,
    matchMvp: matchMvpView.build(d, match),
    lolMvp: {
      available: match.comp !== 'kpl' && match.status === 'finished'
        && !!(d.lol && d.lol.complete) && lolMvpCandidates.length > 1,
      enabled: false,
      candidates: lolMvpCandidates,
      positions: lolView.buildMvpMatchups(lolMvpCandidates),
      homeLabel: sideName('home'),
      awayLabel: sideName('away'),
      sharedKey: '',
      myVote: '',
      totalVotes: 0,
      leaderSummary: '暂无选手得票',
    },
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
    notificationStates: {},
    notificationBusy: false,
    authState: 'unknown',
    hasStandings: false,  // 该赛事有没有积分榜（有才显示入口）
    detail: null,        // 比赛详情（事件时间轴 / 近况 / 交锋 / 技术统计），没有就整块隐藏
    detailAll: false,    // 是否展开换人事件
    shareImage: '',      // 转发卡图（离屏 canvas 画好后存这里）
    lolMvpShareImage: '',
    mvpVoteBusy: false,
    mvpPosterBusy: false,
    matchMvpShareImage: '',
    matchMvpVoteBusy: false,
    matchMvpPosterBusy: false,
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
    try {
      this.sharedMvpKey = query && query.mvp ? decodeURIComponent(String(query.mvp)) : ''
    } catch (error) {
      this.sharedMvpKey = ''
    }

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
    if (!this.data.match || !data.findMatch(id)) {
      const archived = await Promise.race([
        data.findArchivedMatch(id),
        new Promise(resolve => setTimeout(() => resolve(null), 6000)),
      ])
      if (archived) this.applyMatch(archived)
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
   * 普通赛事保持原保留窗口；Worlds2026 日桶保留到决赛后 30 天。
   */
  async loadDetail(match) {
    if (Date.now() - (this.detailReadAt || 0) < 3 * 60000) return
    this.detailReadAt = Date.now()
    const raw = await data.matchDetail(match)
    if (!raw || !this.data.match || this.data.match.id !== match.id) return
    const detail = decorateDetail(raw, match)
    if (detail.matchMvp) detail.matchMvp = matchMvpView.build(raw, match, this.sharedMvpKey)
    if (detail.lolMvp) {
      detail.lolMvp.sharedKey = this.sharedMvpKey
      detail.lolMvp.candidates = detail.lolMvp.candidates.map(candidate => Object.assign({}, candidate, {
        isShared: this.sharedMvpKey === candidate.key,
      }))
    }
    this.setData({ detail, detailAll: false }, () => {
      if (detail.lolMvp && detail.lolMvp.available) this.refreshLolMvpSummary(match.id)
      if (detail.matchMvp) this.refreshMatchMvpSummary(match.id)
    })
    const kplReady = match.comp !== 'kpl' || !!(raw.kpl && (raw.kpl.list || []).length > 0
      && raw.kpl.list.length >= Number(match.home.score || 0) + Number(match.away.score || 0))
    const lolReady = data.compOf(match.comp).cat !== 'esports' || match.comp === 'kpl' || !!(raw.lol && raw.lol.complete)
    const expectsMatchMvp = match.comp === 'nba' || match.comp === 'kpl' || data.compOf(match.comp).cat === 'football'
    this.finalDetailReady = raw.fin === true && kplReady && lolReady && (!expectsMatchMvp || !!detail.matchMvp)
    this.syncLivePoll()
  },

  onToggleSubs() {
    const d = this.data.detail
    if (!d) return
    const next = !this.data.detailAll
    this.setData({ 'detail.shownEvents': next ? d.events : d.keyEvents, detailAll: next })
  },

  /** 用一场比赛对象刷新整页（onLoad 与云端回补共用同一套逻辑） */
  applyMatch(raw) {
    const changedToFinished = this.data.match && this.data.match.status !== 'finished' && raw.status === 'finished'
    if (changedToFinished) this.detailReadAt = 0
    if (raw.status === 'finished' && raw.comp !== 'cba' && !this.detailPollUntil
      && Date.now() - Date.parse(raw.start) < 48 * 3600000) this.detailPollUntil = Date.now() + 20 * 60000
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
      canRequestPre15: notificationAvailability(match).canRequestPre15,
      canRequestPre60: notificationAvailability(match).canRequestPre60,
    }, () => {
      this.buildShareImage()
      this.loadDetail(match)
      this.loadNotificationStates(match)
      this.syncLivePoll()
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
    this.liveVisible = true
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
    this.loadDetail(this.data.match)
    this.setData({
      isFav: app.isFav(this.data.match.id),
      authState: app.globalData.authState,
      canRequestPre15: notificationAvailability(this.data.match).canRequestPre15,
      canRequestPre60: notificationAvailability(this.data.match).canRequestPre60,
    })
    this.loadNotificationStates(this.data.match)
    if (this.data.detail && this.data.detail.lolMvp && this.data.detail.lolMvp.available) {
      this.refreshLolMvpSummary(this.data.match.id)
    }
    if (this.data.detail && this.data.detail.matchMvp) this.refreshMatchMvpSummary(this.data.match.id)
    this.syncLivePoll()
  },

  onHide() { this.liveVisible = false; this.stopLivePoll() },
  onUnload() { this.liveVisible = false; this.stopLivePoll() },

  /**
   * 详情页的比分轮询：**只有这场比赛正在进行中才起**定时器。
   * 用户点进一场 live 比赛就是想盯着看，60 秒一轮；比赛一结束（status 变 finished）就停。
   */
  syncLivePoll() {
    const m = this.data.match
    if (!this.liveVisible || !m || (m.status === 'finished'
      && (this.finalDetailReady || Date.now() >= (this.detailPollUntil || 0)))) { this.stopLivePoll(); return }
    if (this.liveTimer) return
    this.startLivePoll()
  },

  startLivePoll() {
    if (this.liveTimer) return
    this.liveTimer = setInterval(() => {
      const current = this.data.match
      if (current && current.status === 'finished') {
        this.loadDetail(current)
        this.syncLivePoll()
        return
      }
      if (!current || !data.needsLivePoll(current)) return
      data.refreshLive(true).then((r) => {
        if (!r || !r.patched) return
        const m2 = data.findMatch(this.matchId)
        if (!m2) return
        this.applyMatch(m2)
        this.syncLivePoll()
      })
    }, LIVE_POLL_MS)
  },

  stopLivePoll() {
    if (!this.liveTimer) return
    clearInterval(this.liveTimer)
    this.liveTimer = null
  },

  onLolRound(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const lol = this.data.detail && this.data.detail.lol
    if (lol && lol.rounds[idx]) this.setData({ 'detail.lol.active': idx })
  },

  onLolHeroError(e) {
    const { round, row, side } = e.currentTarget.dataset
    const r = Number(round), p = Number(row), s = Number(side)
    if (![r, p, s].every(i => Number.isInteger(i) && i >= 0)) return
    const lol = this.data.detail && this.data.detail.lol
    const player = lol && lol.rounds[r] && lol.rounds[r].rows[p] && lol.rounds[r].rows[p].players[s]
    if (player && player.icon) this.setData({ [`detail.lol.rounds[${r}].rows[${p}].players[${s}].icon`]: '' })
  },

  async refreshLolMvpSummary(matchId) {
    if (this.mvpSummaryBusy) return
    this.mvpSummaryBusy = true
    const res = await lolMvpVote.summary(matchId)
    this.mvpSummaryBusy = false
    if (!this.data.match || this.data.match.id !== matchId || !this.data.detail
      || !this.data.detail.lolMvp || !this.data.detail.lolMvp.available) return
    if (res.error) {
      console.warn('[LOL MVP] 投票汇总暂不可用', res.error.message)
      return
    }
    const rows = res.data || []
    this.setData({ 'detail.lolMvp.enabled': true })
    const mine = rows.find(row => row.is_mine)
    const counts = {}
    rows.forEach(row => { counts[row.player_id] = Number(row.vote_count) || 0 })
    const candidates = this.data.detail.lolMvp.candidates.map(candidate => Object.assign({}, candidate, {
      votes: counts[candidate.key] || 0,
      isMine: !!(mine && mine.player_id === candidate.key),
      isShared: this.sharedMvpKey === candidate.key,
    }))
    const myVote = mine ? mine.player_id : ''
    const totalVotes = rows.length ? Number(rows[0].total_votes) || 0 : 0
    const leaderVotes = candidates.reduce((max, candidate) => Math.max(max, candidate.votes), 0)
    const leaders = leaderVotes ? candidates.filter(candidate => candidate.votes === leaderVotes) : []
    const leaderNames = leaders.slice(0, 2).map(candidate => candidate.name).join(' / ')
    const leaderSummary = leaderVotes
      ? `${leaderNames}${leaders.length > 2 ? ' 等' : ''} · ${leaderVotes} 票${leaders.length > 1 ? '（并列）' : ''}`
      : '暂无选手得票'
    this.setData({
      'detail.lolMvp.candidates': candidates,
      'detail.lolMvp.positions': lolView.buildMvpMatchups(candidates),
      'detail.lolMvp.myVote': myVote,
      'detail.lolMvp.totalVotes': totalVotes,
      'detail.lolMvp.leaderSummary': leaderSummary,
    })
    if (myVote) {
      const candidate = candidates.find(item => item.key === myVote)
      if (candidate) {
        this.mvpShareCandidate = candidate
        this.buildLolMvpShareImage(candidate)
      }
    }
  },

  async onLolMvpVote(e) {
    if (this.mvpVoteBusy) return
    const key = e.currentTarget.dataset.key
    const mvp = this.data.detail && this.data.detail.lolMvp
    const candidate = mvp && mvp.candidates.find(item => item.key === key)
    if (!mvp || !mvp.available || !candidate) return
    if (mvp.myVote) {
      wx.showToast({ title: '本场已投票，不能修改', icon: 'none' })
      return
    }

    const app = appInstance()
    if (app.globalData.authState !== 'signed-in') {
      await app.refreshAuth()
      this.setData({ authState: app.globalData.authState })
    }
    if (app.globalData.authState !== 'signed-in') {
      const unavailable = app.globalData.authState === 'unavailable'
      wx.showModal({
        title: unavailable ? '云服务未就绪' : '登录后参与投票',
        content: unavailable
          ? '投票需要云服务支持，请在开发者工具中执行「构建 npm」后重新预览。'
          : '每个账号在这场系列赛中只能投 1 票，投出后不能修改。要现在去登录吗？',
        confirmText: unavailable ? '知道了' : '去登录',
        cancelText: unavailable ? undefined : '稍后',
        showCancel: !unavailable,
        success: (res) => { if (!unavailable && res.confirm) wx.switchTab({ url: '/pages/mine/mine' }) },
      })
      return
    }

    this.mvpVoteBusy = true
    this.setData({ mvpVoteBusy: true })
    const result = await lolMvpVote.vote(this.data.match.id, this.data.match.start, candidate.key)
    this.mvpVoteBusy = false
    this.setData({ mvpVoteBusy: false })
    if (result.error) {
      if (String(result.error.code || '').indexOf('23505') >= 0) {
        await this.refreshLolMvpSummary(this.data.match.id)
        wx.showToast({ title: '本场已投票，不能修改', icon: 'none' })
        return
      }
      wx.showToast({ title: result.error.code === '42P01' || result.error.code === '42883' || result.error.code === 'PGRST202'
        ? '投票服务尚未启用' : result.error.message, icon: 'none' })
      return
    }
    this.sharedMvpKey = ''
    this.mvpShareCandidate = candidate
    this.setData({ lolMvpShareImage: '', 'detail.lolMvp.myVote': candidate.key })
    this.buildLolMvpShareImage(candidate)
    await this.refreshLolMvpSummary(this.data.match.id)
    wx.showToast({ title: '已记录你的 MVP 选择', icon: 'success' })
  },

  async buildLolMvpShareImage(candidate) {
    if (!candidate) return
    if (this.mvpShareImageBusy) {
      this.mvpPendingShareCandidate = candidate
      return
    }
    this.mvpShareImageBusy = true
    const comp = this.data.comp || {}
    const img = await poster.build(this, 'share-canvas', 'lol-mvp', {
      comp: comp.full || comp.name || 'LOL',
      name: candidate.name,
      team: candidate.team,
      champions: candidate.champions,
      games: candidate.games,
      k: candidate.k, d: candidate.d, a: candidate.a,
      cs: candidate.cs, gold: candidate.gold,
      accent: comp.accent || '#B99433',
    })
    this.mvpShareImageBusy = false
    if (img && this.mvpShareCandidate && this.mvpShareCandidate.key === candidate.key) {
      this.setData({ lolMvpShareImage: img })
    }
    const pending = this.mvpPendingShareCandidate
    this.mvpPendingShareCandidate = null
    if (pending && pending.key !== candidate.key) this.buildLolMvpShareImage(pending)
  },

  async refreshMatchMvpSummary(matchId) {
    if (this.matchMvpSummaryBusy) { this.matchMvpSummaryPending = matchId; return }
    const revision = this.matchMvpVoteRevision || 0
    this.matchMvpSummaryBusy = true
    const res = await matchMvpVote.summary(matchId)
    this.matchMvpSummaryBusy = false
    const pending = this.matchMvpSummaryPending
    this.matchMvpSummaryPending = ''
    // 投票前发出的汇总不能覆盖投票成功后的已投状态；补取新汇总。
    if (revision !== (this.matchMvpVoteRevision || 0)) return this.refreshMatchMvpSummary(pending || matchId)
    const mvp = this.data.detail && this.data.detail.matchMvp
    if (!mvp || !this.data.match || this.data.match.id !== matchId) return
    if (res.error) {
      if (!mvp.enabled) this.setData({ 'detail.matchMvp.leaderSummary': '票数暂不可用，点击重试' })
      return
    }
    const next = matchMvpView.withSummary(mvp, res.data || [], this.sharedMvpKey)
    this.setData({ 'detail.matchMvp': next })
    const candidate = next.candidates.find(p => p.key === next.myVote)
    if (candidate) {
      this.matchMvpShareCandidate = candidate
      this.buildMatchMvpShareImage(candidate)
    } else {
      this.matchMvpShareCandidate = null
      this.setData({ matchMvpShareImage: '' })
    }
    if (pending) await this.refreshMatchMvpSummary(pending)
  },

  retryMatchMvpSummary() {
    if (this.data.match) this.refreshMatchMvpSummary(this.data.match.id)
  },

  async onMatchMvpVote(e) {
    if (this.data.matchMvpVoteBusy) return
    const mvp = this.data.detail && this.data.detail.matchMvp
    const match = this.data.match
    const candidate = mvp && mvp.candidates.find(p => p.key === e.currentTarget.dataset.key)
    if (!mvp || !candidate || !match) return
    if (mvp.myVote) { wx.showToast({ title: '本场已投票，不能修改', icon: 'none' }); return }
    if (!mvp.enabled) { this.retryMatchMvpSummary(); wx.showToast({ title: '正在读取票数，请稍后重试', icon: 'none' }); return }
    const app = appInstance()
    if (app.globalData.authState !== 'signed-in') await app.refreshAuth()
    if (app.globalData.authState !== 'signed-in') {
      wx.showModal({ title: '登录后参与投票', content: '每个账号每场仅能投 1 票，投出后不可更改。要现在去登录吗？',
        confirmText: '去登录', cancelText: '稍后',
        success: res => { if (res.confirm) wx.switchTab({ url: '/pages/mine/mine' }) },
      })
      return
    }
    this.setData({ matchMvpVoteBusy: true })
    let result
    try { result = await matchMvpVote.vote(match.id, match.start, candidate.key) }
    finally { this.setData({ matchMvpVoteBusy: false }) }
    if (!this.data.match || this.data.match.id !== match.id) return
    if (result.error) {
      if (String(result.error.code).includes('23505')) {
        this.matchMvpVoteRevision = (this.matchMvpVoteRevision || 0) + 1
        await this.refreshMatchMvpSummary(match.id)
        wx.showToast({ title: '本场已投票，不能修改', icon: 'none' })
      } else wx.showToast({ title: result.error.message || '投票失败，请重试', icon: 'none' })
      return
    }
    this.sharedMvpKey = ''
    this.matchMvpVoteRevision = (this.matchMvpVoteRevision || 0) + 1
    this.matchMvpShareCandidate = candidate
    const next = { ...mvp, myVote: candidate.key, candidates: mvp.candidates.map(p => ({ ...p, isMine: p.key === candidate.key, isShared: false })) }
    next.positions = matchMvpView.matchups(next.candidates)
    this.setData({ 'detail.matchMvp': next, matchMvpShareImage: '' })
    this.buildMatchMvpShareImage(candidate)
    await this.refreshMatchMvpSummary(match.id)
    wx.showToast({ title: '已记录你的 MVP 选择', icon: 'success' })
  },

  async buildMatchMvpShareImage(candidate) {
    if (!this.data.match || !candidate) return
    if (this.matchMvpShareBusy) { this.matchMvpPendingShareCandidate = candidate; return }
    const matchId = this.data.match.id
    this.matchMvpShareBusy = true
    try {
      const comp = this.data.comp || {}
      const img = await poster.build(this, 'share-canvas', 'match-mvp', {
        comp: comp.full || comp.name, name: candidate.name, team: candidate.team, role: candidate.role, stats: candidate.stats,
      })
      if (img && this.data.match && this.data.match.id === matchId && this.matchMvpShareCandidate
        && this.matchMvpShareCandidate.key === candidate.key) this.setData({ matchMvpShareImage: img })
    } finally {
      this.matchMvpShareBusy = false
      const pending = this.matchMvpPendingShareCandidate
      this.matchMvpPendingShareCandidate = null
      if (pending && pending.key !== candidate.key && this.matchMvpShareCandidate
        && this.matchMvpShareCandidate.key === pending.key) this.buildMatchMvpShareImage(pending)
    }
  },

  async generateMatchMvpPoster() {
    if (this.data.matchMvpPosterBusy) return
    const match = this.data.match
    const mvp = this.data.detail && this.data.detail.matchMvp
    const candidate = mvp && mvp.candidates.find(p => p.key === mvp.myVote)
    if (!match || !candidate) { wx.showToast({ title: '请先投出你的 MVP 选择', icon: 'none' }); return }
    this.setData({ matchMvpPosterBusy: true })
    try {
      const comp = this.data.comp || {}
      const path = await poster.build(this, 'mvp-long-canvas', 'match-mvp-long', {
        comp: comp.full || comp.name, kind: mvp.kind,
        home: view.nameOf(match.home), away: view.nameOf(match.away), homeScore: match.home.score, awayScore: match.away.score,
        dateText: match.date, timeText: match.time, name: candidate.name, team: candidate.team, role: candidate.role,
        stats: candidate.stats, champions: candidate.champions, note: mvp.note,
      })
      if (!path) throw new Error('长图生成失败，请重试')
      if (this.data.match && this.data.match.id === match.id) wx.previewImage({ current: path, urls: [path] })
    } catch (error) { wx.showToast({ title: error.message || '长图生成失败，请重试', icon: 'none' }) }
    finally { this.setData({ matchMvpPosterBusy: false }) }
  },

  async generateLolMvpPoster() {
    if (this.data.mvpPosterBusy) return
    const match = this.data.match
    const mvp = this.data.detail && this.data.detail.lolMvp
    const candidate = mvp && mvp.candidates.find(item => item.key === mvp.myVote)
    if (!match || !candidate) {
      wx.showToast({ title: '请先投出你的 MVP 选择', icon: 'none' })
      return
    }
    const comp = this.data.comp || {}
    this.setData({ mvpPosterBusy: true })
    try {
      const path = await poster.build(this, 'mvp-long-canvas', 'lol-mvp-long', {
        comp: comp.full || comp.name || 'LOL',
        home: view.nameOf(match.home), away: view.nameOf(match.away),
        homeScore: match.home.score, awayScore: match.away.score,
        dateText: match.date, timeText: match.time,
        name: candidate.name, team: candidate.team, role: candidate.role,
        champions: candidate.champions, games: candidate.games,
        k: candidate.k, d: candidate.d, a: candidate.a, cs: candidate.cs, gold: candidate.gold,
      })
      if (!path) throw new Error('长图生成失败，请重试')
      if (!this.data.match || this.data.match.id !== match.id) return
      wx.previewImage({ current: path, urls: [path] })
    } catch (error) {
      wx.showToast({ title: error.message || '长图生成失败，请重试', icon: 'none' })
    } finally { this.setData({ mvpPosterBusy: false }) }
  },

  /** 切换 KPL 单局 tab（数据一次全在 payload 里，切换是纯前端，零请求） */
  onKplRound(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const kpl = this.data.detail && this.data.detail.kpl
    if (!kpl || !kpl.rounds || !kpl.rounds[idx] || idx === kpl.active) return
    this.setData({ 'detail.kpl.active': idx })
  },

  async loadNotificationStates(match) {
    if (!match || !appInstance().isFav(match.id)) {
      this.setData({ notificationStates: {} })
      return
    }
    const result = await notifications.states(match.id)
    if (!this.data.match || this.data.match.id !== match.id) return
    // 🔴 读不到状态时必须**清空**，不能保留上一次的结果：微信不提供「剩余下发次数」
    //    查询接口，本地这张表是唯一可信来源。留着旧值会把「其实已经拿不到授权
    //    （额度耗尽/被拒）」的通知继续显示成「已订阅」。
    if (result.error) {
      this.setData({ notificationStates: {} })
      return
    }
    const states = {}
    ;(result.data || []).forEach((row) => { states[row.kind] = row.status })
    this.setData({ notificationStates: states })
  },

  onFavTap() {
    const app = appInstance()
    if (this.data.favBusy) return
    if (app.globalData.authState !== 'signed-in') {
      if (app.globalData.authState === 'unknown') {
        app.refreshAuth().then(() => {
          this.setData({ authState: app.globalData.authState })
          wx.showToast({ title: app.globalData.authState === 'signed-in' ? '登录状态已就绪，请再点一次关注' : '请先登录后关注比赛', icon: 'none' })
        })
        return
      }
      if (app.globalData.authState === 'unavailable') {
        wx.showModal({ title: '云服务未就绪', content: '关注功能需要云服务支持，请检查小程序云服务配置。', showCancel: false })
        return
      }
      wx.showModal({
        title: '需要登录',
        content: '登录后才能把比赛收藏到「我的」，并设置赛前与赛果通知。',
        confirmText: '去登录',
        cancelText: '稍后',
        success: (res) => { if (res.confirm) wx.switchTab({ url: '/pages/mine/mine' }) },
      })
      return
    }
    const match = this.data.match
    if (!match) return
    this.setData({ favBusy: true })
    if (this.data.isFav) {
      favorites.remove(match.id).then(async (res) => {
        if (res.error) wx.showToast({ title: res.error.message, icon: 'none' })
        else {
          await notifications.cancel(match.id)
          wx.showToast({ title: '已取消关注和待发送通知', icon: 'success' })
        }
        await app.refreshFavorites()
        this.setData({ isFav: app.isFav(match.id), favBusy: false })
        this.loadNotificationStates(match)
      }).catch(() => this.setData({ favBusy: false }))
    } else {
      const requestedKinds = notificationConfig.kindsFor(match)
      // 🔴 按模板 ID 去重：一次 requestSubscribeMessage 里同一个模板只算**一次**授权，
      //    而一次 kickoff 授权只够发一条消息（pre60 与 pre15 共用该模板）。
      const templateIds = Array.from(new Set(requestedKinds.map((kind) => notificationConfig.templateId(kind))))
      const finishAdd = async (acceptedKinds) => {
        try {
          const res = await favorites.add(match)
          if (res.error) wx.showToast({ title: res.error.message, icon: 'none' })
          else {
            let notice = '已加入关注'
            let noticeIcon = 'success'
            if (acceptedKinds.length) {
              const saved = await notifications.subscribe(match.id, acceptedKinds)
              if (saved.error) {
                notice = '比赛已关注，通知未保存，请重试'
                noticeIcon = 'none'
              } else notice = '已关注并设置通知'
            }
            wx.showToast({ title: notice, icon: noticeIcon })
          }
        } catch (error) {
          wx.showToast({ title: error && error.message || '关注失败，请重试', icon: 'none' })
        } finally {
          await app.refreshFavorites().catch(() => {})
          this.setData({ isFav: app.isFav(match.id), favBusy: false })
          this.loadNotificationStates(match)
        }
      }
      if (!templateIds.length || typeof wx.requestSubscribeMessage !== 'function') {
        finishAdd([])
        return
      }
      // This API must run directly in the user's tap handler for WeChat to show consent.
      wx.requestSubscribeMessage({
        tmplIds: templateIds,
        success: (result) => {
          const accepted = []
          if (requestedKinds.includes('pre15') && result[notificationConfig.templateId('pre15')] === 'accept') accepted.push('pre15')
          if (requestedKinds.includes('result') && result[notificationConfig.templateId('result')] === 'accept') accepted.push('result')
          finishAdd(accepted)
        },
        fail: () => finishAdd([]),
      })
    }
  },

  onNotificationTap() {
    const match = this.data.match
    if (!match || !this.data.isFav || this.data.notificationBusy) return
    const states = this.data.notificationStates || {}
    // 🔴 同一次授权里**一个模板只能换一条下发额度**。pre60 与 pre15 共用 kickoff 模板，
    //    两者若在同一次申请里一起提交，必然有一个拿不到额度 —— 那就会变成
    //    「显示已订阅、实际发不出去」。这里按模板收敛，pre15 优先；pre60 走
    //    单独的「加一轮」入口再授权一次。
    const seenTemplates = new Set()
    const kinds = []
    notificationConfig.kindsFor(match).forEach((kind) => {
      if (states[kind]) return
      const templateId = notificationConfig.templateId(kind)
      if (seenTemplates.has(templateId)) return
      seenTemplates.add(templateId)
      kinds.push(kind)
    })
    if (!kinds.length) { wx.showToast({ title: '当前可用通知均已设置', icon: 'none' }); return }
    const templateIds = Array.from(new Set(kinds.map((kind) => notificationConfig.templateId(kind))))
    if (typeof wx.requestSubscribeMessage !== 'function') { wx.showToast({ title: '当前微信版本暂不支持订阅消息', icon: 'none' }); return }
    this.setData({ notificationBusy: true })
    const done = () => this.setData({ notificationBusy: false })
    wx.requestSubscribeMessage({
      tmplIds: templateIds,
      success: async (result) => {
        const accepted = kinds.filter((kind) => result[notificationConfig.templateId(kind)] === 'accept')
        if (!accepted.length) { done(); wx.showToast({ title: '尚未授权通知', icon: 'none' }); return }
        const saved = await notifications.subscribe(match.id, accepted)
        done()
        if (saved.error) { wx.showToast({ title: saved.error.message, icon: 'none' }); return }
        wx.showToast({ title: '通知已设置', icon: 'success' })
        this.loadNotificationStates(match)
      },
      fail: (error) => { done(); wx.showToast({ title: error && error.errMsg || '订阅失败，请重试', icon: 'none' }) },
    })
  },

  onExtraPreReminderTap() {
    const match = this.data.match
    if (!match || !this.data.isFav || match.status !== 'upcoming' || !notificationAvailability(match).canRequestPre60 || this.data.notificationBusy) return
    if (this.data.notificationStates && this.data.notificationStates.pre60) { wx.showToast({ title: '开赛前1小时提醒已设置', icon: 'none' }); return }
    const templateId = notificationConfig.templateId('pre60')
    if (typeof wx.requestSubscribeMessage !== 'function') { wx.showToast({ title: '当前微信版本暂不支持订阅消息', icon: 'none' }); return }
    this.setData({ notificationBusy: true })
    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: async (result) => {
        if (result[templateId] !== 'accept') { this.setData({ notificationBusy: false }); wx.showToast({ title: '尚未授权1小时提醒', icon: 'none' }); return }
        const saved = await notifications.subscribe(match.id, ['pre60'])
        this.setData({ notificationBusy: false })
        if (saved.error) { wx.showToast({ title: saved.error.message, icon: 'none' }); return }
        wx.showToast({ title: '开赛前1小时提醒已设置', icon: 'success' })
        this.loadNotificationStates(match)
      },
      fail: (error) => { this.setData({ notificationBusy: false }); wx.showToast({ title: error && error.errMsg || '订阅失败，请重试', icon: 'none' }) },
    })
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

  onShareAppMessage(e) {
    const m = this.data.match
    if (!m) return share.message()
    const h = m.home.zhName || m.home.name
    const a = m.away.zhName || m.away.name
    if (e && e.target && e.target.dataset && e.target.dataset.kind === 'match-mvp' && this.matchMvpShareCandidate) {
      const candidate = this.matchMvpShareCandidate
      const stats = candidate.stats.slice(0, 3).map(s => `${s.label} ${s.value}`).join(' · ')
      return share.message({ title: `我选 ${mvpShareName(m, candidate)} 为本场 MVP${stats ? ` · ${stats}` : ''}`,
        path: `/pages/detail/detail?id=${encodeURIComponent(m.id)}&mvp=${encodeURIComponent(candidate.key)}`,
        imageUrl: this.data.matchMvpShareImage,
      })
    }
    const isMvp = e && e.target && e.target.dataset && e.target.dataset.kind === 'lol-mvp'
    const mvp = isMvp && this.mvpShareCandidate
    if (mvp) {
      return share.message({
        title: `我选 ${mvpShareName(m, mvp)} 为本场 MVP · ${mvp.k}/${mvp.d}/${mvp.a}`,
        path: `/pages/detail/detail?id=${encodeURIComponent(m.id)}&mvp=${encodeURIComponent(mvp.key)}`,
        imageUrl: this.data.lolMvpShareImage,
      })
    }
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
    if (this.matchMvpShareCandidate) {
      const candidate = this.matchMvpShareCandidate
      return share.timeline({ title: `我选 ${mvpShareName(m, candidate)} 为本场 MVP`,
        query: `id=${encodeURIComponent(m.id)}&mvp=${encodeURIComponent(candidate.key)}`, imageUrl: this.data.matchMvpShareImage })
    }
    const mvp = this.mvpShareCandidate
    if (mvp) {
      return share.timeline({
        title: `我选 ${mvpShareName(m, mvp)} 为本场 MVP · ${mvp.k}/${mvp.d}/${mvp.a}`,
        query: `id=${encodeURIComponent(m.id)}&mvp=${encodeURIComponent(mvp.key)}`,
        imageUrl: this.data.lolMvpShareImage,
      })
    }
    const hasScore = typeof m.home.score === 'number' && typeof m.away.score === 'number'
    const tail = hasScore ? `${m.home.score}-${m.away.score}` : 'VS'
    return share.timeline({
      title: `${h} ${tail} ${a}`,
      imageUrl: this.data.shareImage,
    })
  },
})

module.exports = { decorateDetail, buildLineups, buildBox, buildQuarters, BASKET_COLS }
