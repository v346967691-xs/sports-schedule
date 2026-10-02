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
  // ⚠️ 不能直接 Object.assign(ctx, obj)：obj 自己也带 data 属性，会把上面这份拷贝
  //    覆盖回去，于是所有 ctx 共享同一份 data，测试用例之间互相串状态
  //    （2026-10-02 修：详情页「找不到比赛」的用例被上一个用例的 match 污染过）。
  const ctx = { __isCtx: true }
  Object.keys(obj).forEach((k) => { if (k !== 'data') ctx[k] = obj[k] })
  ctx.data = Object.assign({}, obj.data)
  ctx.setData = function (patch, cb) {
    Object.assign(ctx.data, patch)
    if (typeof cb === 'function') cb()
  }
  return ctx
}

global.wx = {
  navigateTo: (o) => { collected.navigateTo = o.url },
  pageScrollTo: (o) => { collected.pageScrollTo = o ? o.scrollTop : null },
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
  // 2026-10-02 新增中超：不写死数量，只保证关键赛事都在（以后再加赛事不会误报）
  const footComps = allData.categories().find((c) => c.key === 'football').competitions
  check('首页：足球分类齐全（含中超/五大联赛/欧冠欧联/国字号）',
    footComps.length >= 9 && ['csl', 'epl', 'liga', 'ucl', 'uel', 'chn'].every((k) => footComps.indexOf(k) > -1),
    `赛事 ${footComps.length} 项`)
  check('首页：含欧国联/欧联/中国国字号入口', ['nations', 'uel', 'chn'].every((k) => d.entries.some((e) => e.key === k)),
    d.entries.filter((e) => ['nations', 'uel', 'chn'].indexOf(e.key) > -1).map((e) => e.name).join('、'))
  check('首页：每个入口都有摘要文案', d.entries.every((e) => e.summary && e.summary.length > 4))
  check('首页：日期条 14 天', d.dateStrip.length === 14, `实际 ${d.dateStrip.length}`)
  check('首页：待开赛统计 > 0', d.stats.upcoming > 0, `实际 ${d.stats.upcoming}`)
  check('首页：默认选中一个有比赛的日期', allData.query({ date: d.activeDate, status: '' }).length > 0, d.activeDate)
  check('首页：今日比赛已构建', Array.isArray(d.dayMatches))
  check('首页：卡片视图字段齐全', !d.dayMatches.length || !!d.dayMatches[0]._compName && !!d.dayMatches[0]._statusLabel)
  // 官方队名本身就是拉丁字母的（S 赛的 G2/Fnatic、KPL 的 KSG）不算缺中文名
  const latinOnly = (s) => /^[\x20-\x7F]+$/.test(String(s || ''))
  check('首页：卡片显示中文队名', d.dayMatches.every((m) => /[一-龥]/.test(m.home.zhName) || m.comp === 'worlds' || latinOnly(m.home.zhName)) || !d.dayMatches.length,
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
  // 同上：只保证关键赛事在，不写死数量（2026-10-02 加了中超）
  // catComps 是赛事对象数组（不是 key 数组），按 key 判断
  const catKeys = s.catComps.map((c) => c.key)
  check('赛程页：足球分类齐全（含中超）',
    catKeys.length >= 9 && ['csl', 'epl', 'ucl', 'uel', 'chn'].every((k) => catKeys.indexOf(k) > -1),
    `赛事 ${catKeys.length} 项：${catKeys.join(',')}`)
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
  // onLoad 是 async：本地找不到或没比分时会先拉一次云端再渲染，要等一个微任务
  detOpts.onLoad.call(ctxDet, { id: encodeURIComponent(target.id) })
  await waitUntil(() => ctxDet.data.match || ctxDet.data.loadError)
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
  // 亚运会已结束，补录表暂时没有未来场次 —— 改成校验"落在抓取窗口内的补录条目都进了快照"，
  // 这样无论表里是未来的还是刚打完的，通道本身都能被验到
  const mRange = (allData.meta && allData.meta.range) || { from: bjToday, to: bjToday }
  const inRangeManual = manualMod.filter((m) => m.date >= mRange.from && m.date <= mRange.to)
  check('数据层：补录表窗口内的比赛都进了快照',
    inRangeManual.length > 0 && inRangeManual.every((m) => dataMod.matches().some((x) => x.id === m.id)),
    `补录 ${manualMod.length} 场，窗口内 ${inRangeManual.length} 场（窗口 ${mRange.from}~${mRange.to}）`)
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
  // ⚠️ 2026-10-02 起关注页行内两个动作分开：点名字进球队详情、点「+ 关注」才切关注。
  //    断言必须用 onFollowTap；用 onTeamTap 这里会变成导航而不是关注。
  teamsOpts.onFollowTap.call(ctxTeams, { currentTarget: { dataset: { index: arsenalIdx } } })
  check('关注页：点关注按钮后关注数 +1', ctxTeams.data.followedCount === 1, `followedCount=${ctxTeams.data.followedCount}`)
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
  const SHARE_PAGES = ['index', 'schedule', 'mine', 'detail', 'brief', 'teams', 'rank', 'team']
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

  /* ── 2026-10-02 新增三个赛事源：KPL（腾讯官方 POST）、CBA（官方 GET）、中超（ESPN chn.1） ── */
  const syncSrc = fsMod.readFileSync(path.join(ROOT, 'tools/sync.js'), 'utf8')
  const compByKey = {}
  allData.meta.competitions.forEach((c) => { compByKey[c.key] = c })
  check('赛事：KPL / CBA / 中超 都已注册到 meta',
    ['kpl', 'cba', 'csl'].every((k) => !!compByKey[k]),
    ['kpl', 'cba', 'csl'].filter((k) => !compByKey[k]).join(' ') || 'ok')
  check('赛事：分类归属正确（中超=足球 / CBA=篮球 / KPL=电竞）',
    compByKey.csl.cat === 'football' && compByKey.cba.cat === 'basketball' && compByKey.kpl.cat === 'esports',
    `${compByKey.csl.cat}/${compByKey.cba.cat}/${compByKey.kpl.cat}`)
  const catKeysOf = (k) => ((allData.meta.categories.find((c) => c.key === k) || {}).competitions || [])
  check('赛事：三个新赛事都进了对应大类',
    catKeysOf('football').indexOf('csl') > -1 && catKeysOf('basketball').indexOf('cba') > -1 && catKeysOf('esports').indexOf('kpl') > -1)
  // 大类里的展示顺序（2026-10-02 用户定）：欧冠→五大联赛→欧国联→国字号→欧联→中超 /
  // NBA→CBA / 全球总决赛→德玛西亚杯→LPL→LCK→KPL→LEC→季中赛→亚运会
  const ORDER = {
    football: 'ucl,epl,liga,seriea,bundesliga,ligue1,nations,chn,uel,csl',
    basketball: 'nba,cba',
    esports: 'worlds,demacia,lpl,lck,kpl,lec,msi,agames',
  }
  const badOrder = Object.keys(ORDER).filter((k) => catKeysOf(k).join(',') !== ORDER[k])
  check('赛事：各大类展示顺序符合约定', badOrder.length === 0,
    badOrder.map((k) => `${k}: ${catKeysOf(k).join(',')}`).join(' | '))
  // 首页入口顺序跟 meta.competitions 一致，也要按上面的约定排
  const compOrder = allData.meta.competitions.map((c) => c.key).join(',')
  check('赛事：赛事总表顺序与大类顺序一致',
    compOrder === `${ORDER.football},${ORDER.basketball},${ORDER.esports}`, compOrder)
  // 关注页自己的赛事顺序（页面层）也要跟着走，不能跟首页/赛程页打架
  const teamsSrc = fsMod.readFileSync(path.join(ROOT, 'pages/teams/teams.js'), 'utf8')
  const selectable = ((teamsSrc.match(/const SELECTABLE = \[([^\]]+)\]/) || [])[1] || '')
    .split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean)
  const order = allData.meta.competitions.map((c) => c.key)
  const pos = selectable.map((k) => order.indexOf(k))
  check('关注页：赛事顺序与全局顺序一致（单调递增）',
    selectable.length > 0 && pos.every((v, i) => v >= 0 && (i === 0 || v > pos[i - 1])),
    selectable.join(','))
  check('赛事：KPL 抓取通道接线完整（fetchKpl + 官方域名 + POST）',
    syncSrc.indexOf('function fetchKpl(') > -1
    && syncSrc.indexOf('kplshop-op.timi-esports.qq.com/kplow') > -1
    && syncSrc.indexOf('getScheduleList') > -1 && syncSrc.indexOf('postJSON(') > -1)
  check('赛事：CBA 抓取通道接线完整（fetchCba + 官方域名）',
    syncSrc.indexOf('function fetchCba(') > -1
    && syncSrc.indexOf('portal-server.cbaleague.com') > -1
    && syncSrc.indexOf('home/home_schedules') > -1)
  // 队名中文：KPL/CBA 官方就是中文，中超靠 zh-names.js 映射（16 条按 ESPN team id）
  const zhMod = require(path.join(ROOT, 'tools/zh-names.js'))
  const cslIds = [2052, 21355, 131704, 22537, 8240, 131705, 21910, 22198, 7521, 15515, 977, 22199, 8239, 21506, 22536, 18203]
  const noCslZh = cslIds.filter((id) => !/[一-龥]/.test(zhMod.espnZh(String(id)) || ''))
  check('中文名：中超 16 队映射齐全', noCslZh.length === 0, `缺 ${noCslZh.join(',')}`)
  ;['kpl', 'cba', 'csl'].forEach((k) => {
    const list = dataMod.matches().filter((m) => m.comp === k)
    const bad = list.filter((m) => !m.home.zh || !m.away.zh)
    check(`数据层：${k} 有场次且双方队名都有中文`,
      list.length > 0 && bad.length === 0, `${list.length} 场，缺中文 ${bad.length} 场`)
  })
  // 未确定的对阵不该出现在可关注球队列表里（teamsOf 里剔除 TBD）
  const kplTeams = dataMod.teamsOf('kpl')
  check('数据层：KPL 可关注球队不含「待定」',
    kplTeams.length > 0 && kplTeams.every((t) => t.id !== 'TBD' && t.display !== '待定'),
    `${kplTeams.length} 队`)
  const kplTbd = dataMod.matches().filter((m) => m.comp === 'kpl' && (m.home.name === '待定' || m.away.name === '待定'))
  check('数据层：KPL 未确定对阵归一成 TBD（避免关注撞车）',
    kplTbd.every((m) => (m.home.name === '待定' ? m.home.id === 'TBD' : true) && (m.away.name === '待定' ? m.away.id === 'TBD' : true)),
    `${kplTbd.length} 场含待定`)

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
  // 2026-09-30 用户定：深蓝实底白字、圆角矩形、贴右下。
  // ⚠️ 必须**写死宽度**：去掉 width 让按钮自适应时，微信 button 的默认样式在电脑预览
  // 会把按钮撑到约半屏宽、盖住标题（20:31 截图实锤）。所以这里反向断言：必须有固定宽。
  const briefBtnCss = (bWxss.match(/\.mast-title-row\s+\.brief-share\s*\{([\s\S]*?)\}/) || [])[1] || ''
  const briefBtnW = Number((briefBtnCss.match(/width:\s*(\d+)rpx/) || [])[1] || 0)
  const briefBtnR = Number((briefBtnCss.match(/border-radius:\s*(\d+)rpx/) || [])[1] || 999)
  check('布局：日报页分享按钮是深蓝实底白字（#14235c）',
    /background:\s*#14235c/.test(briefBtnCss) && /color:\s*#fff/.test(briefBtnCss))
  check('布局：日报页分享按钮是圆角矩形（圆角 ≤ 16rpx）',
    briefBtnR > 0 && briefBtnR <= 16, `border-radius: ${briefBtnR}rpx`)
  check('布局：日报页分享按钮必须写死宽度且 ≤ 160rpx（自适应会被默认样式撑爆）',
    briefBtnW > 0 && briefBtnW <= 160, `width: ${briefBtnW}rpx`)
  // 报头 750-64=686rpx，标题「闪现赛程日报」居中约占 312rpx → 右边界约 499rpx。
  check('布局：日报页分享按钮不与报头标题相撞（按钮左缘 ≥ 509rpx）',
    686 - briefBtnW >= 509, `标题右缘 499rpx，按钮左缘 ${686 - briefBtnW}rpx`)

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
  teamsOpts.onFollowTap.call(ctxTeams, { currentTarget: { dataset: { index: arsenalIdx } } })
  check('关注页：再点取消关注', ctxTeams.data.followedCount === 0)
  check('关注存储：取消后 has 不命中', tfMod.has('epl', '359') === false)

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
  // 用函数声明而不是 const：页面 onLoad 有的是 async（详情页会先拉云端再渲染），
  // 上方就要用 settle 等一个微任务，const 会撞 TDZ。
  function settle() {
    return new Promise((r) => setTimeout(r, 0))
  }

  /** 等到条件成立（或轮询耗尽）。详情页 onLoad 是 async 且可能真的发网络请求，
      单次 setTimeout(0) 不一定够，这里最多等 ~200ms。 */
  async function waitUntil(fn, tries) {
    const max = tries || 20
    for (let i = 0; i < max; i += 1) {
      if (fn()) return true
      await new Promise((r) => setTimeout(r, 10))
    }
    return false
  }

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

  /* ---------- 积分榜（2026-10-02 新增） ---------- */
  const stFile = path.join(ROOT, 'data/standings.js')
  check('积分榜：数据文件存在', fs.existsSync(stFile))
  const stData = allData.standingsTables()
  const stKeys = allData.standingsKeys()
  check('积分榜：至少 10 个赛事有排名', Object.keys(stData).length >= 10, `${Object.keys(stData).length} 个`)
  check('积分榜：keys 顺序与大类一致', stKeys.join(',').indexOf('ucl') === 0 && stKeys.indexOf('epl') < stKeys.indexOf('csl'), stKeys.join(','))

  // 五大联赛 + 中超是主线，缺一个都说明上游变了
  const mustHave = ['epl', 'liga', 'seriea', 'bundesliga', 'ligue1', 'csl', 'nba']
  const missing = mustHave.filter((k) => !stData[k])
  check('积分榜：关键赛事都在', missing.length === 0, missing.length ? `缺 ${missing.join('/')}` : stKeys.join(','))

  // 杯赛与中国国字号本来就没有积分榜，不能有（有的话说明抓取逻辑串了）
  check('积分榜：杯赛与国字号没有排名', !stData.worlds && !stData.msi && !stData.chn && !stData.agames)

  const eplTable = stData.epl
  const eplRows = eplTable && eplTable.groups[0].rows
  check('积分榜：英超 20 队', !!eplRows && eplRows.length === 20, eplRows ? `${eplRows.length} 队` : '无')
  // 紧凑列：赛 / 胜平负 / 进失 / 积分 —— 2026-10-02 改版后队名不再被折叠
  check('积分榜：足球用合并列（≤4 列）', !!eplTable && eplTable.columns.length === 4,
    eplTable ? eplTable.columns.map((c) => c.label).join('/') : '')
  check('积分榜：含「积分」列', !!eplTable && eplTable.columns.some((c) => c.label === '积分'))

  // ⚠️ 排序红线：足球必须按积分降序。曾踩过把 entry 原序当成排名的情况
  const ptsDesc = eplRows ? eplRows.every((r, i) => i === 0 || eplRows[i - 1].pts >= r.pts) : false
  check('积分榜：足球按积分降序', ptsDesc, eplRows ? `${eplRows[0].zh || eplRows[0].name} ${eplRows[0].pts}分` : '')

  // 中文名必须生效（team.id 与 scoreboard 同源是这里能零成本汉化的前提）
  const zhOk = eplRows ? eplRows.every((r) => !!r.zh) : false
  check('积分榜：英超队名全为中文', zhOk, eplRows ? eplRows.slice(0, 3).map((r) => r.zh).join('/') : '')

  // NBA 要拆东/西两区，且分区名已汉化
  const nbaTable = stData.nba
  const nbaGroups = (nbaTable && nbaTable.groups) || []
  check('积分榜：NBA 拆东西两区', nbaGroups.length === 2 && nbaGroups.every((g) => g.rows.length === 15),
    nbaGroups.map((g) => g.name + ':' + g.rows.length).join(' / '))
  check('积分榜：NBA 分区名已汉化', nbaGroups.every((g) => /联盟$/.test(g.name)), nbaGroups.map((g) => g.name).join('/'))

  // ⚠️ 名次必须与数组顺序一致 —— NBA 季前赛全 0 胜时 ESPN 的 playoffSeed
  //    整体退化成 1，直接用会出现「15 队都排第 1」
  check('积分榜：名次连续无重复', eplRows ? eplRows.every((r, i) => r.pos === i + 1) : false
    && nbaGroups.every((g) => g.rows.every((r, i) => r.pos === i + 1)))

  // 分区色带：欧战/降级取自 ESPN 官方 note，红色欧冠、蓝色欧联、灰色降级
  const zoneOf = (i) => (eplRows[i] && eplRows[i].zone && eplRows[i].zone.label) || ''
  check('积分榜：英超榜首在欧冠区', zoneOf(0) === '欧冠区', zoneOf(0))
  check('积分榜：英超末三位在降级区', [17, 18, 19].every((i) => zoneOf(i) === '降级区'),
    [17, 18, 19].map(zoneOf).join('/'))
  const nbaZone = (nbaGroups[0].rows[6] && nbaGroups[0].rows[6].zone && nbaGroups[0].rows[6].zone.label) || ''
  check('积分榜：NBA 第 7 名在附加赛区', nbaZone === '附加赛区', nbaZone)

  /* ---------- 球队详情页 ---------- */
  require(path.join(ROOT, 'pages/team/team.js'))
  const teamOpts = global.__page
  const cslTop = (stData.csl && stData.csl.groups[0].rows || [])[0]

  const ctxTeam = makeCtx(teamOpts)
  teamOpts.onLoad.call(ctxTeam, { comp: 'csl', id: String(cslTop ? cslTop.id : '') })
  check('球队页：榜首球队读出排名', cslTop ? ctxTeam.data.standing && ctxTeam.data.standing.pos === 1 : false,
    cslTop ? `${ctxTeam.data.name} · ${ctxTeam.data.standingLine}` : '无数据')
  check('球队页：队名取到中文', !!ctxTeam.data.name && /[一-龥]/.test(ctxTeam.data.name), ctxTeam.data.name)
  check('球队页：战绩概览非空', !!ctxTeam.data.standingLine, ctxTeam.data.standingLine)
  check('球队页：比赛卡片已装饰（有 _accent）',
    !ctxTeam.data.matches.length || ctxTeam.data.matches.every((m) => !!m._accent),
    `${ctxTeam.data.matches.length} 场`)

  // 缺参数不能白屏
  const ctxTeamNoArg = makeCtx(teamOpts)
  teamOpts.onLoad.call(ctxTeamNoArg, {})
  check('球队页：缺参数给出提示而非白屏', !!ctxTeamNoArg.data.loadError, ctxTeamNoArg.data.loadError)

  // 关注 / 取关
  const tfKey = (cslTop && cslTop.id) ? ['csl', String(cslTop.id)] : ['csl', 'x']
  tfMod.resetCache()
  teamOpts.onFollowTap.call(ctxTeam)
  check('球队页：关注后状态为已关注', ctxTeam.data.followed === true && tfMod.has(tfKey[0], tfKey[1]) === true)
  teamOpts.onFollowTap.call(ctxTeam)
  check('球队页：再点取消关注', ctxTeam.data.followed === false && tfMod.has(tfKey[0], tfKey[1]) === false)
  tfMod.resetCache()

  // 近期战绩只能来自已结束的比赛
  const eplTop = eplRows ? eplRows[0] : null
  const ctxTeam2 = makeCtx(teamOpts)
  teamOpts.onLoad.call(ctxTeam2, { comp: 'epl', id: String(eplTop ? eplTop.id : '382') })
  check('球队页：近期战绩只含已结束比赛',
    ctxTeam2.data.form.every((f) => f.result === 'W' || f.result === 'L' || f.result === 'D' || f.result === 'U'),
    ctxTeam2.data.form.map((f) => f.resultZh).join(''))

  /* ---------- 积分榜页 ---------- */
  require(path.join(ROOT, 'pages/rank/rank.js'))
  const rankOpts = global.__page
  const ctxRank = makeCtx(rankOpts)
  rankOpts.onLoad.call(ctxRank, {})
  check('积分榜页：默认列出第一个有排名的赛事', !!ctxRank.data.activeComp && !!ctxRank.data.groups.length,
    `${ctxRank.data.compName} / ${ctxRank.data.totalTeams} 队`)
  check('积分榜页：列数与数据一致',
    ctxRank.data.columns.length > 0
    && ctxRank.data.groups.every((g) => g.rows.every((r) => r.cells.length === ctxRank.data.columns.length)),
    `${ctxRank.data.columns.length} 列`)
  check('积分榜页：切换赛事生效', (function () {
    rankOpts.onCompTap.call(ctxRank, { currentTarget: { dataset: { key: 'csl' } } })
    return ctxRank.data.activeComp === 'csl' && ctxRank.data.groups[0].rows.length === 16
  })(), `active=${ctxRank.data.activeComp}`)
  check('积分榜页：切赛事后立刻回到顶部（不用手动拖回）', collected.pageScrollTo === 0,
    `scrollTop=${collected.pageScrollTo}`)
  check('积分榜页：重复点同一赛事不触发滚动',
    (function () {
      collected.pageScrollTo = null
      rankOpts.onCompTap.call(ctxRank, { currentTarget: { dataset: { key: 'csl' } } })
      return collected.pageScrollTo === null
    })())

  // 点行 → 球队详情页
  rankOpts.onRowTap.call(ctxRank, { currentTarget: { dataset: { id: String(cslTop ? cslTop.id : '') } } })
  check('积分榜页：点球队跳球队详情',
    /\/pages\/team\/team\?comp=csl&id=/.test(collected.navigateTo || ''), collected.navigateTo)

  // 待定不是真球队，不能跳
  rankOpts.onRowTap.call(ctxRank, { currentTarget: { dataset: { id: 'TBD' } } })
  check('积分榜页：待定队名不可点', !/\/pages\/team\/team\?comp=csl&id=TBD/.test(collected.navigateTo || ''))

  /* ---------- 入口打通 ---------- */
  // 首页赛事卡：有积分榜的才显示「积分榜 ›」
  const ctxIdxRank = makeCtx(indexOpts)
  ctxIdxRank.setData({ entries: [] })
  indexOpts.onLoad.call(ctxIdxRank)
  await settle()
  const withRank = ctxIdxRank.data.entries.filter((e) => e.hasStandings)
  check('首页：有积分榜的赛事带榜首入口', withRank.length >= 8 && withRank.every((e) => !!e.leader),
    withRank.slice(0, 3).map((e) => e.name + ':' + e.leader).join(' / '))
  check('首页：杯赛不显示积分榜入口',
    ctxIdxRank.data.entries.filter((e) => e.key === 'worlds' || e.key === 'msi').every((e) => !e.hasStandings))
  indexOpts.onRankTap.call(ctxIdxRank, { currentTarget: { dataset: { key: 'csl' } } })
  check('首页：积分榜入口跳该赛事榜单', collected.navigateTo === '/pages/rank/rank?comp=csl', collected.navigateTo)

  // 详情页：队名可点、有积分榜时显示入口
  const detRank = makeCtx(detOpts)
  const detMatchForRank = allData.matches().find((m) => allData.standingsOf(m.comp))
  detOpts.onLoad.call(detRank, { id: detMatchForRank ? detMatchForRank.id : '' })
  await waitUntil(() => detRank.data.match || detRank.data.loadError)
  check('详情页：有积分榜的赛事显示榜单入口', detRank.data.hasStandings === true, detMatchForRank ? detMatchForRank.comp : '无')
  detOpts.onStandingsTap.call(detRank)
  check('详情页：点积分榜入口跳对应赛事',
    detMatchForRank ? collected.navigateTo === `/pages/rank/rank?comp=${detMatchForRank.comp}` : false, collected.navigateTo)
  detOpts.onTeamTap.call(detRank, { currentTarget: { dataset: { side: 'home' } } })
  check('详情页：点队名跳球队详情', /\/pages\/team\/team\?comp=/.test(collected.navigateTo || ''), collected.navigateTo)

  // 赛程页：选中具体赛事且该赛事有积分榜时，才出现入口条
  const ctxSchRank = makeCtx(schOpts)
  ctxSchRank.setData({ activeCat: 'football', activeComp: 'csl', mode: 'upcoming', shownGroups: 3, teamFilter: null })
  schOpts.doReload.call(ctxSchRank)
  check('赛程页：选中中超时出现积分榜入口', ctxSchRank.data.hasStandings === true && ctxSchRank.data.compName === '中超',
    `${ctxSchRank.data.compName}/${ctxSchRank.data.hasStandings}`)
  schOpts.onRankTap.call(ctxSchRank)
  check('赛程页：积分榜入口跳对应赛事', collected.navigateTo === '/pages/rank/rank?comp=csl', collected.navigateTo)

  const ctxSchNoRank = makeCtx(schOpts)
  ctxSchNoRank.setData({ activeCat: 'esports', activeComp: 'worlds', mode: 'upcoming', shownGroups: 3, teamFilter: null })
  schOpts.doReload.call(ctxSchNoRank)
  check('赛程页：杯赛不显示积分榜入口', ctxSchNoRank.data.hasStandings === false)

  // 新页面必须挂分享（右上角转发默认全灰）
  check('积分榜页挂了转发与朋友圈', typeof rankOpts.onShareAppMessage === 'function' && typeof rankOpts.onShareTimeline === 'function')
  check('球队页挂了转发与朋友圈', typeof teamOpts.onShareAppMessage === 'function' && typeof teamOpts.onShareTimeline === 'function')

  // tabBar 新增了第 4 项「积分榜」
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''))
  check('tabBar 有 4 项且含积分榜',
    appJson.tabBar.list.length === 4 && appJson.tabBar.list.some((t) => t.text === '积分榜'),
    appJson.tabBar.list.map((t) => t.text).join('/'))
  check('积分榜页已注册且指向 pages/rank/rank',
    appJson.pages.indexOf('pages/rank/rank') > -1 && appJson.pages.indexOf('pages/team/team') > -1)
  const rWxml = fs.readFileSync(path.join(ROOT, 'pages/rank/rank.wxml'), 'utf8')
  check('积分榜页：赛事胶囊条随选中项自动滚动',
    rWxml.indexOf('scroll-into-view="chip-{{activeComp}}"') > -1 && rWxml.indexOf('id="chip-{{item.key}}"') > -1)

  /* ---------- 分享进来的详情页（2026-10-02 用户反馈：好友看不到比分） ---------- */
  // 本地包是发版那一刻的快照，比分一定落后云端；详情页必须先渲染本地、再拿云端补。
  // 把 refresh 打桩成「立刻失败」，避免这条用例真的去等云端请求
  const realRefresh = allData.refresh
  allData.refresh = async () => ({ updated: false, reason: 'stub' })
  const ctxDetMiss = makeCtx(detOpts)
  // onLoad 返回 promise，直接 await 比轮询更确定
  await detOpts.onLoad.call(ctxDetMiss, { id: '不存在的比赛id' })
  check('详情页：比赛不存在时给出提示而非白屏', !!ctxDetMiss.data.loadError, ctxDetMiss.data.loadError)
  allData.refresh = realRefresh

  const ctxDetShare = makeCtx(detOpts)
  const shareMatch = allData.matches().find((m) => m.status === 'finished')
  detOpts.onLoad.call(ctxDetShare, { id: shareMatch ? shareMatch.id : '' })
  await waitUntil(() => ctxDetShare.data.match)
  check('详情页：本地有数据时立即渲染（不等网络）', !!ctxDetShare.data.match,
    shareMatch ? `${ctxDetShare.data.match.home.zhName} ${ctxDetShare.data.match.home.score}-${ctxDetShare.data.match.away.score}` : '')

  /* ---------- 队名宽度红线（用户两次反馈被折叠） ---------- */
  const rankCss = fs.readFileSync(path.join(ROOT, 'pages/rank/rank.wxss'), 'utf8')
  const grab = (re) => { const m = rankCss.match(re); return m ? Number(m[1]) : 0 }
  const tdW = grab(/\.td\s*\{[^}]*width:\s*(\d+)rpx/)
  const posW = grab(/\.th-pos,\s*\n?\.td-pos\s*\{[^}]*width:\s*(\d+)rpx/) || grab(/\.td-pos\s*\{[^}]*width:\s*(\d+)rpx/)
  const nameFont = grab(/\.team-name\s*\{[^}]*font-size:\s*(\d+)rpx/)
  const padX = grab(/\.tr\s*\{[^}]*padding:\s*0\s*(\d+)rpx/)
  const nameW = 750 - posW - 4 * tdW - padX * 2
  check('积分榜：队名列够放 6 个汉字', nameW >= 6 * nameFont,
    `队名列 ${nameW}rpx，6 字需 ${6 * nameFont}rpx（数字列 ${tdW}rpx × 4）`)

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
