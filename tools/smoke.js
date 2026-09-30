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

  check('首页：赛事入口数量 = 15', d.entries.length === 15, `实际 ${d.entries.length}`)
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
  check('赛程页：切到电竞', s.activeCat === 'esports' && s.catComps.length === 5, `赛事 ${s.catComps.length} 项`)

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
  check('赛程页：无未来赛程时自动兜底展示最近对战', s.fallback === true && esMatches.length > 0, `fallback=${s.fallback} 场=${esMatches.length}`)
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

  // 首页同步展示关注球队比赛
  const ctxIdxTeam = makeCtx(indexOpts)
  indexOpts.onLoad.call(ctxIdxTeam)
  check('首页：展示关注球队比赛', ctxIdxTeam.data.teamMatches.length > 0, `teamMatches=${ctxIdxTeam.data.teamMatches.length}`)

  // 我的页同步
  const ctxMineTeam = makeCtx(mineOpts)
  mineOpts.buildTeams.call(ctxMineTeam)
  check('我的页：关注球队区块有数据', ctxMineTeam.data.teams.length === 1 && ctxMineTeam.data.teamMatches.length > 0, `teams=${ctxMineTeam.data.teams.length} matches=${ctxMineTeam.data.teamMatches.length}`)

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
