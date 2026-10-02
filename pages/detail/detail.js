const share = require('../../utils/share')
const poster = require('../../utils/poster')
const data = require('../../utils/data')
const view = require('../../utils/view')
const fmt = require('../../utils/format')
const favorites = require('../../utils/favorites')
const { appInstance } = require('../../utils/app-instance')

const RESULT_ZH = { W: '胜', D: '平', L: '负' }

/**
 * 把云端详情整理成页面直接可用的形状。
 *
 * 两处需要算而不能直出：
 *  ① 换人事件一场能有 8~10 条，全铺开会比进球/牌多几倍，默认折叠掉。
 *  ② 技术统计的对比条要归一化到 100：计数类（射门）按占比分，
 *     百分比类（控球率、传球成功率）用主队值，客队补 100-h —— 否则两条加起来
 *     超过 100 会把容器撑破。
 */
function decorateDetail(d, match) {
  const sideName = (side) => (match[side] && (match[side].zhName || match[side].name)) || ''
  // ⚠️ 必须把队名拼进类型 —— 光有圆点颜色分不出主客（两队队服常同色系），
  //    用户真机反馈「进球只有球员名，不知道是哪个队」
  const events = (d.events || []).map((e, i) => {
    const teamName = e.side ? sideName(e.side) : ''
    return {
      idx: i,
      m: e.m,
      t: e.t,
      s: e.s,
      side: e.side,
      teamName,
      tLabel: e.t + (teamName ? ` · ${teamName}` : ''),
      goal: !!e.goal,
      key: e.t !== '换人',
    }
  })
  const keyEvents = events.filter((e) => e.key)
  // 对比条：两边都从中间往外长，**值大的那边占满自己那一半**，小的按比例缩。
  // 用「值 / 最大值」而不是「值 / 总和」—— 这样控球率 53.7/46.3 和射门 12/19
  // 看起来是同一种语义（谁强谁满），不会出现 54%+46% 两边都半截的怪相。
  const stats = (d.stats || []).map((s) => {
    const hs = String(s.h)
    const as = String(s.a)
    const h = parseFloat(hs.replace('%', '')) || 0
    const a = parseFloat(as.replace('%', '')) || 0
    const max = Math.max(h, a, 1)
    const hp = Math.round((h / max) * 100)
    const ap = Math.round((a / max) * 100)
    return { k: s.k, h: hs, a: as, hp, ap }
  })
  const formRows = ['home', 'away']
    .map((side) => ({
      idx: side,
      side: sideName(side),
      list: ((d.form && d.form[side]) || []).map((g, i) => ({
        i,
        at: g.at,
        opp: g.opp,
        sc: g.sc,
        r: g.r,
        rText: RESULT_ZH[g.r] || '',
      })),
    }))
    .filter((r) => r.list.length)
  const h2h = d.h2h
    ? Object.assign({}, d.h2h, {
        list: (d.h2h.list || []).map((e, i) => Object.assign({ i }, e)),
      })
    : null
  return {
    events,
    keyEvents,
    shownEvents: keyEvents,
    subCount: events.length - keyEvents.length,
    hasTimeline: events.length > 0,
    stats,
    hasStats: stats.length > 0,
    formRows,
    hasForm: formRows.length > 0,
    h2h,
    hasH2H: !!(h2h && h2h.list && h2h.list.length),
  }
}

Page({
  data: {
    match: null,
    comp: null,
    rows: [],
    isFav: false,
    favBusy: false,
    authState: 'unknown',
    hasStandings: false,  // 该赛事有没有积分榜（有才显示入口）
    detail: null,        // 比赛详情（事件时间轴 / 近况 / 交锋 / 技术统计），没有就整块隐藏
    detailAll: false,    // 是否展开换人事件
    shareImage: '',      // 转发卡图（离屏 canvas 画好后存这里）
    loading: false,
    loadError: '',
  },

  /**
   * ⚠️ 从分享卡片进来时，本地包里的比分几乎一定是过期的 —— 比分每 15 分钟由
   *   同步任务写进云端，而 data/matches.js 是发版那一刻的快照。
   *   以前这里只读本地包，结果别人点开分享看到的是「还没比分」的比赛。
   *   现在改成：本地先落地渲染（秒开），再拉一次云端并重新渲染。
   */
  async onLoad(query) {
    const id = query && query.id ? decodeURIComponent(query.id) : ''
    this.matchId = id

    // 1) 本地有的先渲染 —— 不等网络，点开分享立刻能看到内容
    const raw = data.findMatch(id)
    if (raw) {
      this.applyMatch(raw)
    } else {
      this.setData({ loading: true })
    }

    // 2) 再拉云端补最新比分（本地包是发版那一刻的快照，比分一定落后）。
    //    加超时兜底：网络差的时侯不能让页面一直停在加载态，本地数据已经渲染出来了，够了。
    const r = await Promise.race([
      data.refresh(),
      new Promise((resolve) => setTimeout(() => resolve({ updated: false, reason: 'timeout' }), 6000)),
    ])
    if (r && r.updated) {
      const fresh = data.findMatch(id)
      if (fresh) this.applyMatch(fresh)
    }
    if (!this.data.match) {
      this.setData({
        loading: false,
        loadError: '找不到这场比赛，它可能已经从赛程里下架了。',
      })
    }
  },

  /**
   * 比赛详情：独立于主流程异步加载，拿不到就整块不显示。
   * 详情只覆盖「进行中 + 近 48 小时已结束」的比赛，老比赛本来就没有，这不是错误。
   */
  async loadDetail(match) {
    const raw = await data.matchDetail(match)
    if (!raw || !this.data.match || this.data.match.id !== match.id) return
    this.setData({ detail: decorateDetail(raw, match), detailAll: false })
  },

  onToggleSubs() {
    const d = this.data.detail
    if (!d) return
    const next = !this.data.detailAll
    this.setData({ 'detail.shownEvents': next ? d.events : d.keyEvents, detailAll: next })
  },

  /** 用一场比赛对象刷新整页（onLoad 与云端回补共用同一套逻辑） */
  applyMatch(raw) {
    const app = appInstance()
    const match = view.decorate.call({ compOf: data.compOf }, raw)
    const comp = data.compOf(match.comp)
    const rows = [
      { label: '开赛时间', value: `${fmt.dayLabel(match.date)} ${match.time}（北京时间）` },
      { label: '比赛状态', value: match.status === 'upcoming' ? `未开始 · ${fmt.countdownText(match.start)}` : match.status === 'live' ? '进行中' : (match.statusText || '已结束') },
      { label: '所属阶段', value: match.stage || comp.full },
    ]
    if (match._bo) rows.push({ label: '赛制', value: match._bo + ' 淘汰制' })
    if (match.venue) rows.push({ label: '比赛场地', value: match.venue })
    if (match.broadcast && match.broadcast.length) rows.push({ label: '转播', value: match.broadcast.join(' / ') })
    rows.push({ label: '赛事', value: comp.full })

    this.setData({
      match,
      comp,
      rows,
      loading: false,
      loadError: '',
      isFav: app.isFav(match.id),
      authState: app.globalData.authState,
      hasStandings: !!data.standingsOf(match.comp),
    }, () => {
      this.buildShareImage()
      this.loadDetail(match)
    })
  },

  /**
   * 转发卡图：画「对阵双方 + 比分」。
   * 必须提前画 —— onShareAppMessage 是同步的，等分享时再画来不及。
   */
  async buildShareImage() {
    const m = this.data.match
    const comp = this.data.comp || {}
    if (!m) return
    const img = await poster.build(this, 'share-canvas', 'match', {
      comp: comp.full || comp.name || '',
      stage: m.stage || '',
      home: m.home.zhName || m.home.name,
      away: m.away.zhName || m.away.name,
      homeScore: m.home.score,
      awayScore: m.away.score,
      dateText: fmt.dayLabel(m.date),
      timeText: m.time,
      statusText: m.status === 'upcoming' ? '未开始' : (m.statusText || '已结束'),
      accent: comp.accent || '#2E7CF6',
    })
    if (img) this.setData({ shareImage: img })
  },

  onShow() {
    const app = appInstance()
    // 从后台切回来时同步一次：进行中的比分可能已经变了
    if (this.matchId) {
      data.refresh().then((r) => {
        if (!r || !r.updated) return
        const m2 = data.findMatch(this.matchId)
        if (m2 && m2 !== this.data.match) this.applyMatch(m2)
      })
    }
    if (!this.data.match) return
    this.setData({
      isFav: app.isFav(this.data.match.id),
      authState: app.globalData.authState,
    })
  },

  async onFavTap() {
    const app = appInstance()
    if (this.data.favBusy) return
    this.setData({ favBusy: true })

    if (app.globalData.authState !== 'signed-in') {
      await app.refreshAuth()
      this.setData({ authState: app.globalData.authState })
    }
    if (app.globalData.authState === 'unavailable') {
      wx.showModal({
        title: '云服务未就绪',
        content: '关注功能需要云服务支持。请在微信开发者工具中执行「构建 npm」后重新预览。',
        showCancel: false,
      })
      this.setData({ favBusy: false })
      return
    }
    if (app.globalData.authState !== 'signed-in') {
      wx.showModal({
        title: '需要登录',
        content: '登录后才能把比赛收藏到「我的」，换设备也不会丢失。要现在去登录吗？',
        confirmText: '去登录',
        cancelText: '稍后',
        success: (res) => {
          if (res.confirm) wx.switchTab({ url: '/pages/mine/mine' })
        },
      })
      this.setData({ favBusy: false })
      return
    }

    const match = this.data.match
    if (this.data.isFav) {
      const res = await favorites.remove(match.id)
      if (res.error) wx.showToast({ title: res.error.message, icon: 'none' })
      await app.refreshFavorites()
      this.setData({ isFav: app.isFav(match.id) })
    } else {
      const res = await favorites.add(match)
      if (res.error) {
        wx.showToast({ title: res.error.message, icon: 'none' })
      } else {
        wx.showToast({ title: '已加入关注', icon: 'success' })
      }
      await app.refreshFavorites()
      this.setData({ isFav: app.isFav(match.id) })
    }
    this.setData({ favBusy: false })
  },

  onCompTap() {
    const app = appInstance()
    const comp = this.data.comp
    if (!comp) return
    app.globalData.pendingComp = comp.key
    wx.switchTab({ url: '/pages/schedule/schedule' })
  },
  /** 点队名 → 球队详情页（排名 / 近期战绩 / 未来赛程） */
  onTeamTap(e) {
    const m = this.data.match
    if (!m) return
    const side = (e.currentTarget.dataset || {}).side
    const team = side === 'home' ? m.home : m.away
    // 未确定的对阵（待定 / TBD）不是一支球队，点了也没东西可看
    if (!team || !team.id || String(team.id) === 'TBD' || team.name === '待定') return
    wx.navigateTo({
      url: `/pages/team/team?comp=${encodeURIComponent(m.comp)}&id=${encodeURIComponent(String(team.id))}`,
      fail() {
        wx.showToast({ title: '暂时打不开球队页', icon: 'none' })
      },
    })
  },

  onStandingsTap() {
    const m = this.data.match
    if (!m) return
    wx.navigateTo({ url: `/pages/rank/rank?comp=${encodeURIComponent(m.comp)}` })
  },

  onShareAppMessage() {
    const m = this.data.match
    if (!m) return share.message()
    const h = m.home.zhName || m.home.name
    const a = m.away.zhName || m.away.name
    const hasScore = typeof m.home.score === 'number' && typeof m.away.score === 'number'
    // 有比分就把结果写进标题，比「赛程与比分」更值得点；没比分用 VS（与卡图一致）
    const tail = hasScore ? `${m.home.score}-${m.away.score}` : (m.status === 'live' ? '进行中' : 'VS')
    return share.message({
      title: `${h} ${tail} ${a}`,
      path: `/pages/detail/detail?id=${encodeURIComponent(m.id)}`,
      imageUrl: this.data.shareImage,
    })
  },

  onShareTimeline() {
    const m = this.data.match
    if (!m) return share.timeline()
    const h = m.home.zhName || m.home.name
    const a = m.away.zhName || m.away.name
    const hasScore = typeof m.home.score === 'number' && typeof m.away.score === 'number'
    const tail = hasScore ? `${m.home.score}-${m.away.score}` : 'VS'
    return share.timeline({
      title: `${h} ${tail} ${a}`,
      imageUrl: this.data.shareImage,
    })
  },
})

module.exports = { decorateDetail }
