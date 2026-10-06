/**
 * 排行页（tabBar 第 3 项，2026-10-06 由「积分榜」改名）
 *
 * 数据来自 data/standings.js + data/scorers.js（本地兜底），
 * 云端 standings_cache / scorers_cache 打开即读覆盖。
 *
 * ⚠️ **档位按赛事大类给不同的集合**（2026-10-06 用户定：置灰体验不好，改成按类别给）：
 *    足球 = 积分榜 / 射手榜 / 助攻榜
 *    篮球 = 积分榜 + 得分榜 / 篮板榜 / 助攻榜 / 抢断榜 / 盖帽榜（有几张给几张）
 *    电竞 = 只有积分榜（LoL 各赛区），KPL 额外给「选手榜」
 *    拿不到数据的档位**直接不渲染**，不再置灰 —— 与「空赛事入口隐藏」同一约定。
 *
 * ⚠️ 每一档各自判断可用性，不能「有积分榜就假设有射手榜」（欧协联就没有球员榜）。
 *
 * ⚠️ 「选手榜」是 **KPL 专用**：这份数据只在云端（`kpl_rank` 表，
 *    见 utils/data.js 的 refreshKplRank），本地包里没有兜底。
 *    KPL 官方不给积分榜，所以它是 KPL 在这个页面的唯一入口 ——
 *    同理，赛事列表也不能只由 standingsKeys() 决定，要把有选手榜的赛事并进来。
 *
 * ⚠️ 这是页面层：新增 / 改动都要发版。
 */
const share = require('../../utils/share')
const data = require('../../utils/data')
const fmt = require('../../utils/format')
const { appInstance } = require('../../utils/app-instance')

/** 射手榜 / 助攻榜各显示多少名。上游每榜给 50 人，这里截前 N —— 再往后参考价值骤降 */
const SCORER_ROWS = 20

/**
 * 档位模板：按**大类**给不同的集合，再逐档按数据可用性过滤。
 *
 * ⚠️ `kind` 决定 WXML 走哪一套模板：
 *    standings 积分榜表 / scorer 足球球员榜 / leader 篮球数据榜 / players KPL 选手榜。
 * ⚠️ 篮球那几张数据榜**不写死在这里** —— 上游给几张就追加几张（见 tierDefs）。
 */
const TIER_PLAN = {
  football: [
    { key: 'standings', label: '积分榜', kind: 'standings' },
    { key: 'goals', label: '射手榜', kind: 'scorer' },
    { key: 'assists', label: '助攻榜', kind: 'scorer' },
  ],
  basketball: [
    // ⚠️ 篮球叫「球队榜」不叫「积分榜」（2026-10-06 用户定）：
    //    NBA / CBA 的排名看的是**胜率**不是积分，写「积分榜」名不副实。
    { key: 'standings', label: '球队榜', kind: 'standings' },
  ],
  esports: [
    { key: 'standings', label: '积分榜', kind: 'standings' },
  ],
}

/**
 * 把一行积分榜数据压成 WXML 能直接渲染的形状。
 *
 * 列是「合并式」的（胜/平/负 一个格子、进/失 一个格子），宽度让给队名 ——
 * 2026-10-02 用户反馈 8 列平铺时队名被折叠成两个字，体验差。
 * 这里的 key 必须与 tools/standings.js 的 COLUMNS 配套。
 */
function renderRow(row, columns, compKey, prevRow) {
  const cells = columns.map((col) => {
    switch (col.key) {
      case 'played':
        return String(row.played == null ? 0 : row.played)
      case 'wdl':
        return row.draws == null
          ? `${row.wins || 0}/${row.losses || 0}`
          : `${row.wins || 0}/${row.draws || 0}/${row.losses || 0}`
      case 'goals':
        return `${row.scored || 0}/${row.conceded || 0}`
      case 'pts':
        return row.pts == null ? '—' : String(row.pts)
      case 'winPct':
        return typeof row.winPct === 'number' ? `${(row.winPct * 100).toFixed(1)}%` : '—'
      default:
        return '—'
    }
  })

  const z = row.zone || null
  return {
    id: row.id,
    comp: compKey,
    pos: row.pos,
    name: row.zh || row.name,
    abbr: row.abbr || '',
    cells,
    zoneLabel: z ? z.label : '',
    zoneColor: z ? z.color : '',
    zoneBg: z ? z.bg : '',
    // 区块标签只画在色带的第一行上，避免每一行都挂一个
    zoneFirst: !!z && (!prevRow || !prevRow.zone || prevRow.zone.label !== z.label),
  }
}

/**
 * 构造 KPL 选手数据榜的渲染数据。
 *
 * ⚠️ 数值不要自己换算单位：这里只是加千分位，原始单位由官方给的是什么就是什么
 *    （团战输出是原始伤害 619020，KPL App 也是这么显示的，别擅自改成「62万」）。
 * ⚠️ 名次**照抄官方 rank**：并列第 2 就是两条都写 2，不自己补 3。
 */
function buildBoards(compKey) {
  return data.kplRankBoards(compKey).map((b) => ({
    key: b.key,
    name: b.name,
    rows: (b.rows || []).map((r) => ({
      rank: r.rank,
      num: fmtNum(r.num),
      name: r.name,
      avatar: r.av || '',
      // 头像加载失败时用选手名最后一个字兜底（队名可能不是汉字，取 id 也难看）
      initial: String(r.name || '').replace(/^.*[.]/, '').slice(0, 1) || '?',
    })),
  }))
}

/**
 * 构造篮球数据榜（得分 / 篮板 / 助攻 / 抢断 / 盖帽）的行。
 *
 * ⚠️ 名次**照抄官方 pos**：排序是上游按该项场均排好的，自己重排就是造假。
 * ⚠️ 数值是**场均**（33.48 分/场），统一保留一位小数 —— 这只是格式化，不改变排序。
 */
function buildLeaderRows(compKey, tier) {
  const board = data.leaderBoards(compKey).find((b) => b.key === tier)
  if (!board) return []
  return (board.rows || []).map((r, i) => ({
    pos: r.pos || i + 1,
    id: r.i,
    name: r.z || r.s || r.n || '',
    en: r.s || '',
    hasZh: !!r.z,
    value: fmtAvg(r.v),
  }))
}

/** 场均数值：一位小数。非数字一律回空串，别把 NaN 画到界面上 */
function fmtAvg(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n.toFixed(1) : ''
}

/** 千分位，纯为了好看；NaN / null 一律回空串，别把 undefined 画到界面上 */
function fmtNum(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return ''
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * 每一档读的是**不同的生成时间**（四张表各自独立同步）：
 * 选手榜根本不在本地包里，用 standings/scorers 的时间会被误报成「几分钟前更新」。
 */
function pickUpdatedAt(tier) {
  if (tier === 'standings') return data.standingsGeneratedAt()
  if (tier === 'players') return data.kplRankGeneratedAt()
  return data.scorersGeneratedAt()
}

/** MM-DD HH:mm（本地时区），与赛程页同一口径 */
function timeLabel(iso) {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  return `${fmt.pad(d.getMonth() + 1)}-${fmt.pad(d.getDate())} ${fmt.pad(d.getHours())}:${fmt.pad(d.getMinutes())}`
}

Page({
  data: {
    comps: [],
    activeComp: '',
    /** swiper 当前页 —— 与 activeComp 同步，横滑内容区时由 bindchange 反推 */
    swiperIndex: 0,
    /** 每个赛事一屏：{ key, name, columns, groups, ... } */
    slides: [],
    /** 各赛事内容区自己的竖向滚动位置，点标签时把目标重置回顶部 */
    slideTop: {},
    /** 当前档位 key：standings / goals / assists / players / 篮球榜 id */
    tier: 'standings',
    /** 当前档位的渲染方式：standings | scorer | leader | players */
    tierKind: 'standings',
    /** 当前档位的中文名（分享标题 / 列头用） */
    tierLabel: '积分榜',
    /** 该赛事**真正有内容**的档位（随 activeComp 变）；没有的档位不出现 */
    tiers: [],
    /** 当前档位的榜单行（射手榜 / 助攻榜），积分榜档为空数组 */
    rankRows: [],
    // 以下是当前激活赛事的镜像，供分享标题等使用
    columns: [],
    groups: [],
    season: '',
    compName: '',
    updatedAt: '',
    source: '',
    emptyReason: '',
    totalTeams: 0,
    legend: [],
  },

  onLoad(query) {
    // 只渲染当前 ±1 屏，滑过的留着，避免 10 张榜全量铺开拖慢首屏
    this._rendered = {}
    // ⚠️ query.comp 只在「分享卡片冷启动」这条路上有值。
    //    站内跳转**走不到这里** —— 积分榜是 tabBar 页面，只能 wx.switchTab，
    //    而 switchTab 不支持带 query，参数靠 globalData.pendingComp 交接（见 onShow）。
    //    同理 query.tier：分享出去的射手榜，点开要直接落在射手榜档。
    const keys = this.compKeys()
    const wanted = query && query.comp ? decodeURIComponent(query.comp) : ''
    const activeComp = keys.indexOf(wanted) > -1 ? wanted : (keys[0] || '')
    const tier = this.resolveTier(activeComp, query && query.tier ? decodeURIComponent(query.tier) : '')
    this.setData({
      activeComp,
      tier,
      comps: keys.map((k) => {
        const c = data.compOf(k)
        return { key: k, name: c.name, accent: c.accent }
      }),
    })
    this.render()
  },

  onShow() {
    // 从别的页面点了某个赛事进来（首页 / 赛程页 / 详情页 / 球队页 → pendingComp）
    //
    // ⚠️ 必须**无条件清空**这个槽位：它和赛程页共用同一个 globalData.pendingComp。
    //    以前只在「确实要切赛事」时才清，于是「点当前赛事」这种情况会把值留在槽里，
    //    等用户切回赛程 tab 时被赛程页的 onShow 误当成新指令，赛程莫名其妙跳到别处。
    const app = appInstance()
    const pending = app.globalData.pendingComp
    if (pending) {
      app.globalData.pendingComp = ''
      // ⚠️ 不能只认有积分榜的赛事：KPL 只有选手榜，但它同样在榜单列表里
      if (this.compKeys().indexOf(pending) > -1 && pending !== this.data.activeComp) {
        this.setData({ activeComp: pending, slideTop: this.topAt(pending) })
      }
    }
    this.render()
    data.refresh().then((r) => { if (r.updated) this.render() })
  },

  /**
   * 某个赛事**实际有哪几档**。
   *
   * 先按大类取模板，再逐档验数据 —— 拿不到内容的档位**根本不进这个数组**
   * （2026-10-06 用户：置灰体验不好，改成按类别给，没有的就不出现）。
   */
  tierDefs(key) {
    const cat = data.catOf(key)
    const plan = (TIER_PLAN[cat] || TIER_PLAN.football).slice()
    if (cat === 'basketball') {
      // 篮球数据榜：上游给几张就追加几张（得分/篮板/助攻/抢断/盖帽）
      data.leaderBoards(key).forEach((b) => {
        plan.push({ key: b.key, label: b.name, kind: 'leader' })
      })
    } else if (key === 'kpl') {
      plan.push({ key: 'players', label: '选手榜', kind: 'players' })
    }
    return plan.filter((t) => this.tierAvailable(key, t.key))
  },

  /**
   * 某一档有没有内容。判定只看**数据本身**：
   * 上游不给榜的赛事（欧协联没有球员榜、KPL 没有积分榜）自然就没有那一档。
   */
  tierAvailable(key, tier) {
    if (tier === 'standings') return !!data.standingsOf(key)
    const cat = data.catOf(key)
    // ⚠️ goals / assists 只在**足球**语境下是「射手榜 / 助攻榜」；
    //    篮球的「助攻榜」是数据榜里的一张（key 同样是 assists），
    //    不先看大类就会被足球那条分支吃掉，篮球白白少一档。
    if (cat === 'football') {
      if (tier === 'goals') return data.scorersTop(key, 'goals', 1).length > 0
      if (tier === 'assists') return data.scorersTop(key, 'assists', 1).length > 0
    }
    if (tier === 'players') return data.kplRankBoards(key).length > 0
    // 剩下的都是篮球数据榜（key 就是上游给的榜 id）
    return data.leaderBoards(key).some((b) => b.key === tier)
  },

  /** 换赛事时把档位收敛到该赛事真正有的那几档；一档都没有就回到积分榜 */
  resolveTier(key, want) {
    const defs = this.tierDefs(key)
    if (!defs.length) return 'standings'
    if (want && defs.some((d) => d.key === want)) return want
    return defs[0].key
  },

  /** 当前档位的渲染方式（WXML 据此选模板） */
  tierKindOf(key, tier) {
    const hit = this.tierDefs(key).find((d) => d.key === tier)
    return hit ? hit.kind : 'standings'
  },

  /** 当前档位的中文名（分享标题用；档位已不存在时回落「排行榜」） */
  tierLabelOf(key, tier) {
    const hit = this.tierDefs(key).find((d) => d.key === tier)
    return hit ? hit.label : '排行榜'
  },

  /**
   * 这个页面要展示哪些赛事。
   * ⚠️ **不能只算 standingsKeys()** —— KPL 官方没有积分榜/射手榜，
   *    但它有选手榜；只用积分榜的名单会把 KPL 整个挡在门外。
   */
  compKeys() {
    const has = data.standingsTables()
    const order = []
    data.categories().forEach((cat) => {
      ;(cat.competitions || []).forEach((key) => {
        // 三种榜任意一种有内容，这个赛事才值得进来
        if (has[key] || data.kplRankBoards(key).length || data.leaderBoards(key).length) order.push(key)
      })
    })
    return order
  },

  /**
   * 顶部分段控件。
   * ⚠️ 只放**真的有内容**的档位 —— 没有的档位不再置灰占位（2026-10-06 用户反馈：
   *    三个档位里两个是灰的，看着像坏了）。只剩一档时整条隐藏（见 rank.wxml）。
   */
  tierState(key) {
    return this.tierDefs(key)
  },

  /** 把某个赛事的内容区滚动位置归零（点标签进来时，从第 1 名开始看） */
  topAt(key) {
    const st = Object.assign({}, this.data.slideTop)
    st[key] = 0
    return st
  },

  indexOfKey(key) {
    const comps = this.data.comps || []
    for (let i = 0; i < comps.length; i += 1) {
      if (comps[i].key === key) return i
    }
    return -1
  },

  /** 构造一个赛事的整屏数据。tier 传进来是为了让每一屏自己就知道该渲染哪张榜 */
  buildSlide(key, index, curIdx, tier) {
    const name = data.compOf(key).name
    const near = Math.abs(index - curIdx) <= 1
    const visible = near || !!this._rendered[key]
    if (visible) this._rendered[key] = true

    const goals = data.scorersTop(key, 'goals', SCORER_ROWS)
    const assists = data.scorersTop(key, 'assists', SCORER_ROWS)
    // 每一屏自带当前档位的行数据 —— 这样 WXML 里不必按档位写两套 wx:for，
    // 横滑切屏的那一帧也不会拿错榜（页面级的镜像会晚一拍才同步）
    // ⚠️ 按 **kind** 取行，别按 key：篮球「助攻榜」的 key 也是 assists，
    //    但它属于 leader 而不是 scorer（两个榜结构不同、数据源也不同）。
    const slideKind = (this.tierDefs(key).find((d) => d.key === tier) || {}).kind || 'standings'
    const rankRows = slideKind === 'scorer' ? (tier === 'goals' ? goals : assists)
      : slideKind === 'leader' ? buildLeaderRows(key, tier)
        : []

    const blank = {
      key, name, index, visible, empty: true,
      columns: [], groups: [], legend: [], rows: 0,
      season: '', totalTeams: 0, scrollTop: this.data.slideTop[key] || 0,
      goals: [], assists: [], rankRows,
      hasGoals: goals.length > 0, hasAssists: assists.length > 0,
      boards: buildBoards(key),
      season: data.kplRankSeason() || '',
    }
    // ⚠️ KPL 这类「只有选手榜」的赛事会走到这里：blank 里已经带好 boards + 赛季，
    //    下面的积分榜代码**不能**再碰（table 是 null，会直接崩）
    const table = data.standingsOf(key)
    if (!table) return blank

    const groups = (table.groups || []).map((g) => {
      let prev = null
      return {
        name: g.name || '',
        rows: (g.rows || []).map((r) => {
          const view = renderRow(r, table.columns, key, prev)
          prev = r
          return view
        }),
      }
    })
    const legend = []
    const seen = {}
    groups.forEach((g) => g.rows.forEach((r) => {
      if (!r.zoneLabel || seen[r.zoneLabel]) return
      seen[r.zoneLabel] = true
      legend.push({ label: r.zoneLabel, color: r.zoneColor })
    }))

    return {
      key, name, index, visible, empty: false,
      columns: table.columns || [],
      groups,
      legend,
      // ⚠️ 篮球数据榜有自己的赛季（2025-26），与积分榜那份不是一回事 ——
      //    NBA 积分榜的 season 经常是空的，直接沿用会把「2025-26」吞掉
      season: slideKind === 'leader' ? (data.leaderSeason(key) || table.season || '') : (table.season || ''),
      totalTeams: groups.reduce((n, g) => n + g.rows.length, 0),
      scrollTop: this.data.slideTop[key] || 0,
      // 射手榜 / 助攻榜：两个榜都在这里备好，切档只是换渲染，不重新算数据
      goals,
      assists,
      rankRows,
      hasGoals: goals.length > 0,
      hasAssists: assists.length > 0,
      // KPL 选手数据榜（只有该赛事有）
      boards: buildBoards(key),
    }
  },

  render() {
    const keys = this.compKeys()
    if (!keys.length) {
      this.setData({ slides: [], swiperIndex: 0, groups: [], columns: [], tiers: [], rankRows: [], playerBoards: [], emptyReason: '积分榜数据暂未生成，稍后自动同步' })
      return
    }
    const idx = Math.max(0, this.indexOfKey(this.data.activeComp))
    // 数据可能在刷新后变化：档位要按最新数据再收敛一次，避免停在一个已经没内容的档
    const tier = this.resolveTier(this.data.activeComp, this.data.tier)
    const slides = keys.map((k, i) => this.buildSlide(k, i, idx, tier))
    const cur = slides[idx] || { name: '', columns: [], groups: [], legend: [], totalTeams: 0, season: '', goals: [], assists: [], rankRows: [], boards: [] }

    this.setData({
      slides,
      swiperIndex: idx,
      emptyReason: '',
      tier,
      // WXML 按 kind 选模板（standings / scorer / leader / players）
      tierKind: this.tierKindOf(this.data.activeComp, tier),
      tierLabel: this.tierLabelOf(this.data.activeComp, tier),
      tiers: this.tierState(this.data.activeComp),
      rankRows: cur.rankRows || [],
      boards: cur.boards || [],
      // 激活赛事的镜像，供分享标题 / 冒烟断言使用
      compName: cur.name,
      columns: cur.columns,
      groups: cur.groups,
      legend: cur.legend,
      season: cur.season,
      totalTeams: cur.totalTeams,
      updatedAt: timeLabel(pickUpdatedAt(tier)),
      source: data.source() === 'cloud' ? '云端' : '本地',
    })
  },

  /**
   * 点分段控件 → 切档。
   * ⚠️ 置灰的档位已经不存在了（没数据的档位压根不渲染），
   *    这里只挡「该赛事其实没有这一档」的越界调用。
   */
  onTierTap(e) {
    const key = e.currentTarget.dataset.key
    if (!key || key === this.data.tier) return
    if (!this.tierAvailable(this.data.activeComp, key)) return
    this.setData({ tier: key, slideTop: this.topAt(this.data.activeComp) }, () => this.render())
  },

  /**
   * 点顶部赛事标签 → 切换内容区。
   * ⚠️ 只有「点击」才切换：标签区自己横滑不联动（与主流产品一致）。
   */
  onCompTap(e) {
    const key = e.currentTarget.dataset.key
    if (!key || key === this.data.activeComp) return
    this.setData({
      activeComp: key,
      tier: this.resolveTier(key, this.data.tier),
      swiperIndex: this.indexOfKey(key),
      slideTop: this.topAt(key),
    }, () => this.render())
  },

  /** 内容区横滑 → 立刻换赛事，并把顶部标签锚定到该赛事 */
  onSwiperChange(e) {
    const idx = e && e.detail && typeof e.detail.current === 'number' ? e.detail.current : -1
    const slides = this.data.slides || []
    const key = (slides[idx] || {}).key || (this.data.comps[idx] || {}).key
    if (!key || key === this.data.activeComp) return
    // 横滑不重置滚动位置：滑回来还在刚才那一行，符合直觉
    this.setData({ activeComp: key, tier: this.resolveTier(key, this.data.tier) }, () => this.render())
  },

  /**
   * 点一行 → 球队详情页。
   * ⚠️ 球队行才有 comp+id；射手榜的行是**球员**，没有球员详情页，
   *    所以这里跟着球队 id 走：射手榜一行点了就去他所在的球队。
   */
  onRowTap(e) {
    const id = e.currentTarget.dataset.id
    if (!id || String(id) === 'TBD') return
    wx.navigateTo({
      url: `/pages/team/team?comp=${encodeURIComponent(this.data.activeComp)}&id=${encodeURIComponent(String(id))}`,
      fail() {
        wx.showToast({ title: '暂时打不开球队页', icon: 'none' })
      },
    })
  },

  goSchedule() {
    wx.switchTab({ url: '/pages/schedule/schedule' })
  },

  onShareAppMessage() {
    const name = this.data.compName
    const tierLabel = this.tierLabelOf(this.data.activeComp, this.data.tier)
    return share.message({
      title: name ? `${name}${tierLabel} · 闪现赛程助手` : `闪现赛程助手 · 各赛事${tierLabel}`,
      path: this.data.activeComp
        ? `/pages/rank/rank?comp=${encodeURIComponent(this.data.activeComp)}&tier=${encodeURIComponent(this.data.tier)}`
        : '/pages/rank/rank',
    })
  },

  onShareTimeline() {
    const name = this.data.compName
    const tierLabel = this.tierLabelOf(this.data.activeComp, this.data.tier)
    return share.timeline({
      title: name ? `${name}${tierLabel}实时更新` : `各赛事${tierLabel}实时更新`,
      query: this.data.activeComp
        ? `comp=${encodeURIComponent(this.data.activeComp)}&tier=${encodeURIComponent(this.data.tier)}`
        : '',
    })
  },
})
