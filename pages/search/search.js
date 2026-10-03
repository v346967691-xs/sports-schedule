/**
 * 全站搜索页（球队 + 赛事）
 *
 * 与「关注球队」页那个输入框的分工：
 *   关注页 = 在**当前分类内**过滤「可关注」的球队（欧战/世界赛被排除在外）；
 *   本页   = 在**全部 26 个赛事**里搜球队 + 搜赛事本身。索引是纯本地的（utils/search.js），
 *            不发任何网络请求，所以输入即出结果，不需要防抖。
 *
 * ⚠️ 这是页面层：改完必须发版。
 *
 * 跳转红线：
 *   球队详情 /pages/team/team 不是 tabBar 页面 → wx.navigateTo 正常；
 *   但点赛事要落到「赛程」tab、点「积分榜」要落到「积分榜」tab，
 *   这两个都是 tabBar 页面，**必须走 utils/nav.js**（navigateTo 会静默失败）。
 *
 * 关注按钮与球队名**分成两个可点区域**：一个进详情、一个只切关注，
 * 混在一起会变成「想看看球队，结果把关注取消了」（与关注页同一约定）。
 */
const share = require('../../utils/share')
const data = require('../../utils/data')
const searcher = require('../../utils/search')
const follows = require('../../utils/team-follows')
const nav = require('../../utils/nav')

/** 一次最多渲染多少条：本地搜索很快，但列表太长反而难用 */
const MAX_HITS = 40

Page({
  data: {
    keyword: '',
    autoFocus: false,
    searched: false,
    compHits: [],
    teamHits: [],
    hot: [],
    scale: { teams: 0, comps: 0 },
  },

  onLoad(query) {
    const kw = query && query.kw ? decodeURIComponent(query.kw) : ''
    // 从「搜索」入口进来时空输入框该自动聚焦（键盘直接弹）；
    // 从分享链接带 kw 冷启动时不该弹键盘抢内容。
    this.setData({
      hot: searcher.hot(),
      scale: searcher.stats(),
      keyword: kw,
      autoFocus: !kw,
    }, () => this.run())
  },

  onShow() {
    this.run()
    // 云端快照换掉后球队可能增减，索引必须跟着重建
    data.refresh().then((r) => {
      if (!r.updated) return
      searcher.rebuild()
      this.run()
    })
  },

  /**
   * 跑一次搜索，并把结果摊成两块可直接渲染的视图模型。
   * ⚠️ 一定要**拷贝成新对象**再 setData：searcher.search() 返回的是索引里的共享对象，
   *    直接往上挂 followed 字段会把状态写进索引，下次搜索带着上次的陈旧关注态。
   */
  run() {
    const kw = String(this.data.keyword || '').trim()
    const followedSet = {}
    follows.all().forEach((t) => { followedSet[follows.key(t.comp, t.id)] = true })

    let hits = []
    if (kw) {
      hits = searcher.search(kw, MAX_HITS).map((it) => {
        if (it.kind === 'comp') {
          return {
            kind: 'comp',
            key: it.key,
            name: it.name,
            full: it.full,
            accent: it.accent,
            hasStandings: it.hasStandings,
          }
        }
        const k = follows.key(it.comp, it.id)
        return {
          kind: 'team',
          id: it.id,
          comp: it.comp,
          compName: it.compName,
          compCount: it.comps.length,
          display: it.display,
          // name / zh / abbr / color 要原样带上：关注落库与云端同步都要用到
          name: it.name,
          zh: it.zh,
          abbr: it.abbr,
          color: it.color,
          k,
          followed: !!followedSet[k],
        }
      })
    }

    this.setData({
      keyword: kw,
      searched: !!kw,
      compHits: hits.filter((x) => x.kind === 'comp'),
      teamHits: hits.filter((x) => x.kind === 'team'),
    })
  },

  onInput(e) {
    this.setData({ keyword: e.detail.value || '' }, () => this.run())
  },

  onClearKeyword() {
    this.setData({ keyword: '', autoFocus: true }, () => this.run())
  },

  /** 点推荐词：直接把词填进去再搜一遍 */
  onHotTap(e) {
    this.setData({ keyword: e.currentTarget.dataset.w || '', autoFocus: false }, () => this.run())
  },

  /** 点球队名 → 球队详情页（非 tabBar，navigateTo 可用） */
  onTeamTap(e) {
    const item = this.data.teamHits[e.currentTarget.dataset.index]
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
    const item = this.data.teamHits[e.currentTarget.dataset.index]
    if (!item) return
    if (item.followed) {
      follows.remove(item.comp, item.id)
      this.run()
      return
    }
    const res = follows.toggle(item)
    this.run()
    if (res.followed) wx.showToast({ title: `已关注 ${item.display}`, icon: 'none', duration: 1200 })
  },

  /** 点赛事 → 赛程 tab 并选中该赛事（⚠️ tabBar 页面，必须走 nav） */
  onCompTap(e) {
    nav.toScheduleComp(e.currentTarget.dataset.key)
  },

  /** 赛事行里的「积分榜 ›」→ 积分榜 tab 并选中该赛事 */
  onCompRankTap(e) {
    nav.toRank(e.currentTarget.dataset.key)
  },

  onShareAppMessage() {
    const kw = this.data.keyword
    return share.message({
      title: kw ? `闪现赛程助手 · 搜「${kw}」` : '闪现赛程助手 · 搜球队与赛事',
      // 带词的链接分享出去，好友点开就是同一个搜索结果
      path: kw ? `/pages/search/search?kw=${encodeURIComponent(kw)}` : '/pages/search/search',
    })
  },

  onShareTimeline() {
    const kw = this.data.keyword
    return share.timeline({
      title: kw ? `闪现赛程助手 · 搜「${kw}」` : '闪现赛程助手 · 搜球队与赛事',
      query: kw ? `kw=${encodeURIComponent(kw)}` : '',
    })
  },
})
