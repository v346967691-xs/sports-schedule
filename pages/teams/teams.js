const share = require('../../utils/share')
const data = require('../../utils/data')
const follows = require('../../utils/team-follows')
const { appInstance } = require('../../utils/app-instance')

/**
 * 开放关注的赛事：五大联赛 + 欧国联（欧洲国家队）+ 中国之队 + NBA + LPL + LCK
 *
 * chn（中国之队）里是国字号球队的比赛：男足、女足、U17 等。
 * 球队的名单不是单独维护的，直接从 data.teamsOf(comp) 里抽，
 * 所以只要有中国队的比赛进快照，这里就能选到，不用额外维护名单。
 */
/**
 * 可关注的赛事及其展示顺序。
 * 顺序与 tools/sync.js 的 COMPETITIONS / SPORT_CATS 保持一致（2026-10-02 用户定），
 * 只是这里不开放那些"球队池不适合关注"的赛事（欧冠/欧联/世界赛等）。
 * ⚠️ 这是页面层：改完要发版才生效，不像数据层那样推云端就更新。
 */
// ⚠️ 欧战（欧冠/欧联/欧协联）不开放关注 —— 一支队的球队池横跨十几个国家联赛，
//    跟「按联赛关注」的心智不符（2026-10-02 定的口径，欧协联沿用）
const SELECTABLE = [
  'epl', 'liga', 'seriea', 'bundesliga', 'ligue1', 'nations', 'chn', 'csl',
  'asiacup', 'u17', 'u17w', 'friendly', 'nba', 'cba', 'lpl', 'lck', 'kpl',
]

/**
 * 某些赛事只开放部分球队供关注。
 * 中国之队（chn）的比赛是从「中国队视角」抓的，对手（越南/马尔代夫/韩国U23…）
 * 也会被 teamsOf 抽出来，但用户要关注的是国字号球队本身，不是对手 ——
 * 这里按中文名过滤，只保留「中国」开头的（男足/女足/U17/U23亚运队）。
 */
const CAT_TEAM_FILTER = {
  chn: /^中国/,
  // U17 两个世界杯：48 / 24 支队里有 47 / 23 支外国队，用户要关注的是中国队
  u17: /^中国/,
  u17w: /^中国/,
}

Page({
  data: {
    cats: [],
    activeCat: SELECTABLE[0],
    keyword: '',
    teams: [],
    followedCount: 0,
  },

  onLoad(query) {
    if (query && query.cat && SELECTABLE.indexOf(query.cat) > -1) {
      this.setData({ activeCat: query.cat, keyword: '' })
    } else {
      this.setData({ keyword: '' })
    }
    this.build()
  },

  onShow() {
    this.build()
    data.refresh().then((r) => { if (r.updated) this.build() })
  },

  /** 有积分榜的赛事，在球队卡上补一行「第 N 位 · X 分」，让用户一眼看到强弱 */
  rankText(compKey, teamId) {
    const row = data.teamStanding(compKey, teamId)
    if (!row) return ''
    const bits = [`第 ${row.pos} 位`]
    if (typeof row.played === 'number' && row.played) bits.push(`${row.played} 场`)
    if (typeof row.pts === 'number') bits.push(`${row.pts} 分`)
    else if (typeof row.winPct === 'number') bits.push(`${(row.winPct * 100).toFixed(0)}% 胜率`)
    return bits.join(' · ')
  },

  build() {
    const followedList = follows.all()
    const followedSet = {}
    followedList.forEach((t) => { followedSet[follows.key(t.comp, t.id)] = true })

    // 赛会制赛事（U17 世界杯）在窗口外没有比赛 → 抽不出球队，那个分类就不显示，
    // 等比赛进入抓取窗口会自动冒出来，不用发版
    const cats = SELECTABLE
      .filter((k) => data.teamsOf(k).length > 0)
      .map((k) => ({
        key: k,
        name: data.compOf(k).name,
        followed: followedList.filter((t) => t.comp === k).length,
      }))

    const kw = String(this.data.keyword || '').trim().toLowerCase()
    const catFilter = CAT_TEAM_FILTER[this.data.activeCat]
    const teams = data
      .teamsOf(this.data.activeCat)
      .filter((t) => !catFilter || catFilter.test(t.display))
      .filter((t) => !kw
        || t.display.toLowerCase().indexOf(kw) > -1
        || t.name.toLowerCase().indexOf(kw) > -1
        || t.abbr.toLowerCase().indexOf(kw) > -1)
      .map((t) => Object.assign({}, t, {
        k: follows.key(t.comp, t.id),
        followed: !!followedSet[follows.key(t.comp, t.id)],
        rankText: this.rankText(t.comp, t.id),
      }))

    this.setData({ cats, teams, followedCount: followedList.length })
  },

  onCatTap(e) {
    this.setData({ activeCat: e.currentTarget.dataset.key, keyword: '' }, () => this.build())
  },

  onSearch(e) {
    this.setData({ keyword: e.detail.value || '' }, () => this.build())
  },

  onClearKeyword() {
    this.setData({ keyword: '' }, () => this.build())
  },

  /** 点名字区 → 进球队详情页 */
  onTeamTap(e) {
    const item = this.data.teams[e.currentTarget.dataset.index]
    if (!item) return
    wx.navigateTo({
      url: `/pages/team/team?comp=${encodeURIComponent(item.comp)}&id=${encodeURIComponent(String(item.id))}`,
      fail() {
        wx.showToast({ title: '暂时打不开球队页', icon: 'none' })
      },
    })
  },

  /** 点「+ 关注 / 已关注」→ 只切换关注状态，不跳转 */
  onFollowTap(e) {
    const item = this.data.teams[e.currentTarget.dataset.index]
    if (!item) return
    if (item.followed) {
      follows.remove(item.comp, item.id)
      this.build()
      return
    }
    const res = follows.toggle(item)
    this.build()
    if (res.followed) wx.showToast({ title: `已关注 ${item.display}`, icon: 'none', duration: 1200 })
  },

  onClear() {
    if (!this.data.followedCount) return
    const self = this
    wx.showModal({
      title: '清空关注球队',
      content: `将取消全部 ${this.data.followedCount} 支已关注球队，确定吗？`,
      confirmText: '清空',
      cancelText: '取消',
      success(res) {
        if (!res.confirm) return
        follows.clear()
        self.build()
        wx.showToast({ title: '已清空', icon: 'none' })
      },
    })
  },

  /** 去「我的」看关注球队的比赛 */
  goMine() {
    wx.navigateBack({
      fail() {
        wx.switchTab({ url: '/pages/mine/mine' })
      },
    })
  },
  onShareAppMessage() {
    return share.message({ title: '闪现赛程助手 · 关注你支持的球队', path: '/pages/index/index' })
  },

  onShareTimeline() {
    return share.timeline({ title: '闪现赛程助手 · 关注你支持的球队' })
  },
})
