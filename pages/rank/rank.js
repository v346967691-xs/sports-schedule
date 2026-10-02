/**
 * 积分榜页
 *
 * 数据来自 data/standings.js（本地兜底）+ 云端 standings_cache（打开即读）。
 * 哪些赛事有积分榜由数据本身决定 —— 杯赛（全球总决赛等）和中国国字号
 * 本来就没有排名，同步脚本不会产出，这里也就不会出现它们的标签。
 *
 * ⚠️ 这是页面层：新增 / 改动都要发版。
 */
const share = require('../../utils/share')
const data = require('../../utils/data')
const fmt = require('../../utils/format')
const { appInstance } = require('../../utils/app-instance')

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
    const keys = data.standingsKeys()
    const wanted = query && query.comp ? decodeURIComponent(query.comp) : ''
    const activeComp = keys.indexOf(wanted) > -1 ? wanted : (keys[0] || '')
    this.setData({
      activeComp,
      comps: keys.map((k) => {
        const c = data.compOf(k)
        return { key: k, name: c.name, accent: c.accent }
      }),
    })
    this.render()
  },

  onShow() {
    // 从别的页面点了某个赛事进来（关注页 / 详情页 → pendingComp）
    const app = appInstance()
    const pending = app.globalData.pendingComp
    if (pending && data.standingsOf(pending) && pending !== this.data.activeComp) {
      app.globalData.pendingComp = ''
      this.setData({ activeComp: pending, slideTop: this.topAt(pending) })
    }
    this.render()
    data.refresh().then((r) => { if (r.updated) this.render() })
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

  /** 构造一个赛事的整屏数据 */
  buildSlide(key, index, curIdx) {
    const name = data.compOf(key).name
    const near = Math.abs(index - curIdx) <= 1
    const visible = near || !!this._rendered[key]
    if (visible) this._rendered[key] = true

    const blank = {
      key, name, index, visible, empty: true,
      columns: [], groups: [], legend: [], rows: 0,
      season: '', totalTeams: 0, scrollTop: this.data.slideTop[key] || 0,
    }
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
      season: table.season || '',
      totalTeams: groups.reduce((n, g) => n + g.rows.length, 0),
      scrollTop: this.data.slideTop[key] || 0,
    }
  },

  render() {
    const keys = data.standingsKeys()
    if (!keys.length) {
      this.setData({ slides: [], swiperIndex: 0, groups: [], columns: [], emptyReason: '积分榜数据暂未生成，稍后自动同步' })
      return
    }
    const idx = Math.max(0, this.indexOfKey(this.data.activeComp))
    const slides = keys.map((k, i) => this.buildSlide(k, i, idx))
    const cur = slides[idx] || { name: '', columns: [], groups: [], legend: [], totalTeams: 0, season: '' }

    this.setData({
      slides,
      swiperIndex: idx,
      emptyReason: '',
      // 激活赛事的镜像，供分享标题 / 冒烟断言使用
      compName: cur.name,
      columns: cur.columns,
      groups: cur.groups,
      legend: cur.legend,
      season: cur.season,
      totalTeams: cur.totalTeams,
      updatedAt: timeLabel(data.standingsGeneratedAt()),
      source: data.source() === 'cloud' ? '云端' : '本地',
    })
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
    this.setData({ activeComp: key }, () => this.render())
  },

  /** 点一支球队 → 球队详情页 */
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
    return share.message({
      title: name ? `${name}积分榜 · 闪现赛程助手` : '闪现赛程助手 · 各赛事积分榜',
      path: this.data.activeComp ? `/pages/rank/rank?comp=${encodeURIComponent(this.data.activeComp)}` : '/pages/rank/rank',
    })
  },

  onShareTimeline() {
    const name = this.data.compName
    return share.timeline({
      title: name ? `${name}积分榜实时更新` : '各赛事积分榜实时更新',
      query: this.data.activeComp ? `comp=${encodeURIComponent(this.data.activeComp)}` : '',
    })
  },
})
