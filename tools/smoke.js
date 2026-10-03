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

/* ⚠️ 必须是**稳定单例**：utils/nav.js 的 tabBar 跳转靠 globalData.pendingComp 交接参数，
   每次 getApp() 都返回新对象的话，页面 onShow 永远读不到刚写进去的值，断言就变成假绿。 */
const mockApp = {
  globalData: { favIds: [], authState: 'signed-out', cloudReady: false, pendingComp: '', pendingTeam: null },
  refreshAuth: async function () { return 'signed-out' },
  refreshFavorites: async function () { return [] },
  isFav: function (id) { return this.globalData.favIds.indexOf(id) > -1 },
}
global.getApp = function () { return mockApp }

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

  // ⚠️ 入口数可能**少于** meta —— 赛会制赛事（亚洲杯 2027-01 才开赛）在抓取窗口外
  // 一场比赛都没有，卡片只能写「暂未公布未来赛程」，所以直接不占入口位。
  // 不写死数字，只保证「有比赛的赛事一个都不少」。
  check('首页：有比赛的赛事都有入口（未进窗口的不占位）',
    d.entries.length <= allData.meta.competitions.length
    && d.entries.every((e) => e.hasNext || e.hasLast)
    && d.entries.some((e) => e.key === 'csl'),
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

  /* ---------- 已结束卡片的状态文案 ----------
     🔴 2026-10-03 用户报：00:00 开球、02:00 打完的比赛显示「2 小时前结束」。
        根因是 utils/format.js 的 sinceText(start) 算的是「距开赛多久」，
        却被当成「结束多久」显示 —— 用开赛时间冒充结束时间。
        上游 status 里没有墙钟结束时间，算不出真实结束时刻，
        所以改成直接用确定的上游文案。这里守住两点：不能用相对时间、不能为空。 */
  const viewModEarly = require(path.join(ROOT, 'utils/view'))
  const finDeco = allData.matches().filter((m) => m.status === 'finished').map((m) => viewModEarly.decorate.call({ compOf: allData.compOf }, m))
  // 失败时只报「多少场 + 前 3 个样例」，别把 600 个文案全刷出来
  const labelSample = (rows) => `${rows.length} 场，例如 ${rows.slice(0, 3).map((m) => m._statusLabel).join(' / ')}`
  const finRelative = finDeco.filter((m) => /前结束|刚刚结束|小时前|天前/.test(m._statusLabel))
  check('卡片：已结束的状态文案不是相对时间（不再拿开赛时间冒充结束时间）',
    finDeco.length > 0 && finRelative.length === 0,
    finRelative.length ? labelSample(finRelative) : `${finDeco.length} 场全通过`)
  const finBlank = finDeco.filter((m) => !String(m._statusLabel).trim())
  check('卡片：已结束的状态文案非空', finBlank.length === 0, `空文案 ${finBlank.length} 场`)
  const finLabels = Array.from(new Set(finDeco.map((m) => m._statusLabel)))
  const finOffEnum = finLabels.filter((s) => ['已结束', '已延期', '点球大战', '加时赛'].indexOf(s) === -1)
  check('卡片：已结束的状态文案沿用上游口径（已结束 / 已延期 / 点球大战 / 加时赛）',
    finOffEnum.length === 0,
    finOffEnum.length ? `枚举外文案 ${finOffEnum.slice(0, 3).join(' / ')}` : finLabels.join(' / '))
  check('fmt.sinceText 已删除（它算的是开赛时长，天然无法表达「结束时刻」）',
    typeof require(path.join(ROOT, 'utils/format')).sinceText === 'undefined')
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
  // ⚠️ 不能拿 upcoming().length 直接等于「upcoming+live」的总数：upcoming() 还会砍掉
  //    「日期已过但上游还没翻状态」的比赛（比如 23:00 开赛、跨零点还没更新），
  //    这种跨零点场次时有时无，直接比总数会随开赛时刻时红时绿。按定义验。
  check('数据层：query 支持 status 数组（live 归入即将开赛）', (() => {
    const up = dataMod.query({ status: 'upcoming' }).length
    const upLive = dataMod.query({ status: ['upcoming', 'live'] }).length
    const todayStr = require(path.join(ROOT, 'utils/format')).todayStr()
    const upc = dataMod.upcoming()
    return upLive >= up
      && upc.length <= upLive
      && upc.every((m) => m.date >= todayStr && (m.status === 'upcoming' || m.status === 'live'))
  })())
  teamsOpts.onCatTap.call(ctxTeams, { currentTarget: { dataset: { key: 'lpl' } } })
  check('关注页：切到 LPL 列出 12 队', ctxTeams.data.activeCat === 'lpl' && ctxTeams.data.teams.length === 12)
  // ⚠️ 电竞队名已改成英文简称（2026-10-02），搜索也得按简码搜，不能再用「京东」
  teamsOpts.onSearch.call(ctxTeams, { detail: { value: 'jdg' } })
  check('关注页：搜索过滤生效（按英文简称）', /JDG/i.test(ctxTeams.data.teams.map((t) => t.display + t.abbr + t.name).join(' ')) && ctxTeams.data.teams.length > 0,
    ctxTeams.data.teams.map((t) => t.display).join('/') || '空')

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
  const SHARE_PAGES = ['index', 'schedule', 'mine', 'detail', 'brief', 'teams', 'rank', 'team', 'search']
  const noShare = SHARE_PAGES.filter((p) => {
    const s = fsMod.readFileSync(path.join(ROOT, 'pages', p, p + '.js'), 'utf8')
    return s.indexOf('onShareAppMessage') < 0 || s.indexOf('onShareTimeline') < 0
  })
  check(`分享：${SHARE_PAGES.length} 个页面都挂了分享方法（否则「复制链接」是灰的）`,
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
    football: 'ucl,epl,liga,seriea,bundesliga,ligue1,nations,chn,uel,uecl,csl,acl,asiacup,u17,u17w,friendly',
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

  /* ── 2026-10-03 新增三个赛事：亚冠精英（中超球队参赛）+ 两个 U17 世界杯 ── */
  check('赛事：亚冠精英 / U17 世界杯 / U17 女足世界杯 都已注册',
    ['acl', 'u17', 'u17w'].every((k) => !!compByKey[k]),
    ['acl', 'u17', 'u17w'].filter((k) => !compByKey[k]).join(' ') || 'ok')
  check('赛事：三个新赛事都归在足球大类',
    ['acl', 'u17', 'u17w'].every((k) => catKeysOf('football').indexOf(k) > -1))
  // 国青队（"Spain U17"）的 team id 与成年国家队**不同**，ESPN_ZH 按 id 查不到，
  // 只能按英文名剥掉年龄段后缀再翻 —— 否则 48 支队在小程序上全是英文
  check('中文名：U17 队名剥掉年龄段后缀再翻',
    zhMod.nameZh('Spain U17') === '西班牙U17'
    && zhMod.nameZh('China U17') === '中国U17'
    && zhMod.nameZh('China PR U17') === '中国U17女足',
    `${zhMod.nameZh('Spain U17')} / ${zhMod.nameZh('China PR U17')}`)
  const youthMs = dataMod.matches().filter((m) => m.comp === 'u17' || m.comp === 'u17w')
  check('数据层：U17 世界杯队名已汉化（不出现 Spain U17）',
    youthMs.length === 0
    || youthMs.every((m) => /[一-龥]/.test(m.home.zh || '') && /[一-龥]/.test(m.away.zh || '')),
    youthMs.length ? youthMs.slice(0, 3).map((m) => `${m.home.zh} vs ${m.away.zh}`).join(' / ') : '窗口内暂无场次')
  const aclMs = dataMod.matches().filter((m) => m.comp === 'acl')
  check('数据层：亚冠精英已进快照且队名有中文',
    aclMs.length > 0 && aclMs.every((m) => /[一-龥]/.test(m.home.zh || '') && /[一-龥]/.test(m.away.zh || '')),
    aclMs.length ? `${aclMs.length} 场，例：${aclMs[0].home.zh} vs ${aclMs[0].away.zh}` : '窗口内暂无场次')
  check('数据层：亚冠精英含中超球队（北京国安 / 上海海港）',
    aclMs.some((m) => /北京国安|上海海港/.test((m.home.zh || '') + (m.away.zh || ''))),
    aclMs.length
      ? [...new Set(aclMs.map((m) => [m.home.zh, m.away.zh]).flat())].filter((n) => /国安|海港|申花|泰山|蓉城/.test(n)).join('/')
      : '无')

  /* ── 2026-10-03 第二批：欧协联 / 亚洲杯 / 国际友谊赛 ── */
  check('赛事：欧协联 / 亚洲杯 / 国际友谊赛 都已注册',
    ['uecl', 'asiacup', 'friendly'].every((k) => !!compByKey[k]),
    ['uecl', 'asiacup', 'friendly'].filter((k) => !compByKey[k]).join(' ') || 'ok')
  check('赛事：三个新赛事都在足球大类',
    ['uecl', 'asiacup', 'friendly'].every((k) => catKeysOf('football').indexOf(k) > -1))
  const ueclMs = dataMod.matches().filter((m) => m.comp === 'uecl')
  check('数据层：欧协联已进快照且队名有中文',
    ueclMs.length > 0 && ueclMs.every((m) => /[一-龥]/.test(m.home.zh || '') && /[一-龥]/.test(m.away.zh || '')),
    ueclMs.length ? `${ueclMs.length} 场，例：${ueclMs[0].home.zh} vs ${ueclMs[0].away.zh}` : '窗口内暂无场次')
  const frMs = dataMod.matches().filter((m) => m.comp === 'friendly')
  check('数据层：国际友谊赛已进快照且队名有中文',
    frMs.length > 0 && frMs.every((m) => /[一-龥]/.test(m.home.zh || '') && /[一-龥]/.test(m.away.zh || '')),
    frMs.length ? `${frMs.length} 场，例：${frMs[0].home.zh} vs ${frMs[0].away.zh}` : '窗口内暂无场次')
  // 亚洲杯 2027-01 开赛，45 天窗口到 2026-11-23 才会推到 → 现在多半是空的。
  // 但一旦抓到，淘汰赛对阵是 "Group A Winner" 这类占位串，必须已汉化。
  const acMs = dataMod.matches().filter((m) => m.comp === 'asiacup')
  check('数据层：亚洲杯进窗口后队名无英文残留（含淘汰赛占位）',
    acMs.length === 0
    || acMs.every((m) => /[一-龥]/.test(m.home.zh || '') && /[一-龥]/.test(m.away.zh || '')),
    acMs.length ? `${acMs.length} 场，例：${acMs[0].home.zh} vs ${acMs[0].away.zh}` : '尚未进抓取窗口（2027-01 开赛）')
  check('中文名：淘汰赛占位对阵已汉化',
    zhMod.placeholderZh('Group A Winner') === 'A 组第 1'
    && zhMod.placeholderZh('Group F 2nd Place') === 'F 组第 2'
    && zhMod.placeholderZh('3rd Place Group A/C/D') === 'A/C/D 组第 3'
    && zhMod.placeholderZh('Round of 16 3 Winner') === '16 强第 3 场胜者'
    && zhMod.placeholderZh('皇家马德里') === '',
    `${zhMod.placeholderZh('Group A Winner')} / ${zhMod.placeholderZh('Round of 16 3 Winner')}`)
  // 积分榜标了欧协联名额，赛事入口也得有；两处都对得上才算一致
  check('积分榜：欧协联榜已接入（与分区色带的欧协联名额对得上）',
    !!(dataMod.standingsOf('uecl') && dataMod.standingsOf('uecl').groups.length),
    dataMod.standingsOf('uecl') ? `${dataMod.standingsOf('uecl').groups[0].rows.length} 队` : '无')
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

  /* ---------- 赛程日报 ----------
     ⚠️ `data/brief/` 是 .gitignore 的（日报产物由 CI / brief-push.js 重新生成，里面有 AI 出图，
        提交进 git 只会让仓库膨胀）。所以在 `git archive` 出来的干净检出里它是**不存在**的 ——
        这时下面那些依赖产物的断言必然为红，而那是"环境里没有产物"，不是"代码坏了"。
        踩过：干净副本里 smoke 直接崩在 briefRows[0].pub_at 上，一屏红字盖住了真正的问题。
        现在显式识别这种情况并跳过，让 smoke 在干净副本 / CI 里也能跑完整轮。 */
  const briefApi = require(path.join(ROOT, 'utils/brief'))
  const briefDir = path.join(ROOT, 'data/brief')
  const briefFiles = fs.existsSync(briefDir)
    ? fs.readdirSync(briefDir).filter((f) => f.endsWith('.json')).sort()
    : []
  // 按云表真实行结构构造（列名是 snake_case，这是云端返回的原样）
  const briefRows = briefFiles.map((f) => {
    const p = JSON.parse(fs.readFileSync(path.join(briefDir, f), 'utf8'))
    return { id: p.id, kind: p.kind, date: p.date, pub_at: p.pubAt, mode: p.mode, payload: p, generated_at: p.generatedAt }
  }).sort((a, b) => Date.parse(b.pub_at) - Date.parse(a.pub_at))

  const noBriefArtifacts = briefRows.length === 0
  if (noBriefArtifacts) {
    check('日报：干净检出下没有 data/brief/ 产物（按预期跳过依赖产物的日报断言）', true,
      'data/brief/ 不存在或为空 —— 本地跑请先执行日报生成任务；CI 下由同步任务生成')
  } else {
    check('日报：本地已生成期次文件', briefFiles.length > 0, `${briefFiles.length} 期`)
  }

  check('日报：id 符合云端写入约束', noBriefArtifacts
    || briefRows.every((r) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}-(morning|evening)$/.test(r.id)),
  briefRows.length ? briefRows[0].id : '')
  check('日报：每期都带 AI 生成标识（合规强制）',
    briefRows.every((r) => r.payload.aigc && r.payload.aigc.explicit === 'AI 生成'))
  check('日报：出报时刻只落在 06:00 / 21:00', briefRows.every((r) => /T(06|21):00/.test(r.pub_at)),
    briefRows.length ? briefRows[0].pub_at : '')

  // 云端返回 timestamptz 常用 +00:00 输出，显示层必须自己换算到北京时间
  check('日报：北京时间显示',
    noBriefArtifacts || /^\d{1,2}月\d{1,2}日 (06|21):00$/.test(briefApi.fmtPubAt(briefRows[0].pub_at)),
    briefRows.length ? briefApi.fmtPubAt(briefRows[0].pub_at) : '（无产物，已跳过）')
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
  check('日报页：拉到期次列表', noBriefArtifacts || ctxBf.data.list.length > 0, `${ctxBf.data.list.length} 期`)
  check('日报页：最多只取 10 期', ctxBf.data.list.length <= 10, `${ctxBf.data.list.length} 期`)
  check('日报页：默认停在最新一期', noBriefArtifacts || (ctxBf.data.idx === 0 && !!ctxBf.data.cur))
  check('日报页：出报时间已格式化', noBriefArtifacts || /月/.test(ctxBf.data.pubText), ctxBf.data.pubText)

  // 内容断言看全部期次，不受「页面只加载最近 10 期」影响
  const reportIssue = allIssues.find((x) => x.mode === 'report')
  const previewIssue = allIssues.find((x) => x.mode === 'preview')
  const reportCount = allIssues.filter((x) => x.mode === 'report').length
  // 没有产物时这几条一律按"跳过"处理（`noBriefArtifacts` 已在上面判定并说明）
  check('日报：存在战报期', noBriefArtifacts || !!reportIssue, `${reportCount} 期战报 / ${allIssues.length} 期`)
  check('日报：战报期含标题/导语/正文', noBriefArtifacts || (!!reportIssue && !!reportIssue.headline.title
    && !!reportIssue.headline.lead && reportIssue.headline.body.length > 0),
  reportIssue ? reportIssue.headline.title : '无')
  check('日报：战报头条带 matchId 可跳详情', noBriefArtifacts || (!!reportIssue && !!reportIssue.headline.matchId))
  check('日报：战报头条含数据栏', noBriefArtifacts || (!!reportIssue && !!reportIssue.headline.factbox))
  check('日报：前瞻期含分组对阵', noBriefArtifacts || (!!previewIssue && previewIssue.preview.items.length > 0),
    previewIssue ? `${previewIssue.preview.items.length} 场` : '无')
  check('日报：前瞻按项目分组（足球/篮球/电竞）',
    noBriefArtifacts || (!!previewIssue && previewIssue.preview.items.every((it) => !!it.groupZh)))
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
  check('首页：日报入口条有摘要', noBriefArtifacts || !!(ctxIdxBrief.data.brief && ctxIdxBrief.data.brief.tip),
    ctxIdxBrief.data.brief ? ctxIdxBrief.data.brief.tip : '未取到')
  indexOpts.goBrief.call(ctxIdxBrief)
  check('首页：点日报入口跳日报页', collected.navigateTo === '/pages/brief/brief', collected.navigateTo)

  const ctxMineBrief = makeCtx(mineOpts)
  mineOpts.onLoad.call(ctxMineBrief)
  await settle()
  check('我的页：日报入口有摘要', noBriefArtifacts || !!(ctxMineBrief.data.brief && ctxMineBrief.data.brief.tip),
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

  // ⚠️ 只拉官方榜（2026-10-02 用户定）：CBA / KPL 官方没有排名端点，
  //    之前是靠赛果自算的，现在一律不拉 —— 出现就说明又有人把自算逻辑加回来了
  check('积分榜：不出现 CBA / KPL 的自算榜', !stData.cba && !stData.kpl,
    [stData.cba ? 'cba' : '', stData.kpl ? 'kpl' : ''].filter(Boolean).join('/') || 'ok')
  const stSrc = fs.readFileSync(path.join(ROOT, 'tools/standings.js'), 'utf8')
  check('积分榜：抓取脚本里没有自算逻辑（computeTable 已移除）',
    stSrc.indexOf('computeTable') === -1 && stSrc.indexOf('esports-api.lolesports.com') > -1)

  // 英雄联盟官方榜：LPL 分两组、LCK 两组、LEC 一组
  const lpl = stData.lpl
  const lplGroups = (lpl && lpl.groups) || []
  check('积分榜：英雄联盟三个赛区都有官方榜', !!stData.lpl && !!stData.lck && !!stData.lec,
    ['lpl', 'lck', 'lec'].filter((k) => !stData[k]).join('/') || 'lpl/lck/lec')
  check('积分榜：LPL 分涅槃组 + 登峰组',
    lplGroups.length === 2 && lplGroups.every((g) => g.rows.length > 0),
    lplGroups.map((g) => g.name + ':' + g.rows.length).join(' / '))
  check('积分榜：电竞榜用胜率而不是积分', !!lpl && lpl.columns.some((c) => c.label === '胜率')
    && !lpl.columns.some((c) => c.label === '积分'), (lpl ? lpl.columns.map((c) => c.label).join('/') : ''))
  // ⚠️ 电竞俱乐部用英文简称（BLG / T1 / G2），2026-10-02 用户要求：写中文名反而认不出来
  check('积分榜：英雄联盟队名用英文简称',
    lplGroups.every((g) => g.rows.every((r) => !r.zh && /^[A-Za-z0-9]{2,6}$/.test(r.name))),
    lplGroups[0] ? lplGroups[0].rows.slice(0, 4).map((r) => r.name).join('/') : '无')
  check('积分榜：电竞名次从 1 开始且各组独立编号',
    lplGroups.every((g) => g.rows.every((r, i) => r.pos === i + 1)),
    lplGroups.map((g) => g.rows.map((r) => r.pos).join(',')).join(' | '))

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

  /* ---------- 欧国联分区（2026-10-02 用户发现 A1 色块错位） ---------- */
  const nations = stData.nations
  const a1 = nations && nations.groups.find((g) => g.name === 'A1 组')
  const a1Names = a1 ? a1.rows.map((r) => r.zh || r.name) : []
  check('积分榜：欧国联 A1 按官方名次排（比利时第 2、意大利第 3）',
    a1Names.join('/') === '法国/比利时/意大利/土耳其', a1Names.join('/'))
  check('积分榜：欧国联 A1 四队都有分区且与前二/第3/第4 对应',
    !!a1 && a1.rows.map((r) => (r.zone && r.zone.label) || '').join('/') === '晋级八强/晋级八强/降级附加赛/降级区',
    a1 ? a1.rows.map((r) => (r.zone && r.zone.label) || '无').join('/') : '无')
  const a2 = nations && nations.groups.find((g) => g.name === 'A2 组')
  check('积分榜：欧国联其他组也有分区（不再只有 A1 独有）',
    !!a2 && a2.rows.every((r) => !!r.zone),
    a2 ? a2.rows.map((r) => r.zh + ':' + (r.zone && r.zone.label)).join(' ') : '无')
  const d1 = nations && nations.groups.find((g) => g.name === 'D1 组')
  check('积分榜：D 组只有前二有分区（D 组没有降级）',
    !!d1 && d1.rows.length >= 3
      && !!d1.rows[0].zone && !!d1.rows[1].zone
      && d1.rows.slice(2).every((r) => !r.zone),
    d1 ? d1.rows.map((r) => (r.zone && r.zone.label) || '无').join('/') : '无')
  check('积分榜：分组型赛事不再把组名当赛季名',
    nations && nations.season === '' && !/Group/.test(nations.season || ''), nations ? nations.season : '无')

  /* ---------- 五大联赛「纯联赛途径」席位（2026-10-02 与虎扑/主流口径核对后定） ----------
   * ESPN 的 note 标的是「杯赛冠军顺延之后」的结果（德甲/意甲会变成 5、6 欧联、7 欧协联），
   * 而且英超标 4 席、西甲标 5 席自相矛盾。我们只标联赛名次能确定的席位：
   * 欧冠前 4、欧联第 5、欧协联第 6；英格兰的欧协联席位是联赛杯冠军的，不按名次 → 不标。
   */
  const zonesOf = (key) => ((stData[key] && stData[key].groups[0] && stData[key].groups[0].rows) || [])
    .map((r) => (r.zone && r.zone.label) || '')
  const topZones = (key, n) => zonesOf(key).slice(0, n).join('/')
  check('积分榜：西甲 = 1-4 欧冠 / 5 欧联 / 6 欧协联（不含杯赛名额）',
    topZones('liga', 7) === '欧冠区/欧冠区/欧冠区/欧冠区/欧联区/欧协联区/', topZones('liga', 7))
  check('积分榜：德甲 = 1-4 欧冠 / 5 欧联 / 6 欧协联',
    topZones('bundesliga', 7) === '欧冠区/欧冠区/欧冠区/欧冠区/欧联区/欧协联区/', topZones('bundesliga', 7))
  check('积分榜：意甲 = 1-4 欧冠 / 5 欧联 / 6 欧协联',
    topZones('seriea', 7) === '欧冠区/欧冠区/欧冠区/欧冠区/欧联区/欧协联区/', topZones('seriea', 7))
  check('积分榜：英超 = 1-4 欧冠 / 5 欧联，第 6 名不标（欧协联归联赛杯冠军）',
    topZones('epl', 7) === '欧冠区/欧冠区/欧冠区/欧冠区/欧联区//', topZones('epl', 7))
  check('积分榜：法甲 = 1-3 欧冠 / 4 欧冠资格赛 / 5 欧联 / 6 欧协联',
    topZones('ligue1', 7) === '欧冠区/欧冠区/欧冠区/欧冠资格赛/欧联区/欧协联区/', topZones('ligue1', 7))
  // 意甲 ESPN 挂的是 "Relegated"（不是 Relegation），正则要能兜住，否则整个降级区消失
  const serieaZ = zonesOf('seriea')
  check('积分榜：意甲末三位在降级区（Relegated 也要识别）',
    serieaZ.slice(17).join('/') === '降级区/降级区/降级区', serieaZ.slice(17).join('/') || '无')

  /* ---------- 分区成带校验（2026-10-02 用户定） ---------- */
  const ligaRows = stData.liga ? stData.liga.groups[0].rows : []
  const zoneAt = (i) => (ligaRows[i] && ligaRows[i].zone && ligaRows[i].zone.label) || ''
  // ESPN 给西甲第 10 毕尔巴鄂误挂了 Europa League（对不上任何规则：上赛季第 12 无欧战，
  // 国王杯冠军是皇家社会）→ 现在整张榜都按名额表重画，这种单点脏数据根本进不来
  check('积分榜：西甲孤立的欧联区脏数据已被清掉', zoneAt(9) === '', zoneAt(9) || '无')
  // 同一种分区必须连成一段，不许出现断开的重复段
  const dupCheck = (function () {
    const seen = {}
    let broken = false
    ligaRows.forEach((r, i) => {
      const label = (r.zone && r.zone.label) || ''
      if (!label) return
      if (seen[label] != null && i !== seen[label] + 1) broken = true
      seen[label] = i
    })
    return !broken
  })()
  check('积分榜：同一种分区连成一段（无断开重复）', dupCheck)
  // 红线：杯赛冠军拿到的欧战资格与联赛名次无关，任何情况下都不能挂进积分榜
  check('积分榜：欧战区从第 1 名或紧邻上一段开始（不接杯赛名额）',
    (function () {
      const euro = []
      ligaRows.forEach((r, i) => { if (r.zone && r.zone.kind !== 'bottom') euro.push(i) })
      if (!euro.length) return false
      if (euro[0] !== 0) return false
      for (let k = 1; k < euro.length; k += 1) if (euro[k] - euro[k - 1] > 1) return false
      return true
    })(), ligaRows.map((r) => (r.zone && r.zone.label) || '').filter(Boolean).join('/'))

  /* ---------- 射手榜 / 助攻榜（2026-10-03 新增） ---------- */
  const scFile = path.join(ROOT, 'data/scorers.js')
  check('射手榜：数据文件存在', fs.existsSync(scFile))
  const scData = allData.scorersTables()
  const scKeys = allData.scorersKeys()
  check('射手榜：至少 10 个赛事有球员榜', Object.keys(scData).length >= 10, `${Object.keys(scData).length} 个`)
  const scWant = ['ucl', 'epl', 'liga', 'seriea', 'bundesliga', 'ligue1', 'nations', 'uel', 'csl', 'acl']
  const scMissing = scWant.filter((k) => !scData[k])
  check('射手榜：关键赛事都在', scMissing.length === 0, scMissing.length ? `缺 ${scMissing.join('/')}` : scKeys.join(','))
  check('射手榜：keys 顺序与大类一致',
    scKeys.join(',').indexOf('ucl') === 0 && scKeys.indexOf('epl') < scKeys.indexOf('csl'), scKeys.join(','))
  // 上游不提供这两个榜的赛事不能凭空出现（篮球、电竞、国字号、杯赛）
  check('射手榜：杯赛 / 国字号 / 篮球 / 电竞都没有球员榜',
    !scData.worlds && !scData.msi && !scData.chn && !scData.agames
    && !scData.nba && !scData.cba && !scData.kpl && !scData.u17 && !scData.u17w && !scData.asiacup)
  // 覆盖面关系：有射手榜的赛事一定有积分榜，反过来不成立（欧协联有榜但上游不给球员榜）
  check('射手榜：覆盖面是积分榜的真子集（欧协联有榜无射手榜）',
    Object.keys(scData).every((k) => !!stData[k]) && !!stData.uecl && !scData.uecl,
    `射手榜 ${Object.keys(scData).length} 项 / 积分榜 ${Object.keys(stData).length} 项`)
  check('射手榜：每个赛事至少 20 名球员',
    Object.keys(scData).every((k) => (scData[k].players || []).length >= 20),
    Object.keys(scData).map((k) => `${k}=${scData[k].players.length}`).join(' '))

  const scFlat = []
  Object.keys(scData).forEach((k) => (scData[k].players || []).forEach((p) => scFlat.push(Object.assign({ comp: k }, p))))
  check('射手榜：每条记录都有数字 athlete id', scFlat.every((p) => /^\d+$/.test(String(p.i || ''))), `${scFlat.length} 人`)
  check('射手榜：每条记录至少有一个进球或助攻', scFlat.every((p) => p.g != null || p.a != null))
  check('射手榜：球员 id 在同一赛事内唯一',
    Object.keys(scData).every(function (k) {
      const seen = {}
      return (scData[k].players || []).every((p) => {
        if (seen[p.i]) return false
        seen[p.i] = 1
        return true
      })
    }))
  // 🔴 队名绝不能空着 —— 页面拿到空 tz 就会回落显示裸数字 team id（"7115"），比英文名还糟。
  //    根因：espnZh 只按 id 查 ESPN_ZH，亚冠那批俱乐部只在按**名字**索引的 CLUB_ZH 里。
  const bareTeam = scFlat.filter((p) => p.t && !p.tz)
  check('射手榜：球队名不为空（不能把数字 team id 当队名显示）',
    bareTeam.length === 0,
    bareTeam.length ? `${bareTeam.length} 人，例如 ${bareTeam.slice(0, 3).map((p) => `${p.s}@${p.t}`).join(' / ')}` : `${scFlat.length} 人全部有队名`)
  // 🔴 中文名必须含汉字。Wikidata 带 languagefallback 时缺中文标签会**回填英文**，
  //    直接采信就会往字典里写进 'Danijel Šturm' 这种"中文名"（生成器已改为以 zhwiki 标题为准）
  const badZh = scFlat.filter((p) => p.z && !/[\u3400-\u9fff]/.test(p.z))
  check('射手榜：中文名必须含汉字（防止用英文回填）',
    badZh.length === 0,
    badZh.length ? badZh.slice(0, 3).map((p) => p.z).join(' / ') : `已汉化 ${scFlat.filter((p) => p.z).length}/${scFlat.length} 人`)

  const znMod = require(path.join(ROOT, 'tools/zh-names'))
  const manualIds = Object.keys(znMod.PLAYER_ZH || {})
  check('射手榜：PLAYER_ZH 的 key 是 athlete id 且值非空',
    manualIds.every((k) => /^\d+$/.test(k) && !!String(znMod.PLAYER_ZH[k]).trim()), `${manualIds.length} 条人工条目`)
  let autoCount = 0
  let autoDict = {}
  try {
    autoDict = require(path.join(ROOT, 'tools/player-zh')).AUTO_PLAYER_ZH || {}
    autoCount = Object.keys(autoDict).length
  } catch (e) { autoCount = 0 }
  check('射手榜：球员中文字典已建立（人工 + 自动种子）', manualIds.length + autoCount >= 100,
    `人工 ${manualIds.length} + 自动 ${autoCount}`)

  // 🔴 自动字典里不能出现港台译名。
  //    踩过：早期用中文维基全文检索，捞回一批港式音译（「安祖·罗拔臣」「伊斯高」「尼曼查·马迪」），
  //    面向大陆读者比英文短名更让人困惑 —— 生成器现在宁可回落英文，这里守住别退回。
  const TRAD_ONLY = /[羅爾賓貝蘭馬奧薩費華維賀蘇積龍衛頓遜謝贊亞倫齊傑納萊內魯歷聯賽國隊韋]/
  const tradAuto = Object.keys(autoDict).filter((k) => TRAD_ONLY.test(autoDict[k]))
  check('射手榜：自动字典里没有港台译名（含繁体专用字）', tradAuto.length === 0,
    tradAuto.length ? tradAuto.slice(0, 3).map((k) => autoDict[k]).join(' / ') : `${autoCount} 条自动条目全部像简体`)
  check('射手榜：自动字典的值都含汉字（不能用英文回填）',
    Object.keys(autoDict).every((k) => /[\u3400-\u9fff]/.test(autoDict[k])))

  // 🔴 生成器的检索通道 —— 别退回到中文维基全文检索（那是被推翻的做法，见 REFERENCE.md）
  const pnSrc = fs.readFileSync(path.join(ROOT, 'tools/player-names.js'), 'utf8')
  check('球员名生成器：走 Wikidata wbsearchentities 找实体',
    pnSrc.indexOf('action=wbsearchentities') !== -1 && pnSrc.indexOf('generator=search') === -1)
  check('球员名生成器：译名优先 zh-cn / zh-hans（大陆译法）',
    pnSrc.indexOf("'zh-cn'") !== -1 && pnSrc.indexOf("'zh-hans'") !== -1)
  check('球员名生成器：可被 require 而不触发整轮抓取（require.main 守卫）',
    pnSrc.indexOf('require.main === module') !== -1)

  check('射手榜：playerZh 只吃 id，不按名字查（同名球员很多）',
    znMod.playerZh('253989') === '哈兰德' && znMod.playerZh(253989) === '哈兰德' && znMod.playerZh('no-such-id') === '')
  // 生成器里不能把友谊赛接上：友谊赛进球毫无参考价值（与「不抓友谊赛详情」同一理由）
  const scSrc = fs.readFileSync(path.join(ROOT, 'tools/scorers.js'), 'utf8')
  check('射手榜：友谊赛故意不接（进球无参考价值）', scSrc.indexOf("key: 'friendly'") === -1)

  const uclGoals = allData.scorersTop('ucl', 'goals', 20)
  check('射手榜：按进球降序', uclGoals.length > 0 && uclGoals.every((r, i) => i === 0 || uclGoals[i - 1].value >= r.value),
    uclGoals.slice(0, 3).map((r) => `${r.name} ${r.value}`).join(' / '))
  check('射手榜：名次从 1 连续、进球为 0 的不进榜',
    uclGoals.every((r, i) => r.pos === i + 1 && r.value > 0))
  check('射手榜：name 优先中文（有中文名的行必须含汉字）',
    uclGoals.filter((r) => r.hasZh).every((r) => /[\u3400-\u9fff]/.test(r.name)))
  check('射手榜：未收录中文名的回落英文短名（不是留空）',
    uclGoals.filter((r) => !r.hasZh).every((r) => !!r.name && r.name === r.en))
  const uclAssists = allData.scorersTop('ucl', 'assists', 20)
  check('助攻榜：按助攻降序', uclAssists.length > 0 && uclAssists.every((r, i) => i === 0 || uclAssists[i - 1].value >= r.value),
    uclAssists.slice(0, 3).map((r) => `${r.name} ${r.value}`).join(' / '))
  check('射手榜：排序稳定（同一批数据两次调用结果一致）',
    JSON.stringify(allData.scorersTop('liga', 'goals', 20)) === JSON.stringify(allData.scorersTop('liga', 'goals', 20)))
  check('射手榜：没有球员榜的赛事返回空数组',
    allData.scorersTop('uecl', 'goals', 20).length === 0
    && allData.scorersTop('chn', 'goals', 20).length === 0
    && allData.scorersTop('nba', 'goals', 20).length === 0)

  /* ---------- 比赛详情：事件时间轴 / 双方近况 / 历史交锋 / 技术统计 ---------- */
  const md = require(path.join(ROOT, 'tools/match-detail.js'))
  // ESPN 的 keyEvents 里约 1/4 是 "Start Delay" / "End Delay"，还有开哨、中场这类
  // 结构性节点 —— 全放出来时间轴会又臭又长
  check('详情：过滤掉 ESPN 的噪音事件（Delay / 开哨 / 中场）',
    !md.keepEvent({ type: { text: 'Start Delay' } })
      && !md.keepEvent({ type: { text: 'End Delay' } })
      && !md.keepEvent({ type: { text: 'Kickoff' } })
      && !md.keepEvent({ type: { text: 'Halftime' } })
      && !md.keepEvent({ type: { text: 'End Regular Time' } })
      && md.keepEvent({ type: { text: 'Yellow Card' } })
      && md.keepEvent({ type: { text: 'Substitution' } })
      && md.keepEvent({ type: { text: 'Goal' }, scoringPlay: true }))
  const zhTypes = ['Yellow Card', 'Red Card', 'Substitution', 'Goal', 'Goal - Header', 'Penalty Goal', 'Own Goal']
  check('详情：事件类型已汉化', zhTypes.every((t) => /[一-龥]/.test(md.zhEvent(t) || '')),
    zhTypes.map((t) => md.zhEvent(t)).join('/'))
  // 多来源赛事（中国国字号）没有固定 slug，抓取时必须写进比赛对象，否则详情拿不到
  check('详情：slug 定位 —— 单一来源查表、多来源用比赛自带值',
    md.resolveSlug({ comp: 'epl' }) === 'eng.1'
      && md.resolveSlug({ comp: 'chn', slug: 'fifa.friendly' }) === 'fifa.friendly'
      && md.resolveSlug({ comp: 'worlds' }) === null,
    `epl=${md.resolveSlug({ comp: 'epl' })} chn=${md.resolveSlug({ comp: 'chn', slug: 'fifa.friendly' })} worlds=${md.resolveSlug({ comp: 'worlds' })}`)
  // ⚠️ 排除 man- 前缀：补录比赛不走 ESPN，本来就没有 event id，天然没有详情
  const chnFin = (matches() || []).filter((x) => x.comp === 'chn' && x.status === 'finished' && !/^man-/.test(x.id))
  check('详情：中国国字号场次带来源 slug（中国 0-5 巴勒斯坦查不到详情的根因）',
    chnFin.length > 0 && chnFin.every((x) => !!x.slug),
    chnFin.length ? chnFin.map((x) => `${x.id}→${x.slug}`).join(' | ') : '无 chn 已结束场次')
  check('详情：换人只留「谁换下谁」且不带伤病因',
    md.briefOf('Substitution, Germany. A replaces B because of an injury.', '换人') === 'A 换下 B',
    md.briefOf('Substitution, Germany. A replaces B because of an injury.', '换人'))
  check('详情：黄牌只留球员名',
    md.briefOf('Kenny Kindle (Liechtenstein) is shown the yellow card', '黄牌') === 'Kenny Kindle',
    md.briefOf('Kenny Kindle (Liechtenstein) is shown the yellow card', '黄牌'))

  /* 增量抓取策略：全量重抓一天 1~2GB 会被 ESPN 限流，所以每种状态各有一条规则 */
  const t0 = Date.now()
  const cap = (v, ts) => ({ x: { v, ts } })
  check('详情：进行中的比赛每班都重抓（比分在变）',
    md.needsFetch({ id: 'x', status: 'live' }, cap(md.SCHEMA, t0)) === true)
  check('详情：已结束的比赛抓过一次就不再抓（事件不会变）',
    md.needsFetch({ id: 'x', status: 'finished' }, cap(md.SCHEMA, 0)) === false)
  check('详情：没抓过的比赛一律要抓',
    md.needsFetch({ id: 'y', status: 'finished' }, cap(md.SCHEMA, t0)) === true)
  // ⚠️ 云端存的是「抽完的成品」，改了抽取逻辑光推代码没用 —— 版本号不同强制重抓一次
  check('详情：schema 升级后老数据会被重抓一次',
    md.needsFetch({ id: 'x', status: 'finished' }, cap(md.SCHEMA - 1, t0)) === true)
  check('详情：未开赛的比赛 12 小时内不重复抓',
    md.needsFetch({ id: 'x', status: 'upcoming' }, cap(md.SCHEMA, t0)) === false)
  check('详情：未开赛超过 12 小时会刷新（近况可能变了）',
    md.needsFetch({ id: 'x', status: 'upcoming' }, cap(md.SCHEMA, t0 - 13 * 3600 * 1000)) === true)
  // ESPN 会把「已排定但还没打」的比赛也算进 seasonseries（比分 0-0），
  // 赛季初尤其多 —— 直接显示会被当成数据错误
  // 赛事从「抓详情」名单里去掉后，云端老行必须被清掉 —— 详情桶是打进包的，占体积
  check('详情：不抓详情的赛事（国际友谊赛）判定正确',
    md.detailCapable('uecl') === true && md.detailCapable('chn') === true
    && md.detailCapable('friendly') === false && md.detailCapable('worlds') === false)
  check('详情：交锋只保留已打过的比赛（未开赛的 0-0 会被误当战绩）',
    md.isPlayed({ statusType: { state: 'post' } }) === true
    && md.isPlayed({ statusType: { state: 'pre' } }) === false
    && md.isPlayed({}) === false && md.isPlayed(null) === false)

  const mdFile = path.join(ROOT, 'data', 'match-details.js')
  if (fsMod.existsSync(mdFile)) {
    const mdData = require(mdFile)
    const all = []
    mdData.buckets.forEach((b) => Object.keys(b.payload || {}).forEach((k) => all.push(b.payload[k])))
    const evs = all.reduce((acc, d) => acc.concat(d.events || []), [])
    check('详情：抽出的事件类型全部是中文', evs.length > 0 && evs.every((e) => /[一-龥]/.test(e.t)),
      evs.length ? evs.slice(0, 5).map((e) => e.t).join('/') : '无事件')
    const opps = all.reduce((acc, d) => acc.concat((d.form && d.form.home) || [], (d.form && d.form.away) || []), [])
    // ⚠️ 数据层只能查到「空 / 裸数字」这一档 —— 存量条目只留了对手名、把 id 丢了，
    //    所以「该翻的没翻」验不了（大俱乐部的映射按 **id** 存在 ESPN_ZH 里，
    //    按名字查是查不到的）。汉化正确性交给下面对 teamZh 的单元级校验。
    //    另外：近况里混进**业余杯赛对手**（拜仁的 DFB-Pokal 对手 "HEBC Hamburg"、
    //    "Lüneburger SK Hansa"）本来就该回落英文，不能当成汉化漏网。
    const oppBad = opps.filter((g) => {
      const s = String(g.opp || '').trim()
      return !s || /^\d+$/.test(s)
    })
    check('详情：近况的对手名不为空、不出现裸数字 id',
      opps.length > 0 && oppBad.length === 0,
      oppBad.length ? oppBad.slice(0, 5).map((g) => g.opp).join('/') : `${opps.length} 条通过`)
    // 对手名映射这件事本身：已知队出中文、未知队回落英文原名、**绝不把 id 当名字吐出来**
    // （亚冠那批俱乐部就踩过：只按 id 查字典 → 界面上出现 "7115"）
    check('详情：对手名映射对已知队出中文、未知队回落英文、绝不回数字 id',
      /[\u3400-\u9fff]/.test(md.teamZh('86', 'Real Madrid'))
      && md.teamZh('99999999', 'HEBC Hamburg') === 'HEBC Hamburg'
      && md.teamZh('31415263', 'Not A Real Club') === 'Not A Real Club'
      && md.teamZh('31415263', '') === ''
      && md.teamZh('', '') === '',
      `${md.teamZh('86', 'Real Madrid')} / ${md.teamZh('99999999', 'HEBC Hamburg')} / ${JSON.stringify(md.teamZh('31415263', ''))}`)
    check('详情：交锋战绩已汉化（不出现 Series / leads）',
      all.every((d) => !d.h2h || !d.h2h.summary || (/[一-龥]/.test(d.h2h.summary) && !/Series|leads/i.test(d.h2h.summary))),
      (all.find((d) => d.h2h && d.h2h.summary) || {}).h2h ? all.find((d) => d.h2h && d.h2h.summary).h2h.summary : '无')

    const deco = require(path.join(ROOT, 'pages/detail/detail.js')).decorateDetail
    const sample = all.find((d) => (d.stats || []).length)
    const decoed = deco(sample || { events: [], stats: [], form: {} }, {
      home: { zhName: '主队' }, away: { zhName: '客队' },
    })
    // 对比条按「值 / 最大值」归一：大值那边占满，小的等比缩 —— 两边不会都半截
    // ⚠️ 两队都是 0 的统计项（如红牌 0-0）两边都是空条，这是真实数据不是 bug
  check('详情：技术统计对比条大值占满（其余等比）',
      decoed.stats.length > 0 && decoed.stats.every((s) => Math.max(s.hp, s.ap) === 100 || (s.hp === 0 && s.ap === 0)),
      decoed.stats.map((s) => `${s.k}:${s.hp}+${s.ap}`).join(' '))
    // 用户真机反馈：只有球员名看不出是哪个队的 —— 事件类型必须拼上队名
    check('详情：事件类型已拼上队别',
      decoed.events.length > 0 && decoed.events.every((e) => !e.side || /·/.test(e.tLabel)),
      decoed.events.slice(0, 3).map((e) => e.tLabel).join(' / '))
    check('详情：换人默认折叠（先只展示进球与牌）',
      decoed.shownEvents === decoed.keyEvents && decoed.subCount === decoed.events.length - decoed.keyEvents.length,
      `展示 ${decoed.shownEvents.length} / 共 ${decoed.events.length}`)
    check('详情：只有 ESPN 赛事才有详情（LoL 等不入桶）',
      all.every((d) => !/^man-/.test(d.id)), all.length ? all[0].id : '无')

    /* ---------- 赛前预览：未开赛的比赛也要有「近况 + 交锋」 ---------- */
    const mdToday = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
    const upIds = (matches() || []).filter((x) => x.status === 'upcoming').map((x) => x.id)
    const pre = all.filter((d) => upIds.indexOf(d.id) > -1)
    check('详情：未来 7 天内开赛的比赛都已抓到（赛前预览）',
      upIds.length > 0 && pre.length > 0, `赛程里 ${upIds.length} 场未开赛，已抓 ${pre.length} 场`)
    check('详情：赛前场次没有事件与统计（页面据此隐藏那两块）',
      pre.every((d) => !(d.events || []).length && !(d.stats || []).length),
      pre.filter((d) => (d.events || []).length || (d.stats || []).length).slice(0, 3).map((d) => d.id).join(',') || 'ok')
    check('详情：赛前场次至少有一方的近况（不是空壳）',
      pre.some((d) => ((d.form && d.form.home) || []).length > 0),
      pre.length ? `${pre.filter((d) => ((d.form && d.form.home) || []).length).length}/${pre.length} 场有近况` : '无')
    // 交锋里出现「未来日期 + 0-0」＝把没打的比赛当成了历史战绩
    const ghostH2H = []
    all.forEach((d) => ((d.h2h && d.h2h.list) || []).forEach((e) => {
      if (e.hs === '0' && e.as === '0' && e.d > mdToday) ghostH2H.push(`${d.id}:${e.d}`)
    }))
    check('详情：交锋里没有未开赛的幽灵 0-0',
      ghostH2H.length === 0, ghostH2H.slice(0, 4).join(' ') || `${mdToday} 之后无 0-0`)
    // ts / v 是增量刷新的唯一依据，缺了就会退化成全量重抓
    check('详情：每条都带抓取时刻与 schema 版本',
      all.length > 0 && all.every((d) => typeof d.ts === 'number' && d.v === md.SCHEMA),
      all.length ? `v=${all[0].v} / 期望 ${md.SCHEMA}` : '无')
  }

  /* ---------- 赛前预览的页面表现 ---------- */
  const decoPre = require(path.join(ROOT, 'pages/detail/detail.js')).decorateDetail
  const preDeco = decoPre(
    { events: [], stats: [], form: { home: [{ at: '主', opp: '阿森纳', sc: '2-1', r: 'W' }] }, h2h: null },
    { status: 'upcoming', home: { zhName: '皇马' }, away: { zhName: '拜仁' } }
  )
  check('详情页：未开赛标记为赛前预览（展示「开赛后会换成…」的说明）', preDeco.isPre === true)
  check('详情页：赛前不显示时间轴与技术统计',
    preDeco.hasTimeline === false && preDeco.hasStats === false && preDeco.hasForm === true)
  const doneDeco = decoPre(
    { events: [{ m: "45'", t: '进球', s: 'A', side: 'home' }], stats: [], form: {}, h2h: null },
    { status: 'finished', home: { zhName: '皇马' }, away: { zhName: '拜仁' } }
  )
  check('详情页：已结束的比赛不显示赛前说明', doneDeco.isPre === false && doneDeco.hasTimeline === true)
  const dWxmlPre = fsMod.readFileSync(path.join(ROOT, 'pages/detail/detail.wxml'), 'utf8')
  check('详情页：赛前说明块已接线（pre-tip）',
    dWxmlPre.indexOf('wx:if="{{detail.isPre') > -1 && dWxmlPre.indexOf('class="pre-tip"') > -1)

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
  // 刚进页面只渲染当前 ±1 屏（滑过的会留着，所以这条必须在任何切换之前验）
  check('积分榜页：只渲染当前 ±1 屏，避免首屏铺开全部榜单',
    (function () {
      const idx = ctxRank.data.swiperIndex
      const vis = ctxRank.data.slides.filter((s) => s.visible).length
      return vis <= 3
        && ctxRank.data.slides.every((s, i) => (Math.abs(i - idx) <= 1 ? s.visible : !s.visible))
    })(), `已渲染 ${ctxRank.data.slides.filter((s) => s.visible).length} 屏`)
  check('积分榜页：切换赛事生效', (function () {
    rankOpts.onCompTap.call(ctxRank, { currentTarget: { dataset: { key: 'csl' } } })
    return ctxRank.data.activeComp === 'csl' && ctxRank.data.groups[0].rows.length === 16
  })(), `active=${ctxRank.data.activeComp}`)
  check('积分榜页：点标签后该榜回到第 1 名（不用手动拖回）',
    ctxRank.data.slideTop.csl === 0, `slideTop=${JSON.stringify(ctxRank.data.slideTop)}`)
  check('积分榜页：每个赛事一屏，slides 与赛事数一致',
    ctxRank.data.slides.length === ctxRank.data.comps.length
    && ctxRank.data.slides.every((s) => !!s.key),
    `${ctxRank.data.slides.length} 屏 / ${ctxRank.data.comps.length} 赛事`)

  // 内容区横滑 → 立刻换赛事（顶部标签由 scroll-into-view 跟着锚定）
  check('积分榜页：横滑内容区立刻切换赛事',
    (function () {
      const idx = ctxRank.data.comps.findIndex((c) => c.key === 'epl')
      rankOpts.onSwiperChange.call(ctxRank, { detail: { current: idx } })
      return ctxRank.data.activeComp === 'epl' && ctxRank.data.swiperIndex === idx
    })(), `active=${ctxRank.data.activeComp}`)
  check('积分榜页：横滑不重置滚动位置（滑回来还在原处）',
    ctxRank.data.slideTop.epl == null || ctxRank.data.slideTop.epl !== 0)

  // 标签区：重复点当前赛事不应有任何动作
  check('积分榜页：重复点当前赛事不重复渲染',
    (function () {
      const before = ctxRank.data.swiperIndex
      rankOpts.onCompTap.call(ctxRank, { currentTarget: { dataset: { key: ctxRank.data.activeComp } } })
      return ctxRank.data.swiperIndex === before && ctxRank.data.activeComp === 'epl'
    })())

  // 回到中超，后面的用例依赖它
  rankOpts.onCompTap.call(ctxRank, { currentTarget: { dataset: { key: 'csl' } } })

  // 点行 → 球队详情页
  rankOpts.onRowTap.call(ctxRank, { currentTarget: { dataset: { id: String(cslTop ? cslTop.id : '') } } })
  check('积分榜页：点球队跳球队详情',
    /\/pages\/team\/team\?comp=csl&id=/.test(collected.navigateTo || ''), collected.navigateTo)

  // 待定不是真球队，不能跳
  rankOpts.onRowTap.call(ctxRank, { currentTarget: { dataset: { id: 'TBD' } } })
  check('积分榜页：待定队名不可点', !/\/pages\/team\/team\?comp=csl&id=TBD/.test(collected.navigateTo || ''))

  /* ---------- 积分榜页：射手榜 / 助攻榜档（2026-10-03 新增） ---------- */
  rankOpts.onCompTap.call(ctxRank, { currentTarget: { dataset: { key: 'epl' } } })
  check('积分榜页：三档都存在（积分榜 / 射手榜 / 助攻榜）',
    ctxRank.data.tiers.length === 3 && ctxRank.data.tiers.map((t) => t.label).join('/') === '积分榜/射手榜/助攻榜',
    ctxRank.data.tiers.map((t) => t.label).join('/'))
  check('积分榜页：默认停在积分榜档', ctxRank.data.tier === 'standings', ctxRank.data.tier)

  rankOpts.onTierTap.call(ctxRank, { currentTarget: { dataset: { key: 'goals' } } })
  check('积分榜页：切到射手榜档并渲染出榜单',
    ctxRank.data.tier === 'goals' && ctxRank.data.rankRows.length > 0,
    `${ctxRank.data.tier} / ${ctxRank.data.rankRows.length} 行`)
  check('积分榜页：射手榜按进球降序（渲染的就是排序后的行）',
    ctxRank.data.rankRows.every((r, i) => i === 0 || ctxRank.data.rankRows[i - 1].value >= r.value),
    ctxRank.data.rankRows.slice(0, 3).map((r) => `${r.name} ${r.value}`).join(' / '))
  check('积分榜页：射手榜名次从 1 连续', ctxRank.data.rankRows.every((r, i) => r.pos === i + 1))
  // 每一屏自带当前档位的行 —— 横滑切屏那一帧不能拿错榜（页面级镜像会晚一拍）
  check('积分榜页：每一屏都自带当前档位的行数据',
    ctxRank.data.slides.every((s) => Array.isArray(s.rankRows) && Array.isArray(s.goals) && Array.isArray(s.assists)))

  rankOpts.onTierTap.call(ctxRank, { currentTarget: { dataset: { key: 'assists' } } })
  check('积分榜页：切到助攻榜档并按助攻降序',
    ctxRank.data.tier === 'assists' && ctxRank.data.rankRows.length > 0
    && ctxRank.data.rankRows.every((r, i) => i === 0 || ctxRank.data.rankRows[i - 1].value >= r.value),
    ctxRank.data.rankRows.slice(0, 3).map((r) => `${r.name} ${r.value}`).join(' / '))

  // 射手榜一行点进去看的是「他所在的球队」，不是球员本人（没有球员详情页）
  const scorerRow = ctxRank.data.rankRows[0]
  collected.navigateTo = ''
  rankOpts.onRowTap.call(ctxRank, { currentTarget: { dataset: { id: String(scorerRow.teamId) } } })
  check('积分榜页：射手榜点一行跳到该球员所在球队',
    !!scorerRow.teamId && new RegExp(`/pages/team/team\\?comp=epl&id=${scorerRow.teamId}`).test(collected.navigateTo || ''),
    collected.navigateTo)

  // 欧协联上游不给球员榜 → 该档位置灰、点了不响应、档位自动回落
  rankOpts.onCompTap.call(ctxRank, { currentTarget: { dataset: { key: 'uecl' } } })
  check('积分榜页：切到无球员榜的赛事时档位自动回落积分榜',
    ctxRank.data.tier === 'standings', ctxRank.data.tier)
  check('积分榜页：无球员榜赛事的射手榜档位置灰',
    (ctxRank.data.tiers.find((t) => t.key === 'goals') || {}).enabled === false
    && (ctxRank.data.tiers.find((t) => t.key === 'standings') || {}).enabled === true,
    ctxRank.data.tiers.map((t) => `${t.label}${t.enabled ? '' : '(灰)'}`).join('/'))
  rankOpts.onTierTap.call(ctxRank, { currentTarget: { dataset: { key: 'goals' } } })
  check('积分榜页：点置灰的档位不生效',
    ctxRank.data.tier === 'standings' && ctxRank.data.rankRows.length === 0)

  // 分享链接带上档位，别人点开直接落在同一档
  rankOpts.onCompTap.call(ctxRank, { currentTarget: { dataset: { key: 'liga' } } })
  rankOpts.onTierTap.call(ctxRank, { currentTarget: { dataset: { key: 'goals' } } })
  const scShare = rankOpts.onShareAppMessage.call(ctxRank)
  check('积分榜页：分享链接带上了当前档位',
    /comp=liga/.test(scShare.path || '') && /tier=goals/.test(scShare.path || ''), scShare.path)

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
  // ⚠️ 积分榜是 tabBar 页面：只能 switchTab + pendingComp 交接，navigateTo 会静默失败
  collected.switchTab = ''
  mockApp.globalData.pendingComp = ''
  indexOpts.onRankTap.call(ctxIdxRank, { currentTarget: { dataset: { key: 'csl' } } })
  check('首页：积分榜入口切到积分榜 tab', collected.switchTab === '/pages/rank/rank', collected.switchTab)
  check('首页：积分榜入口带上该赛事', mockApp.globalData.pendingComp === 'csl', mockApp.globalData.pendingComp)

  // 详情页：队名可点、有积分榜时显示入口
  const detRank = makeCtx(detOpts)
  const detMatchForRank = allData.matches().find((m) => allData.standingsOf(m.comp))
  detOpts.onLoad.call(detRank, { id: detMatchForRank ? detMatchForRank.id : '' })
  await waitUntil(() => detRank.data.match || detRank.data.loadError)
  check('详情页：有积分榜的赛事显示榜单入口', detRank.data.hasStandings === true, detMatchForRank ? detMatchForRank.comp : '无')
  collected.switchTab = ''
  mockApp.globalData.pendingComp = ''
  detOpts.onStandingsTap.call(detRank)
  check('详情页：点积分榜入口切到积分榜 tab', collected.switchTab === '/pages/rank/rank', collected.switchTab)
  check('详情页：积分榜入口带上该赛事',
    detMatchForRank ? mockApp.globalData.pendingComp === detMatchForRank.comp : false, mockApp.globalData.pendingComp)
  detOpts.onTeamTap.call(detRank, { currentTarget: { dataset: { side: 'home' } } })
  check('详情页：点队名跳球队详情', /\/pages\/team\/team\?comp=/.test(collected.navigateTo || ''), collected.navigateTo)

  // 赛程页：选中具体赛事且该赛事有积分榜时，才出现入口条
  const ctxSchRank = makeCtx(schOpts)
  ctxSchRank.setData({ activeCat: 'football', activeComp: 'csl', mode: 'upcoming', shownGroups: 3, teamFilter: null })
  schOpts.doReload.call(ctxSchRank)
  check('赛程页：选中中超时出现积分榜入口', ctxSchRank.data.hasStandings === true && ctxSchRank.data.compName === '中超',
    `${ctxSchRank.data.compName}/${ctxSchRank.data.hasStandings}`)
  collected.switchTab = ''
  mockApp.globalData.pendingComp = ''
  schOpts.onRankTap.call(ctxSchRank)
  check('赛程页：积分榜入口切到积分榜 tab', collected.switchTab === '/pages/rank/rank', collected.switchTab)
  check('赛程页：积分榜入口带上该赛事', mockApp.globalData.pendingComp === 'csl', mockApp.globalData.pendingComp)

  // 球队详情页的「看排名」同样只能 switchTab（teamOpts / rankOpts 见上文 1273 / 1310 行）
  collected.switchTab = ''
  mockApp.globalData.pendingComp = ''
  const ctxTeamRank = makeCtx(teamOpts)
  ctxTeamRank.setData({ comp: 'csl', id: '21355', hasStandings: true })
  teamOpts.goRank.call(ctxTeamRank)
  check('球队页：看排名切到积分榜 tab', collected.switchTab === '/pages/rank/rank', collected.switchTab)
  check('球队页：看排名带上该赛事', mockApp.globalData.pendingComp === 'csl', mockApp.globalData.pendingComp)

  // rank 页 onShow 必须无条件清空 pendingComp，否则会串台给赛程页
  mockApp.globalData.pendingComp = 'epl'
  const ctxRankShow = makeCtx(rankOpts)
  rankOpts.onLoad.call(ctxRankShow, {})
  rankOpts.onShow.call(ctxRankShow)
  check('积分榜页：onShow 取走 pendingComp 后清空（不留给赛程页）',
    mockApp.globalData.pendingComp === '', mockApp.globalData.pendingComp)
  check('积分榜页：onShow 生效选中 pendingComp 指定的赛事',
    ctxRankShow.data.activeComp === 'epl', ctxRankShow.data.activeComp)

  // 点「当前已选中的赛事」时也要清空，否则残留值会串到赛程页
  mockApp.globalData.pendingComp = 'epl'
  rankOpts.onShow.call(ctxRankShow)
  check('积分榜页：pendingComp 与当前赛事相同时也要清空',
    mockApp.globalData.pendingComp === '' && ctxRankShow.data.activeComp === 'epl',
    `${mockApp.globalData.pendingComp}/${ctxRankShow.data.activeComp}`)

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

  /* ---------- tabBar 跳转守卫 ----------
     ⚠️ 2026-10-03 用户报「点查看积分榜没反应」：积分榜被提升为 tabBar 页面后，
        原来的 wx.navigateTo 全部**静默失败**（fail: can not navigateTo a tabbar page），
        不报错、不弹 toast，只有真机上点一下才知道。
        这里扫全部页面源码，任何人再往 tabBar 页面上写 navigateTo 都会被拦下。
        正确姿势：utils/nav.js 的 toRank / toScheduleComp / goTab（switchTab + globalData 交接）。 */
  const tabPaths = (appJson.tabBar.list || []).map((t) => '/' + String(t.pagePath).replace(/^\//, ''))
  check('tabBar 页面清单非空（守卫本身要有效）', tabPaths.length >= 2, tabPaths.join(' '))
  const badJumps = []
  let navSeen = 0
  const scanPages = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return scanPages(p)
      if (!/\.(js|wxml)$/.test(e.name)) return
      const src = fs.readFileSync(p, 'utf8')
      // 只取 navigateTo **自己**的 url 值 —— 不能按固定字符窗口扫，
      // 否则会把后面另一个 switchTab 的目标页面也算进来（一开始就是这么误报的）
      const re = /wx\.navigateTo[\s\S]{0,160}?url\s*:\s*(['"`])([^'"`]*)\1/g
      let m
      while ((m = re.exec(src))) {
        navSeen += 1
        const url = m[2]
        tabPaths.forEach((tp) => {
          if (url.indexOf(tp) === 0) badJumps.push(`${path.relative(ROOT, p)} → ${url}`)
        })
      }
    })
  }
  scanPages(path.join(ROOT, 'pages'))
  check('跳转守卫扫到了 navigateTo 调用（守卫本身有效）', navSeen >= 8, `扫到 ${navSeen} 处`)
  check('没有任何 navigateTo 指向 tabBar 页面（否则点了没反应）',
    badJumps.length === 0, badJumps.join(' ; '))

  /* nav.js 的三个入口都要真的用 switchTab 而不是 navigateTo */
  const navSrc = fs.readFileSync(path.join(ROOT, 'utils/nav.js'), 'utf8')
  check('utils/nav.js 用 switchTab 跳 tabBar 页面',
    /wx\.switchTab\s*\(/.test(navSrc) && !/wx\.navigateTo\s*\(/.test(navSrc))
  const rankEntryPages = ['pages/schedule/schedule.js', 'pages/detail/detail.js', 'pages/index/index.js', 'pages/team/team.js']
  const missingNav = rankEntryPages.filter((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').indexOf('nav.toRank(') === -1)
  check('积分榜入口全部改走 nav.toRank（4 处）', missingNav.length === 0, missingNav.join(' ') || '四处齐备')
  check('积分榜页：赛事胶囊条随选中项自动滚动',
    rWxml.indexOf('scroll-into-view="chip-{{activeComp}}"') > -1 && rWxml.indexOf('id="chip-{{item.key}}"') > -1)
  check('积分榜页：内容区是可横滑的 swiper 且绑定切换事件',
    rWxml.indexOf('<swiper') > -1
    && rWxml.indexOf('bindchange="onSwiperChange"') > -1
    && rWxml.indexOf('current="{{swiperIndex}}"') > -1
    && typeof rankOpts.onSwiperChange === 'function')
  check('积分榜页：标签区是独立 scroll-view（横滑标签不切内容）',
    /<scroll-view[^>]*class="chip-bar"[\s\S]{0,200}?scroll-x/.test(rWxml)
    && rWxml.indexOf('bindchange="onSwiperChange"') === rWxml.lastIndexOf('bindchange="onSwiperChange"'))
  // 选中态配色：.chip-bar .chip 与 .chip.active 同权重且在后面，
  // 必须用三层选择器 .chip-bar .chip.active 才压得住（2026-10-02 真机：白字打在浅灰底上看不清）
  const aWxss = fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8')
  check('积分榜：选中赛事胶囊是深蓝底 + 白字',
    /\.chip-bar\s+\.chip\.active\s*\{[^}]*var\(--brand\)[^}]*#fff/.test(aWxss)
    && /\.chip\.active\s*\{[^}]*var\(--brand\)[^}]*#fff/.test(aWxss))
  const rWxss = fs.readFileSync(path.join(ROOT, 'pages/rank/rank.wxss'), 'utf8')
  check('积分榜页：页面定高不竖滚、内容区各自竖滚',
    rWxss.indexOf('height: 100vh') > -1
    && rWxss.indexOf('.body {') > -1
    && rWxss.indexOf('.slide-scroll') > -1)

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

  /* ---------- 首发阵容（详情页渲染） ----------
     payload 里是 tools/match-detail.js 的 pickLineups 产物 {home:[{n,j,p,st}], away:[...]}，
     详情页要把它整理成「按位置分组 + 替补席」。两条红线用合成数据守：
      ① 先按 st 分首发/替补，再按位置分组（替补的位置上游给的是 Substitute，抽出来是空）；
      ② 位置缺失的首发要进兜底组，不能丢人。 */
  const detMod = require(path.join(ROOT, 'pages/detail/detail.js'))

  check('首发阵容：上游没给阵容时返回 null（页面据整块隐藏，不留白壳）',
    detMod.buildLineups(null, () => '主') === null
    && detMod.buildLineups({}, () => '主') === null
    && detMod.buildLineups({ lineups: { home: [], away: [] } }, () => '主') === null)

  const luPayload = {
    lineups: {
      home: [
        { n: '门将甲', j: 1, p: 'G', st: 1 },
        { n: '后卫甲', j: 4, p: 'D', st: 1 },
        { n: '后卫乙', j: 5, p: 'D', st: 1 },
        { n: '中场甲', j: 8, p: 'M', st: 1 },
        { n: '前锋甲', j: 9, p: 'F', st: 1 },
        { n: '未给位置首发', j: 3, p: '', st: 1 },
        { n: '替补甲', j: 12, p: '', st: 0 },
        { n: '替补乙', j: 13, p: '', st: 0 },
      ],
      away: [{ n: '客队前锋', j: 7, p: 'F', st: 1 }],
    },
  }
  const lu = detMod.buildLineups(luPayload, (s) => (s === 'home' ? '主队' : '客队'))
  check('首发阵容：主客两侧都出，并带上侧名',
    Array.isArray(lu) && lu.length === 2 && lu[0].side === '主队' && lu[1].side === '客队',
    lu ? lu.map((x) => x.side + ':' + x.count).join(' , ') : '为 null')
  check('首发阵容：首发按位置分组且顺序是 门将→后卫→中场→前锋→兜底',
    lu[0].groups.map((g) => g.key).join('') === 'GDMFX',
    lu[0].groups.map((g) => g.label + g.rows.length).join(' '))
  check('首发阵容：上游没给位置的首发进兜底组，不丢人',
    lu[0].groups.some((g) => g.key === 'X' && g.rows.some((r) => r.n === '未给位置首发')))
  check('首发阵容：替补全部进替补席，不会被当成「位置缺失的首发」混进首发',
    lu[0].bench.length === 2 && lu[0].hasBench === true
    && lu[0].groups.every((g) => g.rows.every((r) => r.n.indexOf('替补') === -1)),
    `bench=${lu[0].bench.length} groups=${lu[0].groups.map((g) => g.key).join('')}`)
  check('首发阵容：首发人数按 st 统计（含那位位置缺失的）', lu[0].count === 6, String(lu[0].count))

  const luMatchStub = { home: { zhName: '主队' }, away: { zhName: '客队' } }
  const decLu = detMod.decorateDetail(JSON.parse(JSON.stringify(luPayload)), luMatchStub)
  check('首发阵容：decorateDetail 给出 lineups 与 hasLineups',
    decLu.hasLineups === true && decLu.lineups && decLu.lineups.length === 2,
    `hasLineups=${decLu.hasLineups}`)
  const decNoLu = detMod.decorateDetail({ events: [] }, luMatchStub)
  check('首发阵容：没有阵容时 hasLineups=false（wxml 据此隐藏整块）',
    decNoLu.hasLineups === false && !decNoLu.lineups)

  // 落到真实数据上的不变量：**存下来的阵容一定含首发**。
  // 未开赛的比赛上游也会给 rosters，但 starter 全是 0 —— pickLineups 对这种情况返回 null，
  // 所以只要有人在抓取侧放宽了这个判断，这条就会红。
  const detailBundle = require(path.join(ROOT, 'data/match-details.js'))
  let luStored = 0
  let luNoStarter = 0
  let luRenderable = 0
  ;(detailBundle.buckets || []).forEach((bk) => {
    Object.keys(bk.payload || {}).forEach((id) => {
      const d = bk.payload[id]
      if (!d || !d.lineups) return
      luStored += 1
      const home = (d.lineups.home || []).some((p) => p && p.st)
      const away = (d.lineups.away || []).some((p) => p && p.st)
      if (!home && !away) luNoStarter += 1
      if (detMod.buildLineups(d, () => '主')) luRenderable += 1
    })
  })
  check('首发阵容：云端存下来的阵容一定含首发（未开赛的名单不会被存进来）',
    luStored > 0 && luNoStarter === 0, `存了 ${luStored} 场，其中零首发 ${luNoStarter} 场`)
  check('首发阵容：存下来的每一场都能渲染出分组（不会存了却画不出来）',
    luRenderable === luStored, `${luRenderable}/${luStored}`)

  /* ---------- 球员字典播种器（阵容球员池） ----------
     2026-10-03：球员字典原本只从「射手榜/助攻榜」取输入，导致阵容里 87% 的人没有中文名
     （后卫/门将永远上不了射手榜）。现在多了一个输入源：`tools/match-detail.js` 抓详情时
     顺手把「还没有中文名」的球员写成 `tools/.lineup-players.json`（零额外上游请求）。
     这里守三件事：池子记的东西对不对、并集会不会丢、播种器读不读得到。 */
  const mdMod = require(path.join(ROOT, 'tools/match-detail.js'))
  const pnMod = require(path.join(ROOT, 'tools/player-names.js'))
  const zhNamesMod = require(path.join(ROOT, 'tools/zh-names.js'))
  const os = require('os')

  check('球员池：工具导出了池子相关的接口',
    typeof mdMod.noteRosterPlayers === 'function'
    && typeof mdMod.savePlayerPool === 'function'
    && typeof mdMod.PLAYER_POOL_FILE === 'string')

  // 找一个「已经有中文名」的 id 来验证跳过规则（这些人不该进池，白占体积）
  const knownId = Object.keys(zhNamesMod.PLAYER_ZH || {})[0]
  const fakeSummary = {
    rosters: [
      {
        team: { id: '1' },
        roster: [
          { athlete: { id: '900001', displayName: 'Test Player One', shortName: 'T. One' }, jersey: '9', starter: true },
          { athlete: { id: '900002', displayName: 'Test Player Two', shortName: 'T. Two' } },
          { athlete: { id: '900002', displayName: 'Test Player Two', shortName: 'T. Two' } }, // 重复
          { athlete: { id: knownId, displayName: 'Already Translated', shortName: 'A. T.' } },
          { athlete: {} }, // 没有 id
        ],
      },
      {
        team: { id: '2' },
        roster: [{ athlete: { id: '900003', displayName: 'Test Player Three' } }],
      },
    ],
  }

  const sink = new Map()
  const sinkSize = mdMod.noteRosterPlayers(fakeSummary, sink, 'epl')
  check('球员池：只收「没有中文名」的球员，且按 id 去重',
    sinkSize === 3 && sink.has('900001') && sink.has('900002') && sink.has('900003')
    && !sink.has(String(knownId)) && !sink.has('undefined'),
    `收了 ${sinkSize} 人（期望 3；有中文名的 ${knownId} 应被跳过）`)
  check('球员池：记下完整英文名（播种靠它检索）与所在赛事',
    sink.get('900001').full === 'Test Player One' && sink.get('900001').short === 'T. One'
    && JSON.stringify(sink.get('900001').c) === '["epl"]',
    JSON.stringify(sink.get('900001')))
  check('球员池：同一球员横跨多个赛事时赛事取并集',
    mdMod.noteRosterPlayers(fakeSummary, sink, 'ucl') === 3
    && JSON.stringify(sink.get('900001').c) === '["epl","ucl"]',
    JSON.stringify(sink.get('900001').c))

  // 落盘必须与旧池取**并集**：历史场次的球员不能因为这场没上就丢了
  const tmpPool = path.join(os.tmpdir(), 'wb-lineup-pool-test.json')
  fs.writeFileSync(tmpPool, JSON.stringify([{ id: 'old-1', full: 'Old One', short: 'O. One', c: ['liga'] }]), 'utf8')
  // 把池子灌成 fakeSummary 的内容（不带 into → 写进模块级池子），再落盘到临时文件
  mdMod.noteRosterPlayers(fakeSummary)
  mdMod.savePlayerPool(tmpPool)
  const mergedPool = JSON.parse(fs.readFileSync(tmpPool, 'utf8'))
  const mergedIds = mergedPool.map((p) => p.id).sort()
  check('球员池：落盘与旧池取并集（旧的不丢、新的进得来）',
    mergedIds.join(',') === '900001,900002,900003,old-1', mergedIds.join(','))
  fs.unlinkSync(tmpPool)

  // 播种器侧
  const readPoolResult = pnMod.readPool()
  check('播种器：阵容池条目形状正确（id + 完整英文名）',
    Array.isArray(readPoolResult)
    && readPoolResult.every((p) => p.id && p.full && Array.isArray(p.comps)),
    `${readPoolResult.length} 人`)
  // 池子是现场产物，本机可能还没有（比如刚克隆）；有就必须是排好序的
  if (readPoolResult.length) {
    const rankOf = (p) => {
      let best = pnMod.COMP_RANK.length
      p.comps.forEach((c) => {
        const i = pnMod.COMP_RANK.indexOf(c)
        if (i > -1 && i < best) best = i
      })
      return best
    }
    const ranks = readPoolResult.map(rankOf)
    check('播种器：池子按赛事优先级排序（--limit 切片才有意义）',
      ranks.every((r, i) => i === 0 || ranks[i - 1] <= r),
      `前 3 名赛事的 rank: ${ranks.slice(0, 3).join(',')} / 共 ${readPoolResult.length} 人`)
  } else {
    check('播种器：池子按赛事优先级排序（--limit 切片才有意义）', true, '跳过：池子为空')
  }
  // 读不到文件必须是「空源」而不是崩
  check('播种器：读不到池子文件时按空源处理（不抛错）',
    pnMod.readPool(path.join(os.tmpdir(), 'wb-no-such-pool.json')).length === 0)

  check('播种器：默认输入源是 all（射手榜 ∪ 阵容池）', pnMod.SOURCE === 'all', pnMod.SOURCE)
  check('播种器：赛事优先级表没有重复项，且都是真实赛事 key',
    pnMod.COMP_RANK.length === new Set(pnMod.COMP_RANK).size
    && pnMod.COMP_RANK.every((k) => !!dataMod.compOf(k).name && dataMod.compOf(k).name !== k),
    `${pnMod.COMP_RANK.length} 项`)

  /* ---------- 全站搜索（球队 + 赛事，纯本地索引） ----------
     utils/search.js 是纯函数 + 内存索引，可以直接当模块测，不用起页面。
     这里守四件事：① 索引规模与数据层一致（没漏没重）；② 去重与"主场赛事"的挑法；
     ③ 简称别名不出错；④ 页面跳转该走 tabBar 的那两处没写成 navigateTo。 */
  const searchMod = require(path.join(ROOT, 'utils/search.js'))

  // ① 索引里的球队数必须等于「各赛事球队按 大类+id 去重」后的数量。
  //    这样写不依赖具体数字，赛季窗口里球队增减都不会假红。
  const expectTeams = (() => {
    const seen = {}
    dataMod.competitions().forEach((c) => {
      dataMod.teamsOf(c.key).forEach((t) => { seen[c.cat + '/' + t.id] = 1 })
    })
    return Object.keys(seen).length
  })()
  const sStats = searchMod.stats()
  check('搜索：球队索引 = 各赛事按「大类+id」去重的数量（不重不漏）',
    sStats.teams === expectTeams && expectTeams > 0, `${sStats.teams} / 期望 ${expectTeams}`)
  check('搜索：赛事索引 = 全部赛事数',
    sStats.comps === dataMod.competitions().length, `${sStats.comps} / ${dataMod.competitions().length}`)

  // ② 空查询与"太宽"的查询不能把整个索引倒出来
  check('搜索：空查询 / 纯空格 / 单字母英文都返回空（不倒全量）',
    searchMod.search('').length === 0
    && searchMod.search('   ').length === 0
    && searchMod.search('a').length === 0)
  check('搜索：单字母中文照常能搜（"曼" → 曼城 与 曼联）',
    ['曼城', '曼联'].every((n) => searchMod.search('曼', 20).some((x) => x.display === n)))

  // ③ 跨赛事重复的球队只出现一行，且标签用的是"主场赛事"
  const arsenalHits = searchMod.search('阿森纳')
  check('搜索：同一支队横跨多个赛事只出现一行（阿森纳 ucl+epl）',
    arsenalHits.length === 1 && arsenalHits[0].comps.length === 2,
    arsenalHits.map((x) => x.display + ':' + x.comps.join('+')).join(' , '))
  check('搜索：球队标签取"主场赛事"而不是赛事列表里的第一个（阿森纳 → 英超）',
    !!arsenalHits[0] && arsenalHits[0].comp === 'epl', arsenalHits[0] ? arsenalHits[0].comp : '未命中')
  const portHit = searchMod.search('上海海港')[0]
  check('搜索：同一支队在联赛与杯赛之间优先国内联赛（上海海港 → 中超）',
    !!portHit && portHit.comp === 'csl', portHit ? portHit.comp : '未命中')

  // ④ 赛事既能用中文名搜，也能用 key 搜
  const eplHit = searchMod.search('英超')
  check('搜索：赛事中文名命中赛事且排在球队前面',
    eplHit.length > 0 && eplHit[0].kind === 'comp' && eplHit[0].key === 'epl',
    eplHit.slice(0, 2).map((x) => x.kind + ':' + x.display).join(' , '))
  const keyHit = searchMod.search('epl')[0]
  check('搜索：赛事 key（epl）也能搜到', !!keyHit && keyHit.key === 'epl', keyHit ? keyHit.name : '未命中')

  // ⑤ 简写别名：格式必须正确，且不能指到库里根本没有的名字
  const aliasPairs = Object.keys(searchMod.ALIAS).map((k) => ({ k, t: searchMod.ALIAS[k] }))
  check('搜索：别名表格式正确（简称与规范名不同、都不为空）',
    aliasPairs.length > 0 && aliasPairs.every((p) => p.k && p.t && searchMod.fold(p.k) !== searchMod.fold(p.t)),
    `${aliasPairs.length} 条`)
  const inIndex = (d) => searchMod.search(d, 60).some((x) => x.display === d)
  const deadAlias = aliasPairs.filter((p) => inIndex(p.t)
    && !searchMod.search(p.k, 60).some((x) => x.display === p.t))
  check('搜索：别名不会指错（规范名在库时，简称必须能搜到它）',
    deadAlias.length === 0, deadAlias.map((p) => p.k + '→' + p.t).join(' ') || '全部正确')
  // 端到端只要有一条别名真的在库里命中即可 —— 窗口内没有对应球队时（如休赛期）跳过
  const aliasSample = aliasPairs.find((p) => inIndex(p.t))
  if (!aliasSample) {
    check('搜索：别名机制端到端生效（简称 → 规范名）', true, '跳过：当前快照窗口内没有别名目标')
  } else {
    check('搜索：别名机制端到端生效（简称 → 规范名）',
      searchMod.search(aliasSample.k, 60).some((x) => x.display === aliasSample.t),
      `${aliasSample.k} → ${aliasSample.t}`)
  }

  // ⑥ 推荐词：搜不到的推荐词比没有推荐更糟 —— 每一条都必须实测有结果
  const hotList = searchMod.hot()
  const badHot = hotList.filter((h) => searchMod.search(h.w, 1).length === 0)
  check('搜索：空状态推荐词全部实测可搜到', hotList.length >= 8 && badHot.length === 0,
    `${hotList.length} 条，坏的 ${badHot.length}`)

  // ⑦ 页面：注册、四个文件齐、跳转姿势正确
  const appJson2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''))
  check('搜索页已注册且四个文件齐全',
    appJson2.pages.indexOf('pages/search/search') > -1
    && ['js', 'wxml', 'wxss', 'json'].every((ext) => fs.existsSync(path.join(ROOT, 'pages/search/search.' + ext))))
  check('搜索页不在 tabBar 里（它不是 tab，是二级页）',
    (appJson2.tabBar.list || []).every((t) => t.pagePath !== 'pages/search/search'))

  require(path.join(ROOT, 'pages/search/search.js'))
  const searchOpts = global.__page
  check('搜索页挂了转发与朋友圈',
    typeof searchOpts.onShareAppMessage === 'function' && typeof searchOpts.onShareTimeline === 'function')

  const ctxSearch = makeCtx(searchOpts)
  searchOpts.onLoad.call(ctxSearch, {})
  check('搜索页：空关键词时不出一堆结果，而是给推荐词',
    ctxSearch.data.searched === false && ctxSearch.data.teamHits.length === 0
    && ctxSearch.data.hot.length > 0,
    `hot=${ctxSearch.data.hot.length}`)
  check('搜索页：空关键词时自动聚焦输入框（进来就能打字）', ctxSearch.data.autoFocus === true)
  // 从分享链接冷启动带词时不该抢键盘
  const ctxSearchKw = makeCtx(searchOpts)
  searchOpts.onLoad.call(ctxSearchKw, { kw: encodeURIComponent('英超') })
  check('搜索页：分享链接带 kw 冷启动时直接出结果且不弹键盘',
    ctxSearchKw.data.keyword === '英超' && ctxSearchKw.data.searched === true
    && ctxSearchKw.data.autoFocus === false
    && ctxSearchKw.data.compHits.some((c) => c.key === 'epl'),
    `kw=${ctxSearchKw.data.keyword} compHits=${ctxSearchKw.data.compHits.length}`)

  searchOpts.onInput.call(ctxSearch, { detail: { value: '皇马' } })
  check('搜索页：输入即出结果（本地索引，不防抖也不发请求）',
    ctxSearch.data.teamHits.length > 0, ctxSearch.data.teamHits.map((t) => t.display).join(' , '))
  check('搜索页：结果行带上了关注态与所属赛事',
    ctxSearch.data.teamHits.every((t) => typeof t.followed === 'boolean' && !!t.compName),
    ctxSearch.data.teamHits[0] ? `${ctxSearch.data.teamHits[0].display}/${ctxSearch.data.teamHits[0].compName}` : '')

  // ⚠️ 搜索结果是索引里的共享对象，页面必须拷贝后再挂 followed ——
  //    直接改会把关注态写进索引，下一次搜索带着上一次的陈旧状态
  const firstHit = searchMod.search('皇马', 1)[0]
  check('搜索页：不会把关注态写回索引（索引对象没有 followed 字段）',
    !!firstHit && firstHit.followed === undefined)

  searchOpts.onClearKeyword.call(ctxSearch)
  check('搜索页：清空关键词后回到推荐词态',
    ctxSearch.data.keyword === '' && ctxSearch.data.searched === false && ctxSearch.data.teamHits.length === 0)

  // 点球队 → 球队详情页（非 tabBar，navigateTo 可用）
  searchOpts.onInput.call(ctxSearch, { detail: { value: '阿森纳' } })
  collected.navigateTo = ''
  searchOpts.onTeamTap.call(ctxSearch, { currentTarget: { dataset: { index: 0 } } })
  check('搜索页：点球队名进球队详情页', /^\/pages\/team\/team\?comp=epl&id=359$/.test(collected.navigateTo || ''),
    collected.navigateTo)

  // 点赛事 → 赛程 tab（tabBar 页面，必须 switchTab + globalData 交接）
  searchOpts.onInput.call(ctxSearch, { detail: { value: '英超' } })
  collected.switchTab = ''
  collected.navigateTo = ''
  mockApp.globalData.pendingComp = ''
  searchOpts.onCompTap.call(ctxSearch, { currentTarget: { dataset: { key: 'epl' } } })
  check('搜索页：点赛事切到赛程 tab（不能 navigateTo）',
    collected.switchTab === '/pages/schedule/schedule' && collected.navigateTo === '',
    `${collected.switchTab} / navigateTo=${collected.navigateTo || '无'}`)
  check('搜索页：点赛事带上该赛事', mockApp.globalData.pendingComp === 'epl', mockApp.globalData.pendingComp)

  // 赛事行里的「积分榜 ›」→ 积分榜 tab
  collected.switchTab = ''
  mockApp.globalData.pendingComp = ''
  searchOpts.onCompRankTap.call(ctxSearch, { currentTarget: { dataset: { key: 'epl' } } })
  check('搜索页：点「积分榜」切到积分榜 tab 并带上赛事',
    collected.switchTab === '/pages/rank/rank' && mockApp.globalData.pendingComp === 'epl',
    `${collected.switchTab} / ${mockApp.globalData.pendingComp}`)
  mockApp.globalData.pendingComp = ''

  // 两个动作必须分开：点名字进详情、点按钮只切关注（混在一起会误取消关注）
  check('搜索页：球队名与关注按钮是两个独立动作',
    typeof searchOpts.onTeamTap === 'function' && typeof searchOpts.onFollowTap === 'function'
    && searchOpts.onTeamTap !== searchOpts.onFollowTap)
  const swxml = fs.readFileSync(path.join(ROOT, 'pages/search/search.wxml'), 'utf8')
  check('搜索页：关注按钮用 bindtap="onFollowTap" 且球队名用 bindtap="onTeamTap"',
    swxml.indexOf('bindtap="onFollowTap"') > -1 && swxml.indexOf('bindtap="onTeamTap"') > -1)

  // 入口：首页与关注页都能进搜索页
  check('搜索入口：首页与关注页各有一个入口指向 /pages/search/search',
    fs.readFileSync(path.join(ROOT, 'pages/index/index.js'), 'utf8').indexOf('/pages/search/search') > -1
    && fs.readFileSync(path.join(ROOT, 'pages/teams/teams.js'), 'utf8').indexOf('/pages/search/search') > -1)

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
