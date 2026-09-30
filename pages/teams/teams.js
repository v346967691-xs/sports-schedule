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
const SELECTABLE = ['epl', 'liga', 'seriea', 'bundesliga', 'ligue1', 'nations', 'chn', 'nba', 'lpl', 'lck']

/**
 * 某些赛事只开放部分球队供关注。
 * 中国之队（chn）的比赛是从「中国队视角」抓的，对手（越南/马尔代夫/韩国U23…）
 * 也会被 teamsOf 抽出来，但用户要关注的是国字号球队本身，不是对手 ——
 * 这里按中文名过滤，只保留「中国」开头的（男足/女足/U17/U23亚运队）。
 */
const CAT_TEAM_FILTER = {
  chn: /^中国/,
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

  build() {
    const followedList = follows.all()
    const followedSet = {}
    followedList.forEach((t) => { followedSet[follows.key(t.comp, t.id)] = true })

    const cats = SELECTABLE.map((k) => ({
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

  onTeamTap(e) {
    const item = this.data.teams[e.currentTarget.dataset.index]
    if (!item) return
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
})
