/**
 * 射手榜 / 助攻榜抓取
 * ============================================================
 * 用法： node tools/scorers.js          抓取并写入 data/scorers.js
 *
 * 数据源：`site.api.espn.com/apis/site/v2/sports/soccer/{slug}/statistics`
 *   → `stats[]` 里 `name==='goalsLeaders'` / `'assistsLeaders'`，各 50 人。
 *
 * ⚠️ 探测结论（2026-10-03 实测，别重复试）：
 *   ❌ 足球与 NBA 都没有 `/leaders` 端点（404），只有上面这个 `statistics` 这条路；
 *   ❌ 欧协联 / 亚洲杯 / U17 男足 / U17 女足**没有**这两个榜（上游不提供）；
 *   ❌ 中国国字号是「多来源筛出来的」，没有单一联赛，自然也没有榜；
 *   ❌ 球员中文名上游完全没有，靠 tools/zh-names.js 的 PLAYER_ZH 按 id 映射，
 *      未命中回落英文短名（中英混排是预期内的）。
 *
 * 输出形状：`{ generatedAt, season, players: { 运动员 id: [...] }, tables: { comp: { goals, assists } } }`
 *   每个赛事**只存一份球员列表**（goalsLeaders ∪ assistsLeaders），
 *   射手榜/助攻榜只是在页面端按 `g` / `a` 重新排序取前 N —— 无损且省一半体积。
 *
 * ⚠️ 任何失败都返回空表，绝不抛错：射手榜是增强内容，不能拖垮赛程主链路。
 *    （与 tools/standings.js 同一约定。）
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const OUT_FILE = path.join(ROOT, 'data', 'scorers.js')

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports'

const zhNames = require('./zh-names')

/* ------------------------------------------------------------------ 工具 */

function log(...args) {
  console.log('[scorers]', ...args)
}

async function getJSON(url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      if (attempt === 2) return null
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)))
    }
  }
  return null
}

/**
 * 目标赛事：**只有上游真的有榜的**。
 * 漏一个不会报错，只会让那个赛事在页面上少两档；多一个不会报错，但会多一次白拉的请求。
 * 加赛事前先 `curl .../soccer/{slug}/statistics` 看有没有 goalsLeaders。
 */
const TARGETS = [
  { key: 'ucl', name: '欧冠', espn: 'uefa.champions' },
  { key: 'epl', name: '英超', espn: 'eng.1' },
  { key: 'liga', name: '西甲', espn: 'esp.1' },
  { key: 'seriea', name: '意甲', espn: 'ita.1' },
  { key: 'bundesliga', name: '德甲', espn: 'ger.1' },
  { key: 'ligue1', name: '法甲', espn: 'fra.1' },
  { key: 'nations', name: '欧国联', espn: 'uefa.nations' },
  { key: 'uel', name: '欧联', espn: 'uefa.europa' },
  { key: 'csl', name: '中超', espn: 'chn.1' },
  { key: 'acl', name: '亚冠精英', espn: 'afc.champions' },
  { key: 'acl2', name: '亚冠二级', espn: 'afc.cup' },
  { key: 'wucl', name: '女足欧冠', espn: 'uefa.wchampions' },
  { key: 'mls', name: '美职联', espn: 'usa.1' },
  { key: 'lib', name: '解放者杯', espn: 'conmebol.libertadores' },
  { key: 'cnl', name: '北美国联', espn: 'concacaf.nations.league' },
  // ⚠️ 国际友谊赛上游**有**榜，但故意不接：友谊赛进球毫无参考价值，
  //    和「故意不抓友谊赛详情」同一个理由（见 match-detail.js）。别再"顺手补上"。
]

/* ------------------------------------------------------------ 解析 */

/** 从 athlete.statistics 里取数值字段（结构在三个联赛间实测一致） */
function statOf(athlete, name) {
  const hit = (athlete.statistics || []).find((s) => s.name === name)
  if (!hit) return null
  const v = hit.value != null ? hit.value : Number(hit.displayValue)
  return Number.isFinite(v) ? v : null
}

/**
 * 把一条 leader 压成页面直接可用的行。
 * ⚠️ 字段名故意用单字母：这个文件进代码包，525 个球员 × 3 个字段省下来的就是几十 KB。
 *    （与 utils/snapshot.js 的快照字典化同一思路。）
 */
function rowOf(l, players) {
  const a = l.athlete || {}
  const t = a.team || {}
  const id = String(a.id || '')
  if (!id) return null
  const rec = {
    i: id,
    // 英文短名：形如 "E. Haaland"，比全名窄，窄屏够用
    s: String(a.shortName || a.displayName || ''),
    t: String(t.id || ''),
    // 中文队名与赛程页同源（ESPN team id 空间一致），复用现成字典。
    // ⚠️ 必须带名字兜底：`espnZh` 只按 id 查 ESPN_ZH，而亚冠那批俱乐部
    //    （Al Ain / Esteghlal / Kashima Antlers…）只在按**名字**索引的 CLUB_ZH 里。
    //    少了这一级，界面上就会冒出 "7115" 这种裸数字 id —— 比英文名还糟。
    //    与 sync.js 的 normTeam 同一套四级兜底口径。
    tz: zhNames.espnZh(t.id) || zhNames.nameZh(t.displayName || t.shortDisplayName || t.name || '') || '',
    z: zhNames.playerZh(id) || '',
    j: a.jersey != null && Number.isFinite(Number(a.jersey)) ? Number(a.jersey) : 0,
    p: statOf(a, 'appearances'),
    g: statOf(a, 'totalGoals'),
    a: statOf(a, 'goalAssists'),
  }
  // 进球/助攻上游一定有；场次缺了就不显示，不留 0 假装有数据
  if (rec.g == null && rec.a == null) return null
  players.push(rec)
  return rec
}

/** 一个赛事的两个榜合并成一份球员列表 */
function buildTable(json) {
  const stats = (json && json.stats) || []
  const goals = stats.find((s) => s.name === 'goalsLeaders')
  const assists = stats.find((s) => s.name === 'assistsLeaders')
  if (!goals && !assists) return null

  const players = []
  const seen = {}
  const add = (leaders) => {
    ;(leaders || []).forEach((l) => {
      const rec = rowOf(l, [])
      if (!rec || seen[rec.i]) return
      seen[rec.i] = true
      players.push(rec)
    })
  }
  add(goals && goals.leaders)
  add(assists && assists.leaders)
  if (!players.length) return null

  return {
    season: (json.season && (json.season.displayName || json.season.year)) || '',
    players,
  }
}

/* ------------------------------------------------ 篮球赛季数据榜（NBA） ------------------------------------------------
 *
 * 端点：`site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete`
 *   · `season=YYYY&seasontype=2` = 常规赛。**当年份没开打时返回 0 人**（2026-10 实测
 *     season=2027 还是季前赛，0 人）→ 回落到上一个赛季，并把赛季标签一起存下来，
 *     ⚠️ 别让「上赛季数据」冒充本赛季（页面上会写清楚赛季）。
 *   · **排序交给上游**，`sort=` 传不同的统计项：
 *       offensive.avgPoints / general.avgRebounds / offensive.avgAssists
 *       defensive.avgSteals / defensive.avgBlocks
 *     🔴 绝不自己按数值重排 —— 「只拉官方榜」是红线。
 *   · 一个榜一次请求（5 个榜 = 5 次），所以**必须带 6 小时闸门**，
 *     否则跟着 15 分钟一班跑，一天就打 480 次上游（赛季场均变化很慢，6 小时够了）。
 *
 * ❌ 探测结论（2026-10-06，别再试）：
 *   · `/leaders`、`core ... /leaders`、`core ... /byathlete` 对篮球**全是 404**；
 *   · `sort=general.avgAssists` / `general.assists` 是 400 —— 助攻在 **offensive** 分类里；
 *   · KPL 官方没有战队排名（`getTeamRank` / `getRankList` / `getDataRank` 全 404）。
 */
const WEB_ESPN = 'https://site.web.api.espn.com/apis/common/v3/sports'
const LEADERS_TTL_MS = 6 * 3600 * 1000
const BASKET_SEASON_TYPE = 2

const LEADER_BOARDS = [
  { key: 'points', name: '得分榜', sort: 'offensive.avgPoints', cat: 'offensive', stat: 'avgPoints' },
  { key: 'rebounds', name: '篮板榜', sort: 'general.avgRebounds', cat: 'general', stat: 'avgRebounds' },
  { key: 'assists', name: '助攻榜', sort: 'offensive.avgAssists', cat: 'offensive', stat: 'avgAssists' },
  { key: 'steals', name: '抢断榜', sort: 'defensive.avgSteals', cat: 'defensive', stat: 'avgSteals' },
  { key: 'blocks', name: '盖帽榜', sort: 'defensive.avgBlocks', cat: 'defensive', stat: 'avgBlocks' },
]

/**
 * 从 athlete.categories[] 里按「分类 + 统计项名」取值。
 *
 * 🔴 字段名**只在响应顶层的 `categories[]` 里**（`{name:'offensive', names:['avgPoints',…]}`），
 *    每个运动员那一层只有 `values` 数组、没有字段名（2026-10-06 踩到：按运动员的
 *    `names` 去取恒为空，五个榜全空）。所以先把「分类 → 字段名下标」这张表算出来，
 *    再按位置取值。
 */
function statIndexMap(json) {
  const map = {}
  ;(json.categories || []).forEach((c) => {
    map[c.name] = c.names || []
  })
  return map
}

function statValue(a, names, cat, stat) {
  const c = (a.categories || []).find((x) => x.name === cat)
  const idx = (names[cat] || []).indexOf(stat)
  if (!c || idx < 0) return null
  const v = Number((c.values || [])[idx])
  return Number.isFinite(v) ? v : null
}

async function fetchLeaderBoard(league, year, board, limit) {
  const url = `${WEB_ESPN}/basketball/${league}/statistics/byathlete`
    + `?region=us&lang=en&contentorigin=espn&season=${year}&seasontype=${BASKET_SEASON_TYPE}`
    + `&limit=${limit}&sort=${encodeURIComponent(board.sort)}`
  const json = await getJSON(url)
  if (!json) return null
  const names = statIndexMap(json)
  const rows = []
  ;(json.athletes || []).forEach((a, i) => {
    const ath = a.athlete || {}
    const id = String(ath.id || '')
    if (!id) return
    const v = statValue(a, names, board.cat, board.stat)
    if (v == null) return
    rows.push({
      pos: i + 1,
      i: id,
      n: ath.displayName || ath.shortName || '',
      s: ath.shortName || '',
      z: zhNames.playerZh(id) || '',
      v,
    })
  })
  if (!rows.length) return null
  return {
    key: board.key,
    name: board.name,
    season: (json.requestedSeason && (json.requestedSeason.displayName || json.requestedSeason.year)) || String(year),
    rows,
  }
}

/**
 * 抓一个篮球赛事的赛季数据榜。
 * ⚠️ 当年份的常规赛还没开始（0 人）就回落上一个赛季，并把真实赛季标签带出去。
 */
async function fetchBasketLeaders(league, thisYear, limit) {
  for (const year of [thisYear, thisYear - 1, thisYear - 2]) {
    const boards = []
    for (const b of LEADER_BOARDS) {
      // eslint-disable-next-line no-await-in-loop
      const t = await fetchLeaderBoard(league, year, b, limit)
      if (t) boards.push(t)
    }
    if (boards.length) {
      return {
        kind: 'leaders',
        season: boards[0].season,
        boards,
      }
    }
  }
  return null
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const available = []
  const tables = {}
  const failed = []
  let totalPlayers = 0

  // 上一次的产物，用来给篮球数据榜做 6 小时闸门（读旧文件比重新打上游便宜太多）
  let prev = null
  try {
    // eslint-disable-next-line global-require
    prev = require(OUT_FILE)
  } catch (err) {
    prev = null
  }

  for (const t of TARGETS) {
    const url = `${ESPN}/soccer/${t.espn}/statistics`
    const json = await getJSON(url)
    const table = buildTable(json)
    if (!table) {
      failed.push(`${t.name}(${t.key})`)
      continue
    }
    tables[t.key] = table
    totalPlayers += table.players.length
    available.push(`${t.name} ${table.players.length}人`)
  }

  // 篮球赛季数据榜（目前只有 NBA；CBA 不是 ESPN 数据源，上游没有这类榜）
  const prevNba = prev && prev.tables ? prev.tables.nba : null
  const prevAge = prev && prev.generatedAt ? Date.now() - Date.parse(prev.generatedAt) : Infinity
  if (prevNba && prevNba.boards && prevNba.boards.length && Number.isFinite(prevAge) && prevAge < LEADERS_TTL_MS) {
    tables.nba = prevNba
    available.push(`NBA 数据榜 ${prevNba.boards.length} 榜（距上次 ${Math.round(prevAge / 60000)} 分钟，未重抓）`)
  } else {
    const nba = await fetchBasketLeaders('nba', new Date().getUTCFullYear() + 1, 20)
    if (nba && nba.boards.length) {
      tables.nba = nba
      available.push(`NBA 数据榜 ${nba.boards.length} 榜 / ${nba.season}`)
    } else {
      failed.push('NBA 数据榜')
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    tables,
  }
  const body = `/** 本文件由 node tools/scorers.js 生成，请勿手动修改 */\nmodule.exports = ${JSON.stringify(payload)}\n`
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  fs.writeFileSync(OUT_FILE, body)

  const sizeKB = Math.round(fs.statSync(OUT_FILE).size / 1024)
  console.log('')
  log('抓到的赛事：')
  available.forEach((s) => console.log(`  ${s}`))
  if (failed.length) log(`⚠ 没拿到榜的赛事：${failed.join('、')}`)
  console.log('')
  log(`写入 data/scorers.js：${Object.keys(tables).length} 个赛事 / ${totalPlayers} 名球员 / ${sizeKB} KB`)

  // 列出缺中文名的球员，方便往 PLAYER_ZH 里补 —— 只列前 40 条，否则刷屏
  const missing = []
  const seenId = {}
  Object.keys(tables).forEach((k) => {
    // ⚠️ 篮球那张是 kind='leaders'（boards 数组），没有 players 字段
    (tables[k].players || []).forEach((p) => {
      if (p.z || seenId[p.i]) return
      seenId[p.i] = true
      missing.push({ id: p.i, s: p.s, tz: p.tz, g: p.g })
    })
  })
  missing.sort((a, b) => (b.g || 0) - (a.g || 0))
  console.log('')
  log(`没有中文名的球员 ${missing.length} 人（按进球排序，补到 tools/zh-names.js 的 PLAYER_ZH）：`)
  missing.slice(0, 40).forEach((m) => console.log(`      '${m.id}': '',   // ${m.s} · ${m.tz} · ${m.g || 0} 球`))
  if (missing.length > 40) console.log(`      …还有 ${missing.length - 40} 人`)
  console.log('')
}

main().catch((err) => {
  console.error('[scorers] 未预期错误：', err && err.stack ? err.stack : err)
  process.exit(1)
})
