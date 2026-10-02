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

/** 把一行积分榜数据压成 WXML 能直接渲染的形状 */
function renderRow(row, columns, compKey, zones) {
  const cells = columns.map((col) => {
    const raw = row[col.key]
    if (col.key === 'winPct') {
      return typeof raw === 'number' ? `${(raw * 100).toFixed(1)}%` : '—'
    }
    if (col.key === 'ppg' || col.key === 'oppg') {
      return typeof raw === 'number' ? String(raw) : '—'
    }
    if (col.key === 'diff') {
      if (typeof raw !== 'number') return '—'
      return raw > 0 ? `+${raw}` : String(raw)
    }
    if (col.key === 'streak') return raw || '—'
    return raw === null || raw === undefined ? '—' : String(raw)
  })

  const zone = (zones || []).find((z) => row.pos >= z.from && row.pos <= z.to) || null

  return {
    id: row.id,
    comp: compKey,
    pos: row.pos,
    name: row.zh || row.name,
    abbr: row.abbr || '',
    cells,
    zoneLabel: zone ? zone.label : '',
    zoneColor: zone ? zone.color : '',
    note: row.note || '',
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
      this.setData({ activeComp: pending })
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

    const zones = table.zones || []
    const groups = (table.groups || []).map((g) => ({
      name: g.name || '',
      rows: (g.rows || []).map((r) => renderRow(r, table.columns, comp, zones)),
    }))
    const totalTeams = groups.reduce((n, g) => n + g.rows.length, 0)

    this.setData({
      activeComp: comp,
      compName: data.compOf(comp).name,
      columns: table.columns,
      groups,
      season: table.season || '',
      totalTeams,
      updatedAt: timeLabel(data.standingsGeneratedAt()),
      source: data.source() === 'cloud' ? '云端' : '本地',
      emptyReason: '',
    })
  },

  onCompTap(e) {
    this.setData({ activeComp: e.currentTarget.dataset.key }, () => this.render())
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
