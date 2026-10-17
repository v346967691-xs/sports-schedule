const data = require('../../utils/data')
const worlds = require('../../utils/worlds')
const model = require('../../utils/worlds-report')
const brief = require('../../utils/worlds-brief')
const longPoster = require('../../utils/worlds-poster')
const card = require('../../utils/poster')
const share = require('../../utils/share')
Page({
  data: { report: null, sections: [], loading: true, error: '', stale: false, exporting: false, posterPath: '', editions: [], shareImage: '' },
  onLoad(query) {
    this.date = model.validDate(query && query.date) ? query.date : worlds.beijingDay(Date.now())
    this.load()
    brief.editions().then(editions => this.setData({ editions }))
  },
  async load() {
    const token = this.loadToken = (this.loadToken || 0) + 1
    this.setData({ loading: true, error: '', posterPath: '', shareImage: '' })
    try {
      const date = this.date
      const results = await Promise.all([data.refresh(), data.loadWorldsArchive(), brief.fetch(date)])
      await data.refreshLive(true)
      if (token !== this.loadToken) return
      const stored = results[2]
      const historical = date !== worlds.beijingDay(Date.now())
      if (historical && !stored) { this.setData({ loading: false, error: '这一天还没有已发布的晨报，请返回专区查看比赛。' }); return }
      const byId = {}
      results[1].forEach(m => { byId[m.id] = m })
      data.matches().forEach(m => { byId[m.id] = m })
      const report = stored || model.build(Object.keys(byId).map(id => byId[id]), date)
      const sections = [
        { key: 'lpl', title: 'LPL 昨夜表现', rows: report.lpl },
        { key: 'results', title: report.lpl.length ? '其他已结束比赛' : '完整赛果', rows: report.otherFinished || report.finished },
        { key: 'live', title: '仍在进行', rows: report.live },
        { key: 'waiting', title: '等待官方更新', rows: report.waiting },
        { key: 'qualification', title: '瑞士轮晋级形势', rows: report.qualification },
        { key: 'next', title: '下一比赛日', rows: report.next },
      ].filter(section => section.rows.length)
      const updatedText = new Date(Date.parse(report.updatedAt) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ')
      this.setData({ report, sections, loading: false, stale: !historical && data.staleInfo().stale, updatedText }, () => this.buildCard(report))
    } catch (error) { if (token === this.loadToken) this.setData({ loading: false, error: '晨报读取失败，请下拉重试' }) }
  },
  async buildCard(report) {
    const image = await card.build(this, 'share-canvas', 'brief', { dateText: report.date, kindZh: 'S 赛晨报', sub: report.title, accent: '#14235c' })
    if (this.data.report === report) this.setData({ shareImage: image || '' })
  },
  onEditionChange(e) { this.date = this.data.editions[Number(e.detail.value)]; if (this.date) this.load() },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()) },
  goMatch(e) { wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(e.currentTarget.dataset.id)}` }) },
  goWorlds() { wx.navigateTo({ url: '/pages/worlds/worlds' }) },
  async exportPoster() {
    if (this.data.exporting || !this.data.report) return ''
    if (this.data.posterPath) return this.data.posterPath
    const report = this.data.report
    this.setData({ exporting: true })
    try {
      const path = await longPoster.build(this, report)
      if (this.data.report !== report) return ''
      this.setData({ posterPath: path })
      return path
    } catch (error) { wx.showToast({ title: error.message || '生成失败，请重试', icon: 'none' }); return '' }
    finally { this.setData({ exporting: false }) }
  },
  async generatePoster() {
    const path = await this.exportPoster()
    if (!path) return
    wx.previewImage({ current: path, urls: [path] })
  },
  onShareAppMessage() { return share.message({ title: `${this.date} · 闪现 S 赛晨报`, path: `/pages/worlds-brief/worlds-brief?date=${this.date}`, imageUrl: this.data.shareImage }) },
  onShareTimeline() { return share.timeline({ title: `${this.date} · 闪现 S 赛晨报`, query: `date=${this.date}`, imageUrl: this.data.shareImage }) },
})
