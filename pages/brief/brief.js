const share = require('../../utils/share')
const poster = require('../../utils/poster')
const briefApi = require('../../utils/brief')

Page({
  data: {
    list: [],          // 最近若干期日报
    idx: 0,            // 当前浏览的是第几期（0 = 最新）
    cur: null,         // 当前这期的完整结构
    loading: true,
    errTip: '',
    pubText: '',
    shareImage: '',    // 转发卡图
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
    }, () => this.buildShareImage())
  },

  /**
   * 转发卡图：统一写「X月X日 闪现早/晚报」，副标题带这一期的摘要。
   * 每次切期次都要重画（标题跟着期次变）。
   */
  async buildShareImage() {
    const cur = this.data.cur
    if (!cur) return
    const dateText = briefApi.fmtPubAt(cur.pubAt).replace(/\s*\d{2}:\d{2}$/, '')
    const img = await poster.build(this, 'share-canvas', 'brief', {
      dateText,
      kindZh: cur.kindZh || briefApi.kindZh(cur.kind),
      sub: briefApi.teaser(cur) || (cur.preview && cur.preview.intro) || '',
      accent: cur.kind === 'evening' ? '#3B4E8C' : '#C8952A',
    })
    if (img && cur === this.data.cur) this.setData({ shareImage: img, shareDate: dateText })
  },

  onPrev() { this.step(-1) },
  onNext() { this.step(1) },

  /**
   * 翻期次（dir = -1 更早 / +1 较新）。
   *
   * 🔴 到边界时**不能静默吞掉**：2026-10-03 用户要求两个按钮在任何一页样式完全一致，
   *    也就是界面上**不再有"不可点"的视觉暗示** —— 这时候再不给反馈，
   *    就真的成了「点了没反应」。所以用一句 toast 说明原因。
   *    （`pick()` 自己仍然 clamp，防止别处直接调用时越界。）
   */
  step(dir) {
    const list = this.data.list || []
    const next = this.data.idx + dir
    if (!list.length) return
    if (next < 0 || next > list.length - 1) {
      wx.showToast({ title: dir < 0 ? '已经是最早一期了' : '已经是最新一期了', icon: 'none' })
      return
    }
    this.pick(next)
  },

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
  /** 分享标题统一为「X月X日闪现早/晚报」，与卡面一致 */
  shareTitle() {
    const cur = this.data.cur
    if (!cur) return '闪现赛程助手 · 每日赛事日报'
    const kind = cur.kindZh || briefApi.kindZh(cur.kind)
    const d = this.data.shareDate || ''
    return d ? `${d}闪现${kind}` : `闪现${kind}`
  },

  onShareAppMessage() {
    return share.message({
      title: this.shareTitle(),
      path: '/pages/brief/brief',
      imageUrl: this.data.shareImage,
    })
  },

  onShareTimeline() {
    return share.timeline({ title: this.shareTitle(), imageUrl: this.data.shareImage })
  },
})
