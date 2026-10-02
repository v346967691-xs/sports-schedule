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
    if (pending && data.standingsOf(pending)) {
      app.globalData.pendingComp = ''
      if (pending !== this.data.activeComp) {
        this.setData({ activeComp: pending })
        this.scrollToTop()
      }
    }
    this.render()
    data.refresh().then((r) => { if (r.updated) this.render() })
  },

  render() {
    const keys = data.standingsKeys()
    if (!keys.length) {
      this.setData({ groups: [], columns: [], emptyReason: '积分榜数据暂未生成，稍后自动同步' })
      return
    }
    const comp = this.data.activeComp && keys.indexOf(this.data.activeComp) > -1
      ? this.data.activeComp
      : keys[0]
    const table = data.standingsOf(comp)
    if (!table) {
      this.setData({ groups: [], columns: [], emptyReason: '该赛事暂无积分榜' })
      return
    }

    const groups = (table.groups || []).map((g) => {
      let prev = null
      return {
        name: g.name || '',
        rows: (g.rows || []).map((r) => {
          const view = renderRow(r, table.columns, comp, prev)
          prev = r
          return view
        }),
      }
    })
    const totalTeams = groups.reduce((n, g) => n + g.rows.length, 0)

    this.setData({
      activeComp: comp,
      compName: data.compOf(comp).name,
      columns: table.columns,
      groups,
      season: table.season || '',
      totalTeams,
      // 图例：当前这张表实际出现的分区，去重后按出现顺序排列
      legend: (function () {
        const seen = {}
        const out = []
        groups.forEach((g) => g.rows.forEach((r) => {
          if (!r.zoneLabel || seen[r.zoneLabel]) return
          seen[r.zoneLabel] = true
          out.push({ label: r.zoneLabel, color: r.zoneColor })
        }))
        return out
      })(),
      updatedAt: timeLabel(data.standingsGeneratedAt()),
      source: data.source() === 'cloud' ? '云端' : '本地',
      emptyReason: '',
    })  },

  onCompTap(e) {
    const key = e.currentTarget.dataset.key
    if (!key || key === this.data.activeComp) return
    this.setData({ activeComp: key }, () => this.render())
    // 用户可能已经滚到榜尾，新榜从第 1 名开始看 —— 立刻拉回顶部，别让人手动拖
    this.scrollToTop()
  },

  /** 切换赛事后回顶（页面级滚动，duration 0 直接跳，不做事动画拖泥带水） */
  scrollToTop() {
    if (typeof wx === 'undefined' || typeof wx.pageScrollTo !== 'function') return
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
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
