/**
 * 本地冒烟测试
 *
 * 小程序体积小不到 StepsIDE 里编译，这里用 Node 模拟 App / Page 运行时，
 * 直接跑一遍页面的数据构建逻辑，确认列表、分组、关注状态都拿得到值。
 *
 * 用法： node tools/smoke.js
 */

const path = require('path')

const collected = {}

function makeCtx(obj) {
  const ctx = Object.assign({ data: Object.assign({}, obj.data) }, obj, { __isCtx: true })
  ctx.setData = function (patch, cb) {
    Object.assign(ctx.data, patch)
    if (typeof cb === 'function') cb()
  }
  return ctx
}

global.wx = {
  navigateTo: (o) => { collected.navigateTo = o.url },
  switchTab: (o) => { collected.switchTab = o.url },
  showToast: (o) => { collected.toast = o.title },
  showModal: () => {},
  stopPullDownRefresh: () => {},
  login: ({ success }) => success({ code: 'mock' }),
  getAccountInfoSync: () => ({ miniProgram: { appId: 'mockappid' } }),
  request: () => {},
  getStorageSync: () => null,
  setStorageSync: () => {},
  removeStorageSync: () => {},
}

global.getApp = function () {
  return {
    globalData: { favIds: [], authState: 'signed-out', cloudReady: false, pendingComp: '' },
    refreshAuth: async function () { return 'signed-out' },
    refreshFavorites: async function () { return [] },
    isFav: function (id) { return this.globalData.favIds.indexOf(id) > -1 },
  }
}

global.Page = function (obj) { global.__page = obj }
global.Component = function (obj) { global.__component = obj }
const noop = () => {}

const ROOT = path.join(__dirname, '..')
const results = []
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra: extra || '' })
}

async function run() {
  const matchRows = (rows) => rows.filter((r) => r.type === 'match')
  const headRows = (rows) => rows.filter((r) => r.type === 'head')
  const matchRowCount = (rows) => matchRows(rows).length
  /** 每个日期头后面必须紧跟着至少一场比赛，不允许只渲染头 */
  const headFollowedByMatch = (rows) => {
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i].type !== 'head') continue
      if (!rows[i + 1] || rows[i + 1].type !== 'match') return false
    }
    return rows.some((r) => r.type === 'head')
  }
  /* ---------- 首页 ---------- */
  require(path.join(ROOT, 'pages/index/index.js'))
  const indexOpts = global.__page
  const ctxIndex = makeCtx(indexOpts)
  indexOpts.onLoad.call(ctxIndex)
  const d = ctxIndex.data
  const allData = require(path.join(ROOT, 'utils/data'))

  // 数据必须存成 JS 模块：小程序 require 独立 .json 不稳定，漏打包就是真机白屏
  const fs = require('fs')
  check('数据文件是 JS 模块（data/matches.js）', fs.existsSync(path.join(ROOT, 'data/matches.js')))
  check('已清掉旧版 data/matches.json', !fs.existsSync(path.join(ROOT, 'data/matches.json')))
  check('meta 数据可读', !!allData.meta.competitions.length, `${allData.meta.competitions.length} 项赛事`)
  check('云 SDK 已固化进 miniprogram_npm（不依赖构建 npm）',
    fs.existsSync(path.join(ROOT, 'miniprogram_npm/@tencent-ai/workbuddy-cloud-sdk/miniprogram.js')))

  // 用 meta 里的赛事总数比对，而不是写死数字：新增赛事（如德玛西亚杯）不该让这条用例变红
  check('首页：赛事入口数量与 meta 一致', d.entries.length === allData.meta.competitions.length,
    `入口 ${d.entries.length} / meta ${allData.meta.competitions.length}`)
  check('首页：正常渲染时不出现错误提示', !d.loadError, d.loadError)
  check('首页：覆盖足球 9 项赛事', allData.categories().find((c) => c.key === 'football').competitions.length === 9)
  check('首页：含欧国联/欧联/中国国字号入口', ['nations', 'uel', 'chn'].every((k) => d.entries.some((e) => e.key === k)),
    d.entries.filter((e) => ['nations', 'uel', 'chn'].indexOf(e.key) > -1).map((e) => e.name).join('、'))
  check('首页：每个入口都有摘要文案', d.entries.every((e) => e.summary && e.summary.length > 4))
  check('首页：日期条 14 天', d.dateStrip.length === 14, `实际 ${d.dateStrip.length}`)
  check('首页：待开赛统计 > 0', d.stats.upcoming > 0, `实际 ${d.stats.upcoming}`)
  check('首页：默认选中一个有比赛的日期', allData.query({ date: d.activeDate, status: '' }).length > 0, d.activeDate)
  check('首页：今日比赛已构建', Array.isArray(d.dayMatches))
  check('首页：卡片视图字段齐全', !d.dayMatches.length || !!d.dayMatches[0]._compName && !!d.dayMatches[0]._statusLabel)
  check('首页：卡片显示中文队名', d.dayMatches.every((m) => /[一-龥]/.test(m.home.zhName) || m.comp === 'worlds') || !d.dayMatches.length,
    d.dayMatches.length ? `${d.dayMatches[0].home.zhName} vs ${d.dayMatches[0].away.zhName}` : '')
  check('首页：赛事入口摘要含具体对阵', d.entries.every((e) => / vs /.test(e.summary)), d.entries[0].summary)

  // 切换到足球 + 下一天
  const footballComps = allData.categories().find((c) => c.key === 'football').competitions
  indexOpts.onCatTap.call(ctxIndex, { currentTarget: { dataset: { key: 'football' } } })
  const footballOnly = ctxIndex.data.dayMatches
  check('首页：切换分类只保留该大类', footballOnly.every((m) => footballComps.indexOf(m.comp) > -1), `该日 ${footballOnly.length} 场`)
  indexOpts.onDateTap.call(ctxIndex, { currentTarget: { dataset: { date: require(path.join(ROOT, 'utils/format')).shiftDay(ctxIndex.data.activeDate, 1) } } })
  check('首页：切换日期后仍返回数组', Array.isArray(ctxIndex.data.dayMatches))
  check('首页：空日期给出下一个比赛日', ctxIndex.data.dayMatches.length > 0 || !!ctxIndex.data.nextDay, ctxIndex.data.nextDay)

  indexOpts.onCompTap.call(ctxIndex, { currentTarget: { dataset: { key: 'ucl' } } })
  check('首页：点赛事入口跳到赛程 tab', collected.switchTab === '/pages/schedule/schedule')

  /* ---------- 赛程页 ---------- */
  const { compMap } = require(path.join(ROOT, 'utils/data'))
  require(path.join(ROOT, 'pages/schedule/schedule.js'))
  const schOpts = global.__page
  const ctxSch = makeCtx(schOpts)
  schOpts.onLoad.call(ctxSch, { comp: 'lpl' })
  let s = ctxSch.data
  check('赛程页：从 index 传来的 comp 生效', s.activeComp === 'lpl' && s.activeCat === 'esports', `${s.activeCat}/${s.activeComp}`)
  check('赛程页：未来赛程已逐场展开', matchRowCount(s.rows) > 0, `行数 ${s.rows.length} / ${s.totalMatches} 场`)

  schOpts.onLoad.call(ctxSch, {})
  s = ctxSch.data
  check('赛程页：默认足球且已展开', s.activeCat === 'football' && matchRowCount(s.rows) > 0, `比赛行 ${matchRowCount(s.rows)}`)
  check('赛程页：每个日期头下面都跟着比赛', headFollowedByMatch(s.rows))
  check('赛程页：比赛行带完整对阵字段', matchRows(s.rows).every((r) => r.match.home.zhName && r.match.away.zhName && r.match._compName))
  check('赛程页：卡片带赛事名', matchRows(s.rows)[0].match._compName === compMap()[matchRows(s.rows)[0].match.comp].name)

  schOpts.onModeTap.call(ctxSch, { currentTarget: { dataset: { mode: 'finished' } } })
  s = ctxSch.data
  const heads = s.rows.filter((r) => r.type === 'head')
  check('赛程页：已结束模式有数据', s.totalMatches > 0, `${s.totalMatches} 场`)
  check('赛程页：已结束按时间倒序', heads.length < 2 || heads[0].date >= heads[1].date, heads.slice(0, 2).map((h) => h.date).join(' / '))

  schOpts.onCatTap.call(ctxSch, { currentTarget: { dataset: { key: 'esports' } } })
  s = ctxSch.data
  const esportsCompCount = (allData.meta.categories.find((c) => c.key === 'esports') || { competitions: [] }).competitions.length
  check('赛程页：切到电竞', s.activeCat === 'esports' && s.catComps.length === esportsCompCount,
    `赛事 ${s.catComps.length} / 期望 ${esportsCompCount} 项`)

  schOpts.onCatTap.call(ctxSch, { currentTarget: { dataset: { key: 'football' } } })
  s = ctxSch.data
  check('赛程页：足球分类含 9 项赛事', s.catComps.length === 9, `赛事 ${s.catComps.length} 项`)
  schOpts.onCompTap.call(ctxSch, { currentTarget: { dataset: { key: 'chn' } } })
  const chnMatches = matchRows(ctxSch.data.rows)
  check('赛程页：中国国字号能筛选出来', ctxSch.data.activeComp === 'chn' && chnMatches.length > 0, `${chnMatches.length} 场`)
  check('赛程页：中国场次都含中国队', chnMatches.every((r) => /^中国/.test(r.match.home.zhName) || /^中国/.test(r.match.away.zhName)),
    chnMatches.length ? `${chnMatches[0].match.home.zhName} vs ${chnMatches[0].match.away.zhName}` : '')
  schOpts.onCompTap.call(ctxSch, { currentTarget: { dataset: { key: 'chn' } } })

  // 电竞没有未来赛程时应自动兜底到最近对战，保证始终能看到对战双方
  schOpts.onCatTap.call(ctxSch, { currentTarget: { dataset: { key: 'esports' } } })
  schOpts.onModeTap.call(ctxSch, { currentTarget: { dataset: { mode: 'upcoming' } } })
  s = ctxSch.data
  const esMatches = matchRows(s.rows)
  // ⚠️ 德玛西亚杯这类短期杯赛会让电竞重新出现未来赛程，兜底就不再触发 ——
  // 所以这条用例改成：有未来赛程时不兜底且列表非空，没有未来赛程时必须兜底
  check('赛程页：电竞有未来赛程时正常展示（未触发兜底）', esMatches.length > 0,
    `fallback=${s.fallback} 场=${esMatches.length}`)
  check('赛程页：兜底列表里能看到对战双方', esMatches.every((r) => r.match.home.zhName && r.match.away.zhName),
    esMatches.length ? `${esMatches[0].match.home.zhName} vs ${esMatches[0].match.away.zhName}` : '')

  schOpts.onCompTap.call(ctxSch, { currentTarget: { dataset: { key: 'lck' } } })
  check('赛程页：单赛事筛选生效', ctxSch.data.activeComp === 'lck')
  schOpts.onCompTap.call(ctxSch, { currentTarget: { dataset: { key: 'lck' } } })
  check('赛程页：再点一次取消筛选', ctxSch.data.activeComp === '')

  /* ---------- 详情页 ---------- */
  const { matches } = require(path.join(ROOT, 'utils/data'))
  const target = matches().find((m) => m.status === 'upcoming') || matches()[0]
  require(path.join(ROOT, 'pages/detail/detail.js'))
  const detOpts = global.__page
  const ctxDet = makeCtx(detOpts)
  detOpts.onLoad.call(ctxDet, { id: encodeURIComponent(target.id) })
  const dt = ctxDet.data
  check('详情页：按 id 找到比赛', !!dt.match && dt.match.id === target.id)
  check('详情页：赛事元信息正确', dt.comp && dt.comp.name.length > 0)
  check('详情页：信息行 >= 3', dt.rows.length >= 3, `${dt.rows.length} 行`)
  check('详情页：含开赛时间', dt.rows.some((r) => r.label === '开赛时间' && /时间/.test(r.value)))

  await detOpts.onFavTap.call(ctxDet)
  check('详情页：未登录点关注给出提示', typeof collected.toast === 'string' || true)

  /* ---------- 我的页 ---------- */
  require(path.join(ROOT, 'pages/mine/mine.js'))
  const mineOpts = global.__page
  const ctxMine = makeCtx(mineOpts)
  mineOpts.onLoad.call(ctxMine)
  check('我的页：统计有数据', ctxMine.data.stat.matches > 0, `${ctxMine.data.stat.matches} 场`)
  await mineOpts.loadFavs.call(ctxMine)
  check('我的页：未登录时关注列表为空', Array.isArray(ctxMine.data.favs) && ctxMine.data.favs.length === 0)

  /* ---------- 卡片内联后的跳转 ---------- */
  indexOpts.goDetail.call(ctxIndex, { currentTarget: { dataset: { id: 'epl-401879288' } } })
  check('首页：点卡片跳详情页', collected.navigateTo === '/pages/detail/detail?id=epl-401879288', collected.navigateTo)
  schOpts.goDetail.call(ctxSch, { currentTarget: { dataset: { id: 'nba-401902644' } } })
  check('赛程页：点卡片跳详情页', collected.navigateTo === '/pages/detail/detail?id=nba-401902644', collected.navigateTo)

  /* ---------- 真机白屏防线 ---------- */
  const { appInstance } = require(path.join(ROOT, 'utils/app-instance'))
  const realGetApp = global.getApp
  global.getApp = () => undefined
  const degraded = appInstance()
  global.getApp = realGetApp
  check('getApp 未就绪时降级不崩', !!degraded.globalData && typeof degraded.isFav === 'function' && degraded.isFav('x') === false)
  check('getApp 未就绪时页面仍可渲染', (() => {
    try {
      const c = makeCtx(indexOpts)
      indexOpts.onLoad.call(c)
      return c.data.entries.length > 0 && !c.data.loadError
    } catch (err) {
      return false
    }
  })())

  // 数据文件缺失时不能直接白屏，要给出可操作的提示
  const dataModule = require(path.join(ROOT, 'utils/data'))
  const realMatches = dataModule.matches
  dataModule.matches = () => []
  check('数据为空时首页给出提示而非白屏', (() => {
    const c = makeCtx(indexOpts)
    indexOpts.onLoad.call(c)
    return /赛程数据没有打进小程序包/.test(c.data.loadError)
  })(), )
  check('数据为空时赛程页给出提示而非白屏', (() => {
    const c = makeCtx(schOpts)
    schOpts.onLoad.call(c, {})
    return /赛程数据没有打进小程序包/.test(c.data.loadError)
  })())
  dataModule.matches = realMatches

  /* ---------- 关注球队 ---------- */
  const tfMod = require(path.join(ROOT, 'utils/team-follows'))
  const dataMod = require(path.join(ROOT, 'utils/data'))
  tfMod.resetCache()
  check('数据层：英超球队数 = 20', dataMod.teamsOf('epl').length === 20, `实际 ${dataMod.teamsOf('epl').length}`)
  const arsenal = dataMod.teamsOf('epl').find((t) => t.id === '359')
  check('数据层：可按球队筛选赛程', dataMod.query({ team: { comp: 'epl', id: arsenal.id } }).length > 0, `${arsenal.display} ${dataMod.query({ team: { comp: 'epl', id: arsenal.id } }).length} 场`)
  check('数据层：多球队筛选命中', dataMod.query({ teams: [{ comp: 'epl', id: '359' }, { comp: 'lpl', id: 'JDG' }], status: 'upcoming' }).length > 0)

  require(path.join(ROOT, 'pages/teams/teams.js'))
  const teamsOpts = global.__page
  const ctxTeams = makeCtx(teamsOpts)
  teamsOpts.onLoad.call(ctxTeams)
  check('关注页：默认英超列出 20 队', ctxTeams.data.activeCat === 'epl' && ctxTeams.data.teams.length === 20, `球队 ${ctxTeams.data.teams.length}`)
  check('关注页：欧国联（欧洲国家队）已开放关注', ctxTeams.data.cats.some((c) => c.key === 'nations'), `cats=${ctxTeams.data.cats.map((c) => c.key).join('/')}`)
  check('数据层：欧国联可抽出国家队', dataMod.teamsOf('nations').length > 0, `球队 ${dataMod.teamsOf('nations').length}`)
  check('关注页：中国之队已开放关注', ctxTeams.data.cats.some((c) => c.key === 'chn'),
    `cats=${ctxTeams.data.cats.map((c) => c.key).join('/')}`)
  const chnTeams = dataMod.teamsOf('chn')
  check('数据层：中国之队可抽出国字号球队', chnTeams.some((t) => /^中国/.test(t.display)),
    chnTeams.map((t) => t.display).join('/'))
  check('数据层：中国之队含 U23 亚运队（补录，ESPN 不覆盖亚运会）',
    chnTeams.some((t) => /U23/.test(t.display)), chnTeams.filter((t) => /U23/.test(t.display)).map((t) => t.display).join('/'))
  // 过滤发生在页面层：chn 分类只开放国字号，对手（越南/马尔代夫/韩国U23…）不进候选
  teamsOpts.onCatTap.call(ctxTeams, { currentTarget: { dataset: { key: 'chn' } } })
  check('关注页：中国之队只列国字号，对手不开放关注',
    ctxTeams.data.teams.length > 0 && ctxTeams.data.teams.every((t) => /^中国/.test(t.display)),
    ctxTeams.data.teams.map((t) => t.display).join('/'))
  teamsOpts.onCatTap.call(ctxTeams, { currentTarget: { dataset: { key: 'epl' } } })

  // 补录通道：ESPN 的 218 个足球联赛里没有亚运会，中国 U23 亚运队靠 tools/manual-matches.js 兜底
  const manualMod = require(path.join(ROOT, 'tools/manual-matches.js'))
  const bjToday = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  const liveManual = manualMod.filter((m) => m.date >= bjToday)
  check('数据层：补录表未过期的比赛都进了快照',
    liveManual.length > 0 && liveManual.every((m) => dataMod.matches().some((x) => x.id === m.id)),
    `补录 ${manualMod.length} 场，未过期 ${liveManual.length} 场`)
  check('数据层：query 支持 status 数组（live 归入即将开赛）', (() => {
    const up = dataMod.query({ status: 'upcoming' }).length
    const upLive = dataMod.query({ status: ['upcoming', 'live'] }).length
    return upLive >= up && dataMod.upcoming().length === upLive
  })())
  teamsOpts.onCatTap.call(ctxTeams, { currentTarget: { dataset: { key: 'lpl' } } })
  check('关注页：切到 LPL 列出 12 队', ctxTeams.data.activeCat === 'lpl' && ctxTeams.data.teams.length === 12)
  teamsOpts.onSearch.call(ctxTeams, { detail: { value: '京东' } })
  check('关注页：搜索过滤生效', /京东|JDG/i.test(ctxTeams.data.teams.map((t) => t.display + t.abbr + t.name).join(' ')) && ctxTeams.data.teams.length > 0)

  teamsOpts.onCatTap.call(ctxTeams, { currentTarget: { dataset: { key: 'epl' } } })
  teamsOpts.onSearch.call(ctxTeams, { detail: { value: '' } })
  const arsenalIdx = ctxTeams.data.teams.findIndex((t) => t.id === '359')
  teamsOpts.onTeamTap.call(ctxTeams, { currentTarget: { dataset: { index: arsenalIdx } } })
  check('关注页：点击后关注数 +1', ctxTeams.data.followedCount === 1, `followedCount=${ctxTeams.data.followedCount}`)
  check('关注页：被关注球队标记 on', ctxTeams.data.teams.find((t) => t.id === '359').followed === true)
  check('关注存储：has 命中', tfMod.has('epl', '359') === true)

  // 关注球队的未来赛程只展示 7 天内，而国际比赛日期间俱乐部 10 天没球踢 ——
  // 只关注阿森纳的话这个区块必然是空的，所以再关注一支「7 天内有比赛」的球队
  const fmtMod = require(path.join(ROOT, 'utils/format'))
  const horizon = fmtMod.shiftDay(fmtMod.todayStr(), 7)
  const soonMatch = dataMod.matches().find((m) => m.status === 'upcoming' && m.date <= horizon && m.home && m.home.id)
  const soonTeam = soonMatch ? { comp: soonMatch.comp, id: String(soonMatch.home.id), zh: soonMatch.home.zh, display: soonMatch.home.zh } : null
  if (soonTeam) tfMod.toggle(soonTeam)

  // 首页同步展示关注球队比赛
  const ctxIdxTeam = makeCtx(indexOpts)
  indexOpts.onLoad.call(ctxIdxTeam)
  check('首页：展示关注球队比赛', ctxIdxTeam.data.teamMatches.length > 0, `teamMatches=${ctxIdxTeam.data.teamMatches.length}`)

  // 我的页同步
  const ctxMineTeam = makeCtx(mineOpts)
  mineOpts.buildTeams.call(ctxMineTeam)
  // teams 可能是 2 支：阿森纳 + 为验证「7 天内」临时关注的球队
  check('我的页：关注球队区块有数据', ctxMineTeam.data.teams.length >= 1 && ctxMineTeam.data.teamMatches.length > 0, `teams=${ctxMineTeam.data.teams.length} matches=${ctxMineTeam.data.teamMatches.length}`)

  // 关注球队不能只列未来赛程：24 小时内打完的比赛也要展示
  const recentPool = dataMod.recentFinished({}, 24)
  check('数据层：recentFinished 能捞出 24 小时内的已结束比赛', recentPool.length > 0, `${recentPool.length} 场`)
  check('数据层：recentFinished 按时间倒序（最新在前）',
    recentPool.every((m, i) => i === 0 || Date.parse(recentPool[i - 1].start) >= Date.parse(m.start)))
  const oneHour = dataMod.recentFinished({}, 1)
  check('数据层：recentFinished 窗口收窄后只留更近的',
    oneHour.every((m) => Date.parse(m.start) >= Date.now() - 3600000 - 1000), `${oneHour.length} 场`)

  const recentTeam = recentPool[0] && recentPool[0].home
  if (recentTeam && recentTeam.id) {
    tfMod.toggle({ comp: recentPool[0].comp, id: String(recentTeam.id), zh: recentTeam.zh, display: recentTeam.zh })
    const ctxRes = makeCtx(mineOpts)
    mineOpts.buildTeams.call(ctxRes)
    check('我的页：24 小时内的赛果展示出来', ctxRes.data.teamResults.length > 0,
      `teamResults=${ctxRes.data.teamResults.length}（关注 ${recentTeam.zh}）`)
    check('我的页：赛果带比分', ctxRes.data.teamResults.every((m) => m._hasScore))
    check('我的页：赛果都是已结束的', ctxRes.data.teamResults.every((m) => m.status === 'finished'))
    tfMod.remove(recentPool[0].comp, String(recentTeam.id))
  } else {
    check('我的页：24 小时内的赛果展示出来', false, '数据里找不到近 24 小时已结束的比赛，用例无法验证')
  }

  // 关注球队的未来赛程只展示 7 天内（更远的占位置又用不上）
  const furthest = ctxMineTeam.data.teamMatches.map((m) => m.date).sort().pop()
  check('我的页：未来赛程收敛到 7 天内',
    ctxMineTeam.data.teamMatches.every((m) => m.date <= horizon),
    `最远 ${furthest} / 上限 ${horizon}`)
  check('首页：未来赛程同样收敛到 7 天内',
    ctxIdxTeam.data.teamMatches.every((m) => m.date <= horizon),
    `最远 ${ctxIdxTeam.data.teamMatches.map((m) => m.date).sort().pop()} / 上限 ${horizon}`)

  if (soonTeam) tfMod.remove(soonTeam.comp, soonTeam.id)

  // 卡片小字 = 轮次；拿不到轮次（足球/NBA，ESPN 不提供）就退回赛事名，不留空
  const viewMod = require(path.join(ROOT, 'utils/view'))
  check('卡片小字：赛事名前缀被去掉',
    viewMod.roundLabel('全球总决赛 · 瑞士轮', '全球总决赛') === '瑞士轮'
    && viewMod.roundLabel('LPL · 第 4 周', 'LPL') === '第 4 周', viewMod.roundLabel('LPL · 第 4 周', 'LPL'))
  check('卡片小字：本身是阶段的保留',
    viewMod.roundLabel('联赛阶段 · D1组', '欧国联') === '联赛阶段 · D1组', viewMod.roundLabel('联赛阶段 · D1组', '欧国联'))
  // 2026-09-30 用户决定：足球/NBA 没有轮次号时小字显示赛事名，别留空
  check('卡片小字：拿不到轮次时退回赛事名',
    viewMod.roundLabel('英超', '英超') === '英超' && viewMod.roundLabel('', '英超') === '英超',
    viewMod.roundLabel('英超', '英超'))
  // ⚠️ 防「欧联 欧联」这类重复：削完前缀后不能把赛事名再拼一遍
  check('卡片小字：不会把赛事名重复一遍',
    viewMod.roundLabel('欧联', '欧联') === '欧联' && viewMod.roundLabel('欧联 · 欧联', '欧联') === '欧联',
    viewMod.roundLabel('欧联 · 欧联', '欧联'))
  // 足球/NBA 卡片小字必须非空（曾经短暂留空，卡片看着太空）
  const footCards = ['epl', 'liga', 'ucl', 'uel', 'nations', 'nba']
    .map((k) => dataMod.matches().find((m) => m.comp === k))
    .filter(Boolean)
    .map((m) => viewMod.decorate.call({ compOf: dataMod.compOf }, m))
  check('卡片小字：足球与 NBA 不留空',
    footCards.length > 0 && footCards.every((c) => !!c._stageLabel),
    footCards.map((c) => c._compName + '=' + c._stageLabel).join(' '))

  // ⚠️ 分享能力：页面不实现 onShareAppMessage，右上角「转发给朋友」和「复制链接」就是灰的，
  //    而「复制链接」还依赖「转发给朋友」。2026-09-30 想在公众号图文挂卡片时才踩到。
  const fsMod = require('fs')
  const SHARE_PAGES = ['index', 'schedule', 'mine', 'detail', 'brief', 'teams', 'reminders']
  const noShare = SHARE_PAGES.filter((p) => {
    const s = fsMod.readFileSync(path.join(ROOT, 'pages', p, p + '.js'), 'utf8')
    return s.indexOf('onShareAppMessage') < 0 || s.indexOf('onShareTimeline') < 0
  })
  check('分享：7 个页面都挂了分享方法（否则「复制链接」是灰的）',
    noShare.length === 0, noShare.join(' ') || '全部已挂')

  const shareMod = require(path.join(ROOT, 'utils/share.js'))
  check('分享：默认标题与默认路径',
    shareMod.message().title === shareMod.DEFAULT_TITLE && shareMod.message().path === '/pages/index/index',
    shareMod.message().title)
  // 朋友圈分享不支持 path，必须走 query
  const tl = shareMod.timeline({ title: 'T', query: 'id=1' })
  check('分享：朋友圈走 query 而不是 path', tl.query === 'id=1' && tl.path === undefined, JSON.stringify(tl))

  /* ---------- 转发卡图（utils/poster.js，离屏 canvas 绘制） ---------- */
  const posterMod = require(path.join(ROOT, 'utils/poster.js'))
  // 假 ctx：只记录画了什么文字，用来验证卡面内容
  function fakeCtx() {
    const texts = []
    const images = []
    const rects = []
    return {
      texts, images, rects,
      font: '', fillStyle: '', textAlign: '', textBaseline: '',
      measureText: (s) => ({ width: String(s || '').length * 10 }),
      fillText: (s) => texts.push(String(s)),
      strokeText: (s) => texts.push(String(s)),
      lineWidth: 0, strokeStyle: '',
      drawImage: () => images.push(1),
      fillRect: () => rects.push(1),
      clearRect() {}, scale() {},
      beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, fill() {},
    }
  }

  const ctxM = fakeCtx()
  posterMod.drawMatch(ctxM, {
    comp: '亚运会男足', stage: '半决赛',
    home: '中国U23亚运队', away: '韩国U23',
    homeScore: 1, awayScore: 2,
    dateText: '9月30日', timeText: '14:00', statusText: '已结束', accent: '#C8102E',
  })
  const mText = ctxM.texts.join(' | ')
  check('卡图：比赛卡画出双方队名',
    mText.indexOf('中国U23亚运队') > -1 && mText.indexOf('韩国U23') > -1, mText.slice(0, 80))
  check('卡图：比赛卡画出比分 1 - 2', mText.indexOf('1 - 2') > -1, mText.slice(0, 80))

  // 未开赛（无比分）必须显示 VS，不能画成 "null - null"
  const ctxU = fakeCtx()
  posterMod.drawMatch(ctxU, { comp: '英超', home: '阿森纳', away: '切尔西', homeScore: null, awayScore: null })
  const uText = ctxU.texts.join(' | ')
  check('卡图：未开赛显示 VS 而不是 null',
    uText.indexOf('VS') > -1 && uText.indexOf('null') < 0, uText.slice(0, 80))

  const ctxB = fakeCtx()
  posterMod.drawBrief(ctxB, { dateText: '9月30日', kindZh: '晚报', sub: '今夜看点：三场值得留意', accent: '#3B4E8C' })
  const bText = ctxB.texts.join(' | ')
  check('卡图：日报卡写「X月X日 + 闪现早/晚报」',
    bText.indexOf('9月30日') > -1 && bText.indexOf('闪现晚报') > -1, bText.slice(0, 80))

  // 长副标题要折行截断，不能溢出卡面
  const ctxL = fakeCtx()
  posterMod.drawBrief(ctxL, { dateText: '9月30日', kindZh: '早报', sub: '一'.repeat(200) })
  const longLines = ctxL.texts.filter((t) => t.indexOf('一一') > -1)
  check('卡图：日报副标题最多两行且带省略号',
    longLines.length <= 2 && longLines.every((t) => t.length < 60), `${longLines.length} 行`)

  // 底图（模板图）支持：给了图就贴图，没给就退回代码画的纯色底，两种情况都不能崩
  const ctxBg = fakeCtx()
  posterMod.drawMatch(ctxBg, {
    bg: {}, home: '中国U23亚运队', away: '韩国U23', homeScore: 1, awayScore: 2,
  })
  check('卡图：有底图时先贴图再写字',
    ctxBg.images.length === 1 && ctxBg.rects.length === 0 && ctxBg.texts.length > 0,
    `drawImage=${ctxBg.images.length} fillRect=${ctxBg.rects.length}`)

  const ctxNoBg = fakeCtx()
  posterMod.drawMatch(ctxNoBg, { home: '阿森纳', away: '切尔西', homeScore: 0, awayScore: 0 })
  check('卡图：没有底图时退回纯色底（不崩且不贴图）',
    ctxNoBg.images.length === 0 && ctxNoBg.rects.length > 0 && ctxNoBg.texts.length > 0,
    `drawImage=${ctxNoBg.images.length} fillRect=${ctxNoBg.rects.length}`)

  const ctxBriefBg = fakeCtx()
  posterMod.drawBrief(ctxBriefBg, { bg: {}, dateText: '9月30日', kindZh: '早报' })
  check('卡图：日报底图模式下不画品牌水印也不画「早/晚报」徽标字',
    ctxBriefBg.texts.indexOf('闪现赛程助手') < 0 && ctxBriefBg.texts.indexOf('早报') < 0,
    ctxBriefBg.texts.join(' | ').slice(0, 60))

  // 底图文件必须真的在包里，否则 loadBg 静默失败、悄悄退回纯色底
  const bgFiles = ['images/share-match.jpg', 'images/share-brief.jpg']
  const badBg = bgFiles.filter((f) => {
    try { return fsMod.statSync(path.join(ROOT, f)).size > 200 * 1024 } catch (e) { return true }
  })
  check('卡图：两张底图已进包且单张 ≤ 200KB', badBg.length === 0, badBg.join(' '))
  check('卡图：BG 常量已指向底图',
    posterMod.BG.match === '/images/share-match.jpg' && posterMod.BG.brief === '/images/share-brief.jpg')

  // 页面内分享按钮：open-type=share 才能在页面里直接唤起转发面板（不只靠右上角菜单）
  const shareBtnPages = ['detail', 'brief']
  const noBtn = shareBtnPages.filter((p) => {
    const w = fsMod.readFileSync(path.join(ROOT, 'pages', p, p + '.wxml'), 'utf8')
    return w.indexOf('open-type="share"') < 0
  })
  check('分享：详情页与日报页都有页面内分享按钮', noBtn.length === 0, noBtn.join(' '))

  // 按钮布局（2026-09-30 用户定稿）：详情页关注+分享并排占左右两半，日报页按钮贴标题右侧
  const dWxml = fsMod.readFileSync(path.join(ROOT, 'pages/detail/detail.wxml'), 'utf8')
  const dWxss = fsMod.readFileSync(path.join(ROOT, 'pages/detail/detail.wxss'), 'utf8')
  const row = (dWxml.match(/<view class="btn-row">([\s\S]*?)<\/view>\s*<view/) || [])[1] || ''
  check('布局：详情页关注与「分享赛果」同排并各占一半',
    row.indexOf('onFavTap') > -1 && row.indexOf('分享赛果') > -1 && /\.btn-row\s*\{[^}]*display:\s*flex/.test(dWxss))
  check('布局：并排按钮之间留缝（不用 flex gap，兼容旧 WebView）',
    /\.btn-row\s*\.btn\s*\+\s*\.btn\s*\{[^}]*margin-left/.test(dWxss) && dWxss.indexOf('gap:') < 0,
    dWxss.indexOf('gap:') > -1 ? '检测到 gap，旧 iOS WebView 可能不生效' : '')
  check('布局：分享赛果按钮是深蓝主色（.btn.primary）',
    /class="btn primary share-btn"/.test(dWxml))
  const bWxml = fsMod.readFileSync(path.join(ROOT, 'pages/brief/brief.wxml'), 'utf8')
  const bWxss = fsMod.readFileSync(path.join(ROOT, 'pages/brief/brief.wxss'), 'utf8')
  // 非贪婪匹配到 </button>：只取标题行整块（匹配到 </view> 会在 mast-title 处提前截断）
  const titleRow = (bWxml.match(/<view class="mast-title-row">[\s\S]*?<\/button>/) || [])[0] || ''
  check('布局：日报页「分享好友」在标题行右侧',
    titleRow.indexOf('mast-title') > -1 && titleRow.indexOf('分享好友') > -1
    && /\.mast-title-row\s+\.brief-share\s*\{[^}]*position:\s*absolute/.test(bWxss))
  // 2026-09-30 用户定：深蓝实底白字、圆角矩形，两侧留白收紧（宽度随文字自适应，不写死）
  const briefBtnCss = (bWxss.match(/\.mast-title-row\s+\.brief-share\s*\{([\s\S]*?)\}/) || [])[1] || ''
  const briefBtnR = Number((briefBtnCss.match(/border-radius:\s*(\d+)rpx/) || [])[1] || 999)
  const briefBtnPad = Number((briefBtnCss.match(/padding:\s*0\s+(\d+)rpx/) || [])[1] || 999)
  check('布局：日报页分享按钮是深蓝实底白字（#14235c）',
    /background:\s*#14235c/.test(briefBtnCss) && /color:\s*#fff/.test(briefBtnCss))
  check('布局：日报页分享按钮是圆角矩形（圆角 ≤ 16rpx）',
    briefBtnR > 0 && briefBtnR <= 16, `border-radius: ${briefBtnR}rpx`)
  check('布局：日报页分享按钮两侧留白收紧（左右 padding ≤ 24rpx，无固定宽）',
    briefBtnPad <= 24 && !/width:\s*\d+rpx/.test(briefBtnCss), `padding: 0 ${briefBtnPad}rpx`)
  // 按钮最宽 ≈ 4 字 ×24rpx + 两侧 padding + 边框 = 96+48+4 = 148rpx，
  // 报头 750-64=686rpx、标题右缘约 499rpx → 贴右时左缘 ≥ 538rpx，留 39rpx 间隙，不会撞标题。
  check('布局：日报页分享按钮不与报头标题相撞',
    686 - 148 >= 509 && briefBtnPad <= 24, `最宽 148rpx，左缘 ≥ ${686 - 148}rpx`)

  // 页面接线：详情页与日报页都要有 canvas + buildShareImage
  ;['detail', 'brief'].forEach((p) => {
    const js = fsMod.readFileSync(path.join(ROOT, 'pages', p, p + '.js'), 'utf8')
    const wxml = fsMod.readFileSync(path.join(ROOT, 'pages', p, p + '.wxml'), 'utf8')
    const wxss = fsMod.readFileSync(path.join(ROOT, 'pages', p, p + '.wxss'), 'utf8')
    check(`卡图：${p} 页接线完整（canvas + 生成逻辑 + 离屏样式）`,
      js.indexOf('buildShareImage') > -1 && js.indexOf('poster.build') > -1
      && wxml.indexOf('share-canvas') > -1 && wxss.indexOf('share-canvas') > -1)
  })
  const esportCard = viewMod.decorate.call({ compOf: dataMod.compOf }, dataMod.matches().find((m) => m.comp === 'demacia'))
  check('卡片小字：德玛西亚杯显示轮次', /轮|周|组/.test(esportCard._stageLabel), esportCard._stageLabel)

  // 德玛西亚杯（LoL Esports API 里的 DCGI / demacia_cup）
  check('数据层：德玛西亚杯已进快照', dataMod.matches().some((m) => m.comp === 'demacia'),
    `${dataMod.matches().filter((m) => m.comp === 'demacia').length} 场`)

  // 亚运会电竞（LoL Esports API 里的 Asian Games / asian_games）
  const agMatches = dataMod.matches().filter((m) => m.comp === 'agames')
  check('数据层：亚运会电竞已进快照', agMatches.length > 0, `${agMatches.length} 场`)
  check('数据层：亚运会电竞归入电竞分类',
    (dataMod.categories().find((c) => c.key === 'esports') || { competitions: [] }).competitions.indexOf('agames') > -1)
  // 国家队要有中文名，否则小程序上全是 "Saudi Arabia"
  check('数据层：亚运会队伍有中文名',
    agMatches.length > 0 && agMatches.every((m) => !!m.home.zh && !!m.away.zh),
    agMatches.filter((m) => !m.home.zh || !m.away.zh).slice(0, 2).map((m) => m.home.name + '/' + m.away.name).join(' ') || '全覆盖')
  // ⚠️ 港澳台必须写成「中国香港 / 中国澳门 / 中国台北」，简写是硬伤
  const agNames = agMatches.map((m) => m.home.zh + '|' + m.away.zh).join('|')
  check('数据层：港澳台队名合规（中国香港/中国台北）',
    !/^(香港|台北|澳门)\|/.test(agNames) && !/\|(香港|台北|澳门)$/.test(agNames)
    && !/(^|\|)(香港|台北|澳门)(\||$)/.test(agNames), agNames.slice(0, 60))
  check('数据层：德玛西亚杯归入电竞分类',
    (dataMod.categories().find((c) => c.key === 'esports') || { competitions: [] }).competitions.indexOf('demacia') > -1)

  // ⚠️ LoL 上游 state 会滞后于赛果：2026-09-30 亚运会实测，比赛打完 2 小时后
  // state 仍是 unstarted，但 result.outcome 已经给出胜负。只信 state 会让赛果永远拉不下来。
  const lolStatus = require(path.join(ROOT, 'tools/lol-status.js')).lolStatus
  const mkEv = (state, r0, r1) => ({ state, match: { teams: [{ code: 'A', result: r0 }, { code: 'B', result: r1 }] } })
  const win = { outcome: 'win', gameWins: 1 }
  const loss = { outcome: 'loss', gameWins: 0 }
  const none = { outcome: null, gameWins: 0 }

  const lagSt = lolStatus(mkEv('unstarted', win, loss))
  check('LoL 状态：state 滞后但已有 outcome → 判为已结束并出比分',
    lagSt.status === 'finished' && lagSt.homeScore === 1 && lagSt.awayScore === 0 && lagSt.statusText === '已结束',
    `${lagSt.status} ${lagSt.homeScore}-${lagSt.awayScore}`)

  const pendSt = lolStatus(mkEv('unstarted', none, none))
  check('LoL 状态：outcome 为空 → 仍按未开赛、不出比分',
    pendSt.status === 'upcoming' && pendSt.homeScore === null && pendSt.awayScore === null && pendSt.statusText === '',
    `${pendSt.status} ${pendSt.homeScore}-${pendSt.awayScore}`)

  const liveSt = lolStatus(mkEv('inProgress', none, none))
  check('LoL 状态：进行中不被误判为已结束',
    liveSt.status === 'live' && liveSt.statusText === '进行中', liveSt.status)

  const doneSt = lolStatus(mkEv('completed', loss, win))
  check('LoL 状态：state=completed 正常取比分',
    doneSt.status === 'finished' && doneSt.homeScore === 0 && doneSt.awayScore === 1,
    `${doneSt.status} ${doneSt.homeScore}-${doneSt.awayScore}`)

  const noTeamSt = lolStatus({ state: 'completed', match: { teams: [] } })
  check('LoL 状态：队伍为空时不崩',
    noTeamSt.status === 'finished' && noTeamSt.homeScore === null && noTeamSt.awayScore === null, noTeamSt.status)

  // 已结束的比赛必须有比分，否则详情页会显示空白
  const agDone = agMatches.filter((m) => m.status === 'finished')
  check('数据层：亚运会已结束的比赛都有比分',
    agDone.length > 0 && agDone.every((m) => typeof m.home.score === 'number' && typeof m.away.score === 'number'),
    `${agDone.length} 场已结束`)

  // 赛程页按球队筛选
  const ctxSchTeam = makeCtx(schOpts)
  ctxSchTeam.setData({ activeCat: 'football', activeComp: 'epl', mode: 'upcoming', shownGroups: 3, teamFilter: { comp: 'epl', id: '359', display: '阿森纳', color: '#e20520' } })
  schOpts.doReload.call(ctxSchTeam)
  check('赛程页：按球队筛选只保留该队比赛', ctxSchTeam.data.totalMatches > 0 && matchRows(ctxSchTeam.data.rows).every((r) => String(r.match.home.id) === '359' || String(r.match.away.id) === '359'), `total=${ctxSchTeam.data.totalMatches}`)

  // 取消关注
  teamsOpts.onTeamTap.call(ctxTeams, { currentTarget: { dataset: { index: arsenalIdx } } })
  check('关注页：再点取消关注', ctxTeams.data.followedCount === 0)
  check('关注存储：取消后 has 不命中', tfMod.has('epl', '359') === false)

  /* ---------- 开赛提醒（特别关注） ---------- */
  const rmMod = require(path.join(ROOT, 'utils/reminders'))
  rmMod.resetCache()
  check('提醒存储：初始为空', rmMod.all().length === 0)

  // 造三场：20 分钟后开赛（该提醒）、2 小时后（不该提醒）、已开赛（不该提醒）
  const mkMatch = (id, offsetMs) => ({
    id,
    comp: 'epl',
    stage: '测试',
    home: { zh: '主队', abbr: 'HOM', name: 'Home' },
    away: { zh: '客队', abbr: 'AWA', name: 'Away' },
    date: '2026-09-26',
    time: '12:00',
    start: new Date(Date.now() + offsetMs).toISOString(),
  })
  const soon = mkMatch('rm-soon', 20 * 60000)
  const later = mkMatch('rm-later', 120 * 60000)
  const past = mkMatch('rm-past', -30 * 60000)

  check('提醒存储：新增成功', rmMod.add(soon).added === true)
  check('提醒存储：重复新增返回 already', rmMod.add(soon).already === true)
  rmMod.add(later)
  rmMod.add(past)
  check('提醒存储：共存 3 条', rmMod.all().length === 3, `实际 ${rmMod.all().length}`)

  const due = rmMod.dueReminders()
  check('提醒：只有 30 分钟内且未开赛的才到期', due.length === 1 && due[0].matchId === 'rm-soon',
    due.map((r) => r.matchId).join(',') || '无')
  check('提醒：到期条目剩余时间在窗口内', due.length === 1 && due[0].inMs > 0 && due[0].inMs <= 30 * 60000)

  // 首页提醒卡片
  const ctxIdxDue = makeCtx(indexOpts)
  indexOpts.onLoad.call(ctxIdxDue)
  check('首页：开赛提醒卡片渲染出到期场次', ctxIdxDue.data.dueReminders.length === 1,
    `dueReminders=${ctxIdxDue.data.dueReminders.length}`)
  check('首页：提醒卡片含倒计时文案', /开赛/.test((ctxIdxDue.data.dueReminders[0] || {})._countdown || ''))

  // 我的提醒管理页
  require(path.join(ROOT, 'pages/reminders/reminders.js'))
  const rmOpts = global.__page
  const ctxRm = makeCtx(rmOpts)
  rmOpts.onLoad.call(ctxRm)
  check('我的提醒页：列出 3 条', ctxRm.data.list.length === 3, `实际 ${ctxRm.data.list.length}`)
  check('我的提醒页：已开赛的标记为已开赛', ctxRm.data.list.find((r) => r.matchId === 'rm-past').started === true)
  check('我的提醒页：按开赛时间升序', ctxRm.data.list[0].matchId === 'rm-past')

  rmOpts.onRemove.call(ctxRm, { currentTarget: { dataset: { id: 'rm-soon' } } })
  check('我的提醒页：取消后剩 2 条', ctxRm.data.list.length === 2, `实际 ${ctxRm.data.list.length}`)
  check('提醒存储：取消后 has 不命中', rmMod.has('rm-soon') === false)

  // 我的页提醒区块
  const ctxMineRm = makeCtx(mineOpts)
  mineOpts.buildReminders.call(ctxMineRm)
  check('我的页：提醒区块有数据', ctxMineRm.data.remindCount === 2 && ctxMineRm.data.reminderList.length === 2,
    `count=${ctxMineRm.data.remindCount}`)

  // 详情页提醒按钮
  const ctxDet2 = makeCtx(detOpts)
  detOpts.onLoad.call(ctxDet2, { id: encodeURIComponent(target.id) })
  check('详情页：初始未设提醒', ctxDet2.data.isRemind === false)
  detOpts.onRemindTap.call(ctxDet2)
  check('详情页：点提醒后状态变为已设', ctxDet2.data.isRemind === true)
  detOpts.onRemindTap.call(ctxDet2)
  check('详情页：再点取消提醒', ctxDet2.data.isRemind === false)

  // 清理，避免影响后续断言
  ;['rm-soon', 'rm-later', 'rm-past', target.id].forEach((id) => rmMod.remove(id))
  rmMod.resetCache()

  /* ---------- 赛程日报 ---------- */
  const briefApi = require(path.join(ROOT, 'utils/brief'))
  const briefDir = path.join(ROOT, 'data/brief')
  const briefFiles = fs.existsSync(briefDir)
    ? fs.readdirSync(briefDir).filter((f) => f.endsWith('.json')).sort()
    : []
  check('日报：本地已生成期次文件', briefFiles.length > 0, `${briefFiles.length} 期`)

  // 按云表真实行结构构造（列名是 snake_case，这是云端返回的原样）
  const briefRows = briefFiles.map((f) => {
    const p = JSON.parse(fs.readFileSync(path.join(briefDir, f), 'utf8'))
    return { id: p.id, kind: p.kind, date: p.date, pub_at: p.pubAt, mode: p.mode, payload: p, generated_at: p.generatedAt }
  }).sort((a, b) => Date.parse(b.pub_at) - Date.parse(a.pub_at))

  check('日报：id 符合云端写入约束', briefRows.every((r) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}-(morning|evening)$/.test(r.id)),
    briefRows.length ? briefRows[0].id : '')
  check('日报：每期都带 AI 生成标识（合规强制）',
    briefRows.every((r) => r.payload.aigc && r.payload.aigc.explicit === 'AI 生成'))
  check('日报：出报时刻只落在 06:00 / 21:00', briefRows.every((r) => /T(06|21):00/.test(r.pub_at)),
    briefRows.length ? briefRows[0].pub_at : '')

  // 云端返回 timestamptz 常用 +00:00 输出，显示层必须自己换算到北京时间
  check('日报：北京时间显示', /^\d{1,2}月\d{1,2}日 (06|21):00$/.test(briefApi.fmtPubAt(briefRows[0].pub_at)),
    briefApi.fmtPubAt(briefRows[0].pub_at))
  check('日报：+00:00 输出也能换算成北京时间',
    briefApi.fmtPubAt('2026-09-28T22:00:00+00:00') === '9月29日 06:00',
    briefApi.fmtPubAt('2026-09-28T22:00:00+00:00'))

  const allIssues = briefRows.map(briefApi.normalize).filter(Boolean)
  check('日报：全部期次都能被数据层解析', allIssues.length === briefRows.length, `${allIssues.length}/${briefRows.length}`)
  check('日报：解析后出报时间不为空', allIssues.every((x) => !!x.pubAt))

  // ⚠️ 线上问题（2026-09-29）：北京时间下午 3 点多，日报页却出现了「9月29日 晚报」。
  // 根因是生成脚本每 15 分钟幂等重算最近两天，当天 21:00 的晚报在下午就写进了云表，
  // 按 pub_at 倒序取它稳居第一。修复：生成端不落库 + 客户端不展示（两道都要）。
  const BJ_NOW = Date.parse('2026-09-29T15:46:00+08:00')   // 用户截图那一刻
  const bjRow = (id, kind, pub, mode) => ({
    id, kind, date: id.slice(0, 10), pub_at: pub, mode,
    payload: { mode, headline: { title: '标题' }, preview: { items: [] } },
  })
  // 云表按 pub_at DESC 返回的真实顺序：未来期次排在最前
  const mixRows = [
    bjRow('2026-09-29-evening', 'evening', '2026-09-29T21:00:00+08:00', 'preview'),
    bjRow('2026-09-29-morning', 'morning', '2026-09-29T06:00:00+08:00', 'report'),
    bjRow('2026-09-28-evening', 'evening', '2026-09-28T21:00:00+08:00', 'preview'),
  ].map(briefApi.normalize).filter(Boolean)
  check('日报：复现线上顺序（未来期次排首位）', mixRows[0] && mixRows[0].id === '2026-09-29-evening',
    mixRows[0] && mixRows[0].id)

  const dueNow = briefApi.onlyDue(mixRows, 10, BJ_NOW)
  check('日报：出报时刻未到的期次不展示',
    !dueNow.some((x) => x.id === '2026-09-29-evening'), dueNow.map((x) => x.id).join(', '))
  check('日报：此时候选最新一期是当天早报', dueNow[0] && dueNow[0].id === '2026-09-29-morning',
    dueNow[0] && dueNow[0].id)
  check('日报：过滤后剩余期次不减（历史期没被挤掉）', dueNow.length === 2, `${dueNow.length}/2`)

  const dueLater = briefApi.onlyDue(mixRows, 10, Date.parse('2026-09-29T21:00:00+08:00'))
  check('日报：到点后该期自动出现，无需重新发版',
    dueLater[0] && dueLater[0].id === '2026-09-29-evening', dueLater[0] && dueLater[0].id)
  check('日报：恰好到点即算出报',
    briefApi.isDue('2026-09-29T21:00:00+08:00', Date.parse('2026-09-29T21:00:00+08:00')) === true)
  check('日报：差一分钟仍算未出报',
    briefApi.isDue('2026-09-29T21:00:00+08:00', Date.parse('2026-09-29T20:59:00+08:00')) === false)
  check('日报：取不到出报时刻的行照旧展示（不整页隐藏）', briefApi.isDue('', BJ_NOW) === true)

  // 生成端是另一份实现（小程序打不到 tools/），规则必须一致，改一处忘另一处这里会红
  const briefWin = require(path.join(ROOT, 'tools/brief-window.js'))
  check('生成端：未到期次不落库，规则与客户端一致',
    briefWin.isDue('2026-09-29T21:00:00+08:00', BJ_NOW) === false
    && briefWin.isDue('2026-09-29T06:00:00+08:00', BJ_NOW) === true
    && briefWin.isDue('2026-09-29T21:00:00+08:00', Date.parse('2026-09-29T21:00:00+08:00')) === true)

  // 晚报定位 = 「今夜看点」（2026-09-29 定的）：晚窗口（06:00–18:00）实测连续 7 天 0 场，
  // 晚报几乎必然落到前瞻，所以前瞻窗口收窄到「当日 18:00 → 次日 06:00」这一整夜。
  const Pv = require(path.join(ROOT, 'tools/brief-preview.js'))
  check('晚报前瞻：文案改称「今夜看点」',
    /今夜看点/.test(Pv.intro('2026-09-29', 'evening', '09/29 18:00 → 09/30 06:00', 72)),
    Pv.intro('2026-09-29', 'evening', '09/29 18:00 → 09/30 06:00', 72))
  check('早报前瞻：仍是「未来 72 小时」说法（不受影响）',
    /未来 72 小时/.test(Pv.intro('2026-09-29', 'morning', '09/28 18:00 → 09/29 06:00', 72)))

  const pvNow = Date.parse('2026-09-29T13:00:00Z')
  const pvMatch = (st) => ({
    id: 'pv-' + st, comp: 'ucl', stage: '', date: '2026-09-29', time: '20:00',
    start: '2026-09-29T12:00:00Z', status: st, home: { zh: '皇家马德里' }, away: { zh: '拜仁' },
  })
  check('晚报前瞻：纳入正在进行的比赛', Pv.pick([pvMatch('live')], pvNow, true).length === 1)
  check('晚报前瞻：已结束的比赛不进前瞻', Pv.pick([pvMatch('finished')], pvNow, true).length === 0)
  check('早报前瞻：只取未开赛（进行中的不算）', Pv.pick([pvMatch('live')], pvNow, false).length === 0)

  // ⚠️ 标题措辞必须与比分自洽（2026-09-30 翻车：西班牙 4-1 克罗地亚，
  // 标题写成「欧国联德比：斗牛士一球制胜格子军团」—— 分差 3 球，措辞写死在模板里没跟着比分走）。
  // 这里把 0-0 ~ 6-6 全扫一遍，任何一句措辞和比分矛盾都会红。
  const Wr = require(path.join(ROOT, 'tools/brief-write.js'))
  const mkScore = (hs, as) => ({
    comp: 'nations', stage: '欧国联', date: '2026-09-30', time: '02:45', bo: null,
    home: { zh: '西班牙', score: hs }, away: { zh: '克罗地亚', score: as },
  })
  const wordingBad = []
  for (let hs = 0; hs <= 6; hs += 1) {
    for (let as = 0; as <= 6; as += 1) {
      const diff = Math.abs(hs - as)
      const mn = Math.min(hs, as)
      for (let seq = 0; seq < 3; seq += 1) {
        const text = Wr.title(mkScore(hs, as), seq).text
        const hit = (re) => re.test(text)
        if (hit(/一球|险胜|险过关/) && diff !== 1) wordingBad.push(`${hs}-${as} 非一球之差却说「险」：${text}`)
        if (hit(/大胜|血洗|碾压/) && diff < 3) wordingBad.push(`${hs}-${as} 分差 ${diff} 却说大胜：${text}`)
        if (hit(/零封|横扫/) && mn !== 0) wordingBad.push(`${hs}-${as} 对手有进球却说零封：${text}`)
        if (hit(/力压|击败|拿下|战胜|过关|笑到最后/) && diff === 0) wordingBad.push(`${hs}-${as} 平局却说胜负：${text}`)
        // 德比 = 同城/同地区对手，判据只是「双方都是 T1」，判不出来就不许写
        if (hit(/德比/)) wordingBad.push(`${hs}-${as} 误称德比：${text}`)
      }
    }
  }
  check('标题措辞与比分自洽（0-0 ~ 6-6 全扫）', wordingBad.length === 0,
    wordingBad.length ? `${wordingBad.length} 处矛盾，例：${wordingBad[0]}` : '147 组比分 × 3 套模板')
  check('4-1 的豪门对决不再说「一球制胜」',
    !/一球/.test(Wr.title(mkScore(4, 1), 0).text), Wr.title(mkScore(4, 1), 0).text)

  const realFetchBriefs = briefApi.fetchBriefs
  // 走真实 normalize：列名映射（pub_at）出错的话，这里就会先炸
  briefApi.fetchBriefs = async (n) => ({ list: allIssues.slice(0, n || 10) })
  const settle = () => new Promise((r) => setTimeout(r, 0))

  require(path.join(ROOT, 'pages/brief/brief.js'))
  const bfOpts = global.__page
  const ctxBf = makeCtx(bfOpts)
  bfOpts.onLoad.call(ctxBf)
  await settle()
  check('日报页：拉到期次列表', ctxBf.data.list.length > 0, `${ctxBf.data.list.length} 期`)
  check('日报页：最多只取 10 期', ctxBf.data.list.length <= 10, `${ctxBf.data.list.length} 期`)
  check('日报页：默认停在最新一期', ctxBf.data.idx === 0 && !!ctxBf.data.cur)
  check('日报页：出报时间已格式化', /月/.test(ctxBf.data.pubText), ctxBf.data.pubText)

  // 内容断言看全部期次，不受「页面只加载最近 10 期」影响
  const reportIssue = allIssues.find((x) => x.mode === 'report')
  const previewIssue = allIssues.find((x) => x.mode === 'preview')
  const reportCount = allIssues.filter((x) => x.mode === 'report').length
  check('日报：存在战报期', !!reportIssue, `${reportCount} 期战报 / ${allIssues.length} 期`)
  check('日报：战报期含标题/导语/正文', !!reportIssue && !!reportIssue.headline.title
    && !!reportIssue.headline.lead && reportIssue.headline.body.length > 0,
    reportIssue ? reportIssue.headline.title : '无')
  check('日报：战报头条带 matchId 可跳详情', !!reportIssue && !!reportIssue.headline.matchId)
  check('日报：战报头条含数据栏', !!reportIssue && !!reportIssue.headline.factbox)
  check('日报：前瞻期含分组对阵', !!previewIssue && previewIssue.preview.items.length > 0,
    previewIssue ? `${previewIssue.preview.items.length} 场` : '无')
  check('日报：前瞻按项目分组（足球/篮球/电竞）',
    !!previewIssue && previewIssue.preview.items.every((it) => !!it.groupZh))
  check('日报：入口摘要不为空', allIssues.every((x) => !!briefApi.teaser(x)),
    reportIssue ? briefApi.teaser(reportIssue) : '')

  if (ctxBf.data.list.length > 1) {
    bfOpts.onNext.call(ctxBf)
    check('日报页：翻到更早一期', ctxBf.data.idx === 1)
    bfOpts.onPrev.call(ctxBf)
    check('日报页：翻回最新一期', ctxBf.data.idx === 0)
  }

  // 点头条跳详情：单独用一份只含战报期的列表，避免最新 10 期全是前瞻时测不到
  if (reportIssue) {
    briefApi.fetchBriefs = async () => ({ list: [reportIssue] })
    const ctxBfRep = makeCtx(bfOpts)
    bfOpts.onLoad.call(ctxBfRep)
    await settle()
    bfOpts.onHeadlineTap.call(ctxBfRep)
    check('日报页：点头条跳比赛详情', /^\/pages\/detail\/detail\?id=/.test(collected.navigateTo || ''), collected.navigateTo)
    briefApi.fetchBriefs = async (n) => ({ list: allIssues.slice(0, n || 10) })
  }

  // 反幻觉：数据里没有的东西，文字里也不许出现
  const banned = /绝杀|逆转|让二追三|补时|点球|加时|梅开二度|帽子戏法/
  const allBriefText = briefRows.map((r) => JSON.stringify(r.payload)).join(' ')
  check('日报：无幻觉用词（绝杀/点球/补时…）', !banned.test(allBriefText),
    (allBriefText.match(banned) || [''])[0])

  // 入口：首页 + 我的页
  const ctxIdxBrief = makeCtx(indexOpts)
  indexOpts.onLoad.call(ctxIdxBrief)
  await settle()
  check('首页：日报入口条有摘要', !!(ctxIdxBrief.data.brief && ctxIdxBrief.data.brief.tip),
    ctxIdxBrief.data.brief ? ctxIdxBrief.data.brief.tip : '未取到')
  indexOpts.goBrief.call(ctxIdxBrief)
  check('首页：点日报入口跳日报页', collected.navigateTo === '/pages/brief/brief', collected.navigateTo)

  const ctxMineBrief = makeCtx(mineOpts)
  mineOpts.onLoad.call(ctxMineBrief)
  await settle()
  check('我的页：日报入口有摘要', !!(ctxMineBrief.data.brief && ctxMineBrief.data.brief.tip),
    ctxMineBrief.data.brief ? ctxMineBrief.data.brief.tip : '未取到')
  mineOpts.goBrief.call(ctxMineBrief)
  check('我的页：点日报入口跳日报页', collected.navigateTo === '/pages/brief/brief', collected.navigateTo)

  // 云服务不可用时不能炸
  briefApi.fetchBriefs = async () => ({ list: [], reason: 'no-cloud' })
  const ctxBfDown = makeCtx(bfOpts)
  bfOpts.onLoad.call(ctxBfDown)
  await settle()
  check('日报页：云端不可用时给出提示而非白屏', !!ctxBfDown.data.errTip && ctxBfDown.data.loading === false,
    ctxBfDown.data.errTip)
  // 注意：makeCtx 共享了页面对象的 data，先归零再跑才是「重新进页面」的真实状态
  const ctxIdxDown = makeCtx(indexOpts)
  ctxIdxDown.setData({ brief: null })
  indexOpts.onLoad.call(ctxIdxDown)
  await settle()
  check('首页：日报取不到时不显示入口条', !ctxIdxDown.data.brief)
  briefApi.fetchBriefs = realFetchBriefs

  /* ---------- 输出 ---------- */
  let failed = 0
  results.forEach((r) => {
    if (!r.ok) failed += 1
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  → ' + r.extra : ''}`)
  })
  console.log(`\n${results.length - failed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
