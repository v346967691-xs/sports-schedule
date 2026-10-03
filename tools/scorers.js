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

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const available = []
  const tables = {}
  const failed = []
  let totalPlayers = 0

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
    tables[k].players.forEach((p) => {
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
