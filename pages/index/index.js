const share = require('../../utils/share')
const data = require('../../utils/data')
const view = require('../../utils/view')
const fmt = require('../../utils/format')
const follows = require('../../utils/team-follows')
const briefApi = require('../../utils/brief')
const nav = require('../../utils/nav')

/** 关注球队的「未来赛程」最多往前看几天 */
const TEAM_FUTURE_DAYS = 7

/**
 * 某个赛事积分榜的领头羊：「成都蓉城 52分」/「曼城 15分」。
 * 给首页赛事入口一个额外的点击理由 —— 光看「3 场待开赛」太平了。
 */
function leaderText(compKey) {
  const table = data.standingsOf(compKey)
  if (!table || !(table.groups || []).length) return ''
  const first = (table.groups[0].rows || [])[0]
  if (!first) return ''
  const name = first.zh || first.name
  if (typeof first.pts === 'number') return `${name} ${first.pts}分`
  if (typeof first.winPct === 'number') return `${name} ${(first.winPct * 100).toFixed(0)}% 胜率`
  return name
}

const CATS = [
  { key: 'all', name: '全部' },
  { key: 'football', name: '足球' },
  { key: 'basketball', name: '篮球' },
  { key: 'esports', name: '电竞' },
]

Page({
  data: {
    cats: CATS,
    activeCat: 'all',
    dateStrip: [],
    activeDate: '',
    dayMatches: [],
    liveMatches: [],
    entries: [],
    stats: { upcoming: 0, days: 0, comps: 0, updatedAt: '' },
    teamMatches: [],
    teamCount: 0,
    loadError: '',
    brief: null,
  },

  onLoad() {
    this.build()
    this.loadBrief()
    data.refresh().then((r) => { if (r.updated) this.build() })
  },

  onShow() {
    // 立即用当前数据渲染（本地包或已换上的云端数据），再尝试拉云端、有更新就重建
    this.build()
    this.loadBrief()
    data.refresh().then((r) => { if (r.updated) this.build() })
  },

  /**
   * 日报入口条：只取最新一期做一句话摘要。
   * 日报是附加功能，取不到就整条不显示，不打扰看比分的主流程。
   */
  async loadBrief() {
    try {
      const res = await briefApi.fetchBriefs(1)
      const one = (res.list || [])[0]
      const tip = briefApi.teaser(one)
      if (!tip) return
      this.setData({
        brief: {
          tip,
          kindZh: one.kindZh,
          pubText: briefApi.fmtPubAt(one.pubAt),
        },
      })
    } catch (err) {
      console.warn('[赛程助手] 日报摘要读取失败', err)
    }
  },

  goBrief() {
    wx.navigateTo({ url: '/pages/brief/brief' })
  },

  /**
   * 渲染兜底：任何一步出错都不能把页面留成白板。
   * 真机上白屏最难排查，这里把错误直接显示在页面上。
   */
  build() {
    try {
      this.doBuild()
    } catch (err) {
      console.error('[赛程助手] 首页渲染失败', err)
      this.setData({ loadError: (err && err.message) || '首页渲染失败' })
    }
  },

  doBuild() {
    // 数据文件没打进包时（最常见的真机空白原因），直接说清楚，别给用户一片白
    if (!data.matches().length) {
      this.setData({
        loadError: '赛程数据没有打进小程序包。请在项目目录执行 npm run sync，再用开发者工具重新上传体验版。',
      })
      return
    }

    const today = fmt.todayStr()
    const strip = []
    for (let i = -1; i < 13; i += 1) {
      const d = fmt.shiftDay(today, i)
      strip.push({ date: d, label: fmt.shortDayLabel(d), week: fmt.weekdayLabel(d).slice(1) })
    }

    const upcoming = data.query({ status: 'upcoming', from: today })
    const nextMap = data.nextMatchByComp()
    const lastMap = data.lastMatchByComp()
    const compMap = data.compMap()

    const entries = data.competitions().map((c) => {
      const next = nextMap[c.key]
      const last = lastMap[c.key]
      const src = next || last
      const side = (m) => (m ? `${m.home.zh || m.home.name} vs ${m.away.zh || m.away.name}` : '')
      let summary = '暂未公布未来赛程'
      if (next) {
        summary = `${fmt.shortDayLabel(next.date)} ${next.time}  ${side(next)}`
      } else if (last) {
        summary = `最近 ${fmt.shortDayLabel(last.date)} ${side(last)}`
      }
      return {
        key: c.key,
        name: c.name,
        full: c.full,
        cat: c.cat,
        accent: c.accent,
        summary,
        hasNext: !!next,
        hasLast: !!last,
        count: upcoming.filter((m) => m.comp === c.key).length,
        // 有积分榜的赛事才显示「积分榜」入口；杯赛和国字号本来就没有排名
        hasStandings: !!data.standingsOf(c.key),
        leader: leaderText(c.key),
      }
    })
      // 还没进抓取窗口的赛事（比如 2027-01 才开赛的亚洲杯）不占入口位：
      // 卡片上只能写「暂未公布未来赛程」，跟「没这个赛事」没区别，
      // 等比赛进了窗口会自己冒出来，不用发版
      .filter((e) => e.hasNext || e.hasLast)

    this.setData({
      dateStrip: strip,
      activeDate: this.pickStartDay(strip),
      entries,
      liveMatches: view.decorateList(data.query({ status: 'live' }), { compOf: data.compOf }),
      stats: {
        upcoming: upcoming.length,
        days: data.datesOf(upcoming).length,
        comps: Object.keys(compMap).length,
        updatedAt: this.updatedLabel(),
        stale: data.staleInfo().stale,
        staleLabel: this.staleLabel(),
        source: data.source(),
      },
    })

    // 我关注的球队：最近赛果 + 接下来的比赛，放在「按日查看」前面。
    // ⚠️ 24 小时内打完的也要展示（teamResults）—— 只看未来的话，刚看完的那场反而找不到。
    const tf = follows.asFilter()
    const ctx = { compOf: data.compOf }
    this.setData({
      teamCount: tf.length,
      teamResults: tf.length
        ? view.decorateList(data.recentFinished({ teams: tf }, 24).slice(0, 4), ctx)
        : [],
      // 未来赛程只看到 7 天内（更远的占位置又用不上）
      teamMatches: tf.length
        ? view.decorateList(data.query({
          teams: tf, status: ['upcoming', 'live'], to: fmt.shiftDay(fmt.todayStr(), TEAM_FUTURE_DAYS),
        }).slice(0, 8), ctx)
        : [],
    })

    this.applyFilter()
  },

  goTeams() {
    wx.navigateTo({ url: '/pages/teams/teams' })
  },

  /** 去全站搜索页（/pages/search/search 不是 tabBar 页面，navigateTo 正常可用） */
  goSearch() {
    wx.navigateTo({
      url: '/pages/search/search',
      fail() {
        wx.showToast({ title: '暂时打不开搜索', icon: 'none' })
      },
    })
  },

  /** 默认落在最近一个有比赛的日期，避免一打开就是空列表 */
  pickStartDay(strip) {
    const today = fmt.todayStr()
    if (data.query({ date: today, status: '' }).length) return today
    const hit = strip.find((s) => data.query({ date: s.date, status: '' }).length)
    return hit ? hit.date : today
  },

  updatedLabel() {
    const gen = data.generatedAt()
    if (!gen) return ''
    const d = new Date(gen)
    return `${d.getFullYear()}-${fmt.pad(d.getMonth() + 1)}-${fmt.pad(d.getDate())} ${fmt.pad(d.getHours())}:${fmt.pad(d.getMinutes())}`
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

  applyFilter() {
    const { activeCat, activeDate } = this.data
    const list = data.query({
      cat: activeCat === 'all' ? '' : activeCat,
      date: activeDate,
      status: '',
    })
    let nextHit = ''
    if (!list.length) {
      nextHit = this.nextAvailableDay(activeCat, activeDate)
    }
    this.setData({
      dayMatches: view.decorateList(list, { compOf: data.compOf }),
      nextDay: nextHit,
      nextDayLabel: nextHit ? fmt.dayLabel(nextHit) : '',
    })
  },

  /** 找到下一个有比赛的日期（用于空状态给出口） */
  nextAvailableDay(cat, from) {
    let cursor = from
    for (let i = 0; i < 90; i += 1) {
      cursor = fmt.shiftDay(cursor, 1)
      if (data.query({ cat: cat === 'all' ? '' : cat, date: cursor, status: '' }).length) return cursor
    }
    return ''
  },

  onCatTap(e) {
    this.setData({ activeCat: e.currentTarget.dataset.key }, () => this.applyFilter())
  },

  onDateTap(e) {
    this.setData({ activeDate: e.currentTarget.dataset.date }, () => this.applyFilter())
  },

  onCompTap(e) {
    const key = e.currentTarget.dataset.key
    // tabBar 页面不支持 navigateTo 传参，用全局状态把选中的赛事带过去
    nav.toScheduleComp(key)
  },

  /** 首页赛事卡里的「积分榜 ›」：直接跳到该赛事的积分榜 */
  onRankTap(e) {
    const key = e.currentTarget.dataset.key
    // ⚠️ 积分榜是 tabBar 页面，navigateTo 会静默失败，必须走 nav.toRank
    nav.toRank(key)
  },

  goSchedule() {
    nav.goTab('/pages/schedule/schedule')
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}` })
  },
  onShareAppMessage() {
    return share.message({ title: '闪现赛程助手 · 足球 / NBA / 电竞赛程比分', path: '/pages/index/index' })
  },

  onShareTimeline() {
    return share.timeline({ title: '闪现赛程助手 · 足球 / NBA / 电竞赛程比分' })
  },
})
