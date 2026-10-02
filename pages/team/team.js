/**
 * 球队详情页
 *
 * 一支球队的三件套：排名 + 近期战绩 + 未来赛程，外加一键关注。
 *
 * 数据来源：
 *   · 排名      data.teamStanding()（官方积分榜 / 自算）
 *   · 近期战绩  data.teamForm()（本地快照内的已结束比赛）
 *   · 未来赛程  data.teamUpcoming()
 *
 * ⚠️ form 只能代表「快照窗口内的近期状态」，不等于赛季总战绩 —— 页面文案按这个口径写，
 *    别写成「近 5 轮」这种会让人误解为官方轮次的说法。
 *
 * ⚠️ 这是页面层：新增 / 改动都要发版。
 */
const share = require('../../utils/share')
const data = require('../../utils/data')
const view = require('../../utils/view')
const fmt = require('../../utils/format')
const follows = require('../../utils/team-follows')
const { appInstance } = require('../../utils/app-instance')

const FORM_N = 5
const UPCOMING_N = 8

const RESULT_ZH = { W: '胜', D: '平', L: '负', U: '—' }

/** 战绩视图模型：WXML 里不做复杂表达式，统一在这里算好 */
function buildForm(list) {
  return list.map((f) => ({
    result: f.result,
    resultZh: RESULT_ZH[f.result] || '—',
    opponent: f.opponent,
    scoreText: f.scoreText,
    isHome: f.isHome,
    vs: f.isHome ? '主' : '客',
    dateLabel: fmt.dayLabel(f.date),
    id: f.match.id,
  }))
}

Page({
  data: {
    comp: '',
    id: '',
    compName: '',
    accent: '#6B7280',
    name: '-',
    abbr: '',
    // 排名概览
    standing: null,
    standingLine: '',
    groupName: '',
    // 战绩
    form: [],
    formSummary: '',
    // 赛程
    matches: [],
    hasStandings: false,
    followed: false,
    loadError: '',
  },

  onLoad(query) {
    const comp = query && query.comp ? decodeURIComponent(query.comp) : ''
    const id = query && query.id ? decodeURIComponent(query.id) : ''
    if (!comp || !id) {
      this.setData({ loadError: '缺少球队参数，请从积分榜或球队列表重新进入。' })
      return
    }
    this.setData({ comp, id })
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
      self.render()
      wx.stopPullDownRefresh()
    })
  },

  /** 队名优先取积分榜（那里一定有），快照里没有也能显示 */
  teamInfo() {
    const row = data.teamStanding(this.data.comp, this.data.id)
    const pool = data.teamsOf(this.data.comp)
    const idStr = String(this.data.id)
    const fromPool = pool.find((t) => String(t.id) === idStr)
    const name = (row && (row.zh || row.name)) || (fromPool && fromPool.display) || this.data.id
    return {
      row,
      fromPool,
      name,
      abbr: (fromPool && fromPool.abbr) || (row && row.abbr) || '',
      color: (fromPool && fromPool.color) || data.compOf(this.data.comp).accent,
    }
  },

  render() {
    const info = this.teamInfo()
    const comp = data.compOf(this.data.comp)
    const table = data.standingsOf(this.data.comp)
    const row = info.row

    let standingLine = ''
    if (row) {
      const parts = [`第 ${row.pos} 位`]
      if (row.group) parts.push(row.group)
      if (typeof row.played === 'number') parts.push(`${row.played} 场`)
      if (typeof row.wins === 'number' && typeof row.losses === 'number') {
        const draws = typeof row.draws === 'number' ? `${row.draws} 平 ` : ''
        parts.push(`${row.wins} 胜 ${draws}${row.losses} 负`)
      }
      if (typeof row.pts === 'number') parts.push(`${row.pts} 分`)
      if (typeof row.winPct === 'number' && typeof row.pts !== 'number') {
        parts.push(`胜率 ${(row.winPct * 100).toFixed(1)}%`)
      }
      standingLine = parts.join(' · ')
    }

    const form = data.teamForm(this.data.comp, this.data.id, FORM_N)
    const upcoming = data.teamUpcoming(this.data.comp, this.data.id, UPCOMING_N)
    const wld = { W: 0, D: 0, L: 0 }
    form.forEach((f) => { if (wld[f.result] != null) wld[f.result] += 1 })
    const formSummary = form.length
      ? (wld.D ? `${wld.W} 胜 ${wld.D} 平 ${wld.L} 负` : `${wld.W} 胜 ${wld.L} 负`)
      : ''

    const teamObj = {
      comp: this.data.comp,
      id: this.data.id,
      name: info.name,
      zh: info.name,
      abbr: info.abbr,
      color: info.color,
      display: info.name,
    }

    this.setData({
      compName: comp.name,
      accent: comp.accent,
      name: info.name,
      abbr: info.abbr,
      standing: row,
      standingLine,
      groupName: (row && row.group) || '',
      hasStandings: !!table,
      form: buildForm(form),
      formSummary,
      matches: view.decorateList(upcoming, { compOf: (k) => data.compOf(k) }),
      followed: follows.has(this.data.comp, this.data.id),
      _team: teamObj,
    })
  },

  onFollowTap() {
    const res = follows.toggle(this.data._team)
    this.setData({ followed: res.followed })
    wx.showToast({
      title: res.followed ? `已关注 ${this.data.name}` : `已取消关注`,
      icon: 'none',
      duration: 1200,
    })
  },

  onMatchTap(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}` })
  },

  onFormTap(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}` })
  },

  /** 去看这支球队所有比赛（跳到赛程页并带上筛选） */
  goSchedule() {
    const app = appInstance()
    app.globalData.pendingComp = this.data.comp
    app.globalData.pendingTeam = {
      comp: this.data.comp,
      id: this.data.id,
      display: this.data.name,
      color: this.data.accent,
    }
    wx.switchTab({ url: '/pages/schedule/schedule' })
  },

  goRank() {
    if (!this.data.hasStandings) return
    wx.navigateTo({ url: `/pages/rank/rank?comp=${encodeURIComponent(this.data.comp)}` })
  },

  onShareAppMessage() {
    return share.message({
      title: `${this.data.name} · ${this.data.compName}赛程${this.data.standingLine ? '（' + this.data.standingLine + '）' : ''}`,
      path: `/pages/team/team?comp=${encodeURIComponent(this.data.comp)}&id=${encodeURIComponent(String(this.data.id))}`,
    })
  },

  onShareTimeline() {
    return share.timeline({
      title: `${this.data.name} · ${this.data.compName}赛程与排名`,
      query: `comp=${encodeURIComponent(this.data.comp)}&id=${encodeURIComponent(String(this.data.id))}`,
    })
  },
})
