const share = require('../../utils/share')
const briefApi = require('../../utils/brief')

Page({
  data: {
    list: [],          // 最近若干期日报
    idx: 0,            // 当前浏览的是第几期（0 = 最新）
    cur: null,         // 当前这期的完整结构
    loading: true,
    errTip: '',
    pubText: '',
  },

  onLoad() {
    this.load()
  },

  async load() {
    this.setData({ loading: true, errTip: '' })
    const res = await briefApi.fetchBriefs(10)
    const list = res.list || []
    if (!list.length) {
      this.setData({
        loading: false,
        errTip: res.reason === 'no-cloud' ? '云服务未就绪，暂无法读取日报' : '还没有日报，稍后再来看看',
      })
      return
    }
    this.setData({ list, loading: false }, () => this.pick(0))
  },

  // 切到第 i 期
  pick(i) {
    const list = this.data.list
    if (!list.length) return
    const idx = Math.max(0, Math.min(list.length - 1, i))
    const cur = list[idx]
    this.setData({
      idx,
      cur,
      pubText: briefApi.fmtPubAt(cur.pubAt),
    })
  },

  onPrev() { this.pick(this.data.idx - 1) },
  onNext() { this.pick(this.data.idx + 1) },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  // 点简讯里的比赛，跳到详情页
  onBriefTap(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(id) })
  },

  onHeadlineTap() {
    const h = this.data.cur && this.data.cur.headline
    if (!h || !h.matchId) return
    wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(h.matchId) })
  },

  onPreviewTap(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(id) })
  },
  onShareAppMessage() {
    return share.message({ title: '闪现赛程助手 · 每日赛事日报', path: '/pages/brief/brief' })
  },

  onShareTimeline() {
    return share.timeline({ title: '闪现赛程助手 · 每日赛事日报' })
  },
})
