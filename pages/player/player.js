/**
 * 球员详情页
 *
 * 一个球员的三件套：**档案 + 赛季数据 + 所属球队入口**。
 *
 * 数据来源：
 *   · 档案      data.playerProfile()（云表 team_roster，含位置/年龄/国籍/身高体重）
 *   · 赛季数据  data.scorerRow()（该赛事的官方射手榜，**同一份数据，不另抓**）
 *   · 球队      router 里带上 comp + teamId，一键回球队页
 *
 * ⚠️ 三条纪律（改前先看）：
 *   1. **没有档案也要能用**：名册里查不到（转会了？名单还没抓到？）就显示兜底文案，
 *      绝不白屏。球员的名字从 roster 行里拿；拿不到就退回英文短名。
 *   2. 赛季数据是**可选的**：只有进了射手榜/助攻榜的人才有进球助攻，
 *      后卫门将没有很正常 —— 没有就把这一块藏掉，别留空表。
 *   3. 中文名缺失是**预期状态**（球员中文名已停止主动补种），显示英文短名不是 bug。
 *
 * ⚠️ 这是页面层：新增 / 改动都要发版。
 */
const share = require('../../utils/share')
const data = require('../../utils/data')

/** 档案字段的展示口径：空的一律不显示，不写「未知」这种占位噪声 */
function buildProfile(p) {
  const rows = []
  if (p.pn) rows.push({ k: '位置', v: p.pn })
  if (p.j) rows.push({ k: '球衣号', v: `${p.j} 号` })
  if (p.ag) rows.push({ k: '年龄', v: `${p.ag} 岁` })
  if (p.dob) rows.push({ k: '生日', v: p.dob })
  const nation = p.cz || p.c
  if (nation) rows.push({ k: '国籍', v: nation })
  if (p.h) rows.push({ k: '身高', v: p.h })
  if (p.w) rows.push({ k: '体重', v: p.w })
  if (p.bp) rows.push({ k: '出生地', v: p.bp })
  return rows
}

/** 赛季数据：只有非零的项才有意义（0 助攻写上去是在凑数） */
function buildStats(row) {
  if (!row) return []
  const rows = []
  if (row.p != null) rows.push({ k: '出场', v: String(row.p) })
  if (row.g != null) rows.push({ k: '进球', v: String(row.g) })
  if (row.a != null) rows.push({ k: '助攻', v: String(row.a) })
  return rows.filter((r) => r.v !== '0')
}

Page({
  data: {
    comp: '',
    teamId: '',
    athleteId: '',
    compName: '',
    accent: '#6B7280',
    teamName: '',
    name: '',
    enName: '',
    jersey: '',
    posZh: '',
    profile: [],
    stats: [],
    season: '',
    hasStats: false,
    loadError: '',
    loading: true,
    _noProfile: false,
  },

  onLoad(query) {
    const comp = query && query.comp ? decodeURIComponent(query.comp) : ''
    const teamId = query && query.team ? decodeURIComponent(query.team) : ''
    const athleteId = query && query.id ? decodeURIComponent(query.id) : ''
    if (!comp || !teamId || !athleteId) {
      this.setData({ loadError: '缺少球员参数，请从球队名单重新进入。', loading: false })
      return
    }
    this.setData({ comp, teamId, athleteId })
    const c = data.compOf(comp)
    this.setData({ compName: c.name, accent: c.accent })
    this.render()
  },

  onShow() {
    if (this.data.loadError) return
    this.render()
    data.refresh().then((r) => { if (r.updated) this.render() })
  },

  onPullDownRefresh() {
    const self = this
    data.refresh().then(() => {
      self.render(true)
      wx.stopPullDownRefresh()
    })
  },

  render() {
    // 赛季数据是同步的本地表；档案是异步云端。
    // ⚠️ 先渲染同步部分，档案到了再补 —— 不然整个页面要等一个网络往返才出字。
    const row = data.scorerRow(this.data.comp, this.data.athleteId)
    const stats = buildStats(row)
    this.setData({
      stats,
      hasStats: stats.length > 0,
      season: (data.scorersOf(this.data.comp) || {}).season || '',
    })

    data.playerProfile(this.data.comp, this.data.teamId, this.data.athleteId)
      .then((res) => {
        if (!res || !res.player) {
          // 名册里没有这个人。名字就用射手榜那一行（至少有英文短名），不白屏。
          const fallback = data.scorerRow(this.data.comp, this.data.athleteId)
          this.setData({
            loading: false,
            name: (fallback && fallback.z) || (fallback && fallback.s) || '该球员',
            enName: fallback && fallback.z ? fallback.s || '' : '',
            profile: [],
            _noProfile: true,
          })
          return
        }
        const p = res.player
        this.setData({
          loading: false,
          teamName: res.team || '',
          name: p.z || p.s || p.n || '该球员',
          enName: p.z ? (p.s || p.n || '') : '',
          jersey: p.j || '',
          posZh: p.pn || '',
          profile: buildProfile(p),
          _noProfile: false,
        })
      })
      .catch(() => {
        this.setData({ loading: false, _noProfile: true })
      })
  },

  /** 回所属球队页 */
  goTeam() {
    if (!this.data.teamId) return
    wx.navigateTo({
      url: `/pages/team/team?comp=${encodeURIComponent(this.data.comp)}`
        + `&id=${encodeURIComponent(String(this.data.teamId))}`,
    })
  },

  onShareAppMessage() {
    return share.message({
      title: `${this.data.name}${this.data.posZh ? ' · ' + this.data.posZh : ''} · ${this.data.compName}`,
      path: `/pages/player/player?comp=${encodeURIComponent(this.data.comp)}`
        + `&team=${encodeURIComponent(String(this.data.teamId))}`
        + `&id=${encodeURIComponent(String(this.data.athleteId))}`,
    })
  },

  onShareTimeline() {
    return share.timeline({
      title: `${this.data.name} · ${this.data.compName}球员资料`,
      query: `comp=${encodeURIComponent(this.data.comp)}`
        + `&team=${encodeURIComponent(String(this.data.teamId))}`
        + `&id=${encodeURIComponent(String(this.data.athleteId))}`,
    })
  },
})
