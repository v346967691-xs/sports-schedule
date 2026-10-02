/**
 * 积分榜 / 排名抓取
 * ============================================================
 * 用法： node tools/standings.js            抓取并写入 data/standings.js
 *
 * 为什么单独一个文件：
 *   sync.js 一 require 就会执行底部的 main()，没法被别处复用；
 *   积分榜又是独立于赛程的另一份数据流，混在一起会让两边都难改。
 *
 * 数据来源分三类（2026-10-02 实测）：
 *   ① ESPN 官方积分榜 —— 10 个赛事全通，team.id 与 scoreboard 同源，
 *      所以 tools/zh-names.js 里现成的中文映射可以直接复用，零汉化成本。
 *   ② CBA / KPL —— 官方接口**没有**排名端点（候选路径全 404），
 *      改为把整赛季赛果拉下来自己算胜负（两者一次请求就返回整赛季）。
 *   ③ 杯赛（全球总决赛 / 季中赛 / 德玛西亚杯 / 亚运会）与国字号 —— 本来就没有积分榜，不做。
 *
 * ⚠️ 任何失败都返回空表，绝不抛错：积分榜是增强功能，不能拖垮赛程主链路。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const OUT_FILE = path.join(ROOT, 'data', 'standings.js')

const ESPN_V2 = 'https://site.api.espn.com/apis/v2/sports'
const CBA = 'https://portal-server.cbaleague.com'
const KPL = 'https://kplshop-op.timi-esports.qq.com/kplow'

const zhNames = require('./zh-names')

/* ------------------------------------------------------------------ 工具 */

function log(...args) {
  console.log('[standings]', ...args)
}

async function getJSON(url, headers) {
  const opts = Object.assign({ headers: Object.assign({ 'User-Agent': 'Mozilla/5.0' }, headers || {}) }, {})
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      const res = await fetch(url, Object.assign({ signal: controller.signal }, opts))
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

async function postJSON(url, body) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: controller.signal,
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

/** 按 ESPN stats 数组里的 name 取值（找不到返回 null） */
function pick(stats, ...names) {
  for (const n of names) {
    const hit = (stats || []).find((s) => s.name === n)
    if (hit) {
      const v = hit.value != null ? hit.value : Number(hit.displayValue)
      if (Number.isFinite(v)) return v
    }
  }
  return null
}

function pickText(stats, ...names) {
  for (const n of names) {
    const hit = (stats || []).find((s) => s.name === n)
    if (hit && hit.displayValue != null && String(hit.displayValue).trim() !== '') {
      return String(hit.displayValue)
    }
  }
  return ''
}

/* ------------------------------------------------------------------ ① ESPN 官方积分榜 */

/** ESPN 的分组名是英文，这里换成中文（东/西部分区、UEFA 国联小组等） */
const GROUP_ZH = [
  { test: /^eastern\s*conference$/i, zh: '东部联盟' },
  { test: /^western\s*conference$/i, zh: '西部联盟' },
  { test: /^eastern$/i, zh: '东部' },
  { test: /^western$/i, zh: '西部' },
]
function groupLabel(name) {
  const raw = String(name || '').trim()
  if (!raw) return ''
  for (const g of GROUP_ZH) if (g.test.test(raw)) return g.zh
  // uefa.nations 是 "Group A1" / "Group B2" 这种
  const m = raw.match(/^group\s+(.+)$/i)
  if (m) return `${m[1].trim()} 组`
  return raw
}

/**
 * 每个赛事的 ERP 表列定义。
 * 足球看积分，篮球没有「积分」概念所以看胜率 —— 这不是偷懒，是两类运动的真实差别。
 */
const COLUMNS = {
  football: [
    { key: 'played', label: '场' },
    { key: 'wins', label: '胜' },
    { key: 'draws', label: '平' },
    { key: 'losses', label: '负' },
    { key: 'scored', label: '进' },
    { key: 'conceded', label: '失' },
    { key: 'diff', label: '净' },
    { key: 'pts', label: '分', strong: true },
  ],
  basketball: [
    { key: 'wins', label: '胜' },
    { key: 'losses', label: '负' },
    { key: 'winPct', label: '胜率', strong: true },
    { key: 'ppg', label: '均得' },
    { key: 'oppg', label: '均失' },
    { key: 'streak', label: '连续' },
  ],
  esports: [
    { key: 'wins', label: '胜' },
    { key: 'losses', label: '负' },
    { key: 'winPct', label: '胜率', strong: true },
  ],
}

/** 欧战 / 降级分区（只对足球有意义）。越界自动不画。 */
function zonesFor(compKey, count) {
  if (count <= 12) return []
  if (compKey === 'epl') return [
    { from: 1, to: 5, label: '欧冠区', color: '#2F6F4E' },
    { from: 18, to: 20, label: '降级区', color: '#A93A3A' },
  ]
  if (compKey === 'liga' || compKey === 'seriea') return [
    { from: 1, to: 4, label: '欧冠区', color: '#2F6F4E' },
    { from: 18, to: 20, label: '降级区', color: '#A93A3A' },
  ]
  if (compKey === 'bundesliga' || compKey === 'ligue1') return [
    { from: 1, to: 4, label: '欧冠区', color: '#2F6F4E' },
    { from: count - 1, to: count, label: '降级区', color: '#A93A3A' },
  ]
  if (compKey === 'csl') return [
    { from: 1, to: 2, label: '亚冠区', color: '#2F6F4E' },
    { from: count - 1, to: count, label: '降级区', color: '#A93A3A' },
  ]
  return []
}

/** 从 ESPN standings entry 里抽出我们自己的行结构（足球 / 篮球字段不同） */
function espnRow(entry, cat, index) {
  const team = entry.team || {}
  const stats = entry.stats || []
  const id = String(team.id || index)
  const name = team.displayName || team.name || team.shortDisplayName || `队伍${index + 1}`
  const row = {
    id,
    name,
    zh: zhNames.espnZh(id) || '',
    abbr: (team.abbreviation || team.shortDisplayName || name).slice(0, 6),
    pos: pick(stats, 'rank', 'playoffSeed') || index + 1,
    played: pick(stats, 'gamesPlayed') || 0,
    wins: pick(stats, 'wins') || 0,
    losses: pick(stats, 'losses') || 0,
    draws: cat === 'football' ? (pick(stats, 'ties') || 0) : null,
    scored: pick(stats, 'pointsFor') || 0,
    conceded: pick(stats, 'pointsAgainst') || 0,
    diff: pick(stats, 'pointDifferential', 'differential') || 0,
    pts: null,
    winPct: cat === 'football' ? null : Number((pick(stats, 'winPercent') || 0).toFixed(3)),
    ppg: cat === 'basketball' ? Number((pick(stats, 'avgPointsFor') || 0).toFixed(1)) : null,
    oppg: cat === 'basketball' ? Number((pick(stats, 'avgPointsAgainst') || 0).toFixed(1)) : null,
    streak: cat === 'basketball' ? pickText(stats, 'streak') : '',
    pts: cat === 'football' ? pick(stats, 'points') : null,
    note: '',
  }
  if (Array.isArray(entry.note)) {
    row.note = entry.note.map((n) => n.description).filter(Boolean).join(' ')
  } else if (entry.note && entry.note.description) {
    row.note = entry.note.description
  }
  return row
}

/** 排序：足球按积分、其余按胜率，同分时依次比净胜球 / 进球 */
function sortRows(rows, cat) {
  return rows.sort((a, b) => {
    if (cat === 'football') {
      if (b.pts !== a.pts) return (b.pts || 0) - (a.pts || 0)
      if (b.diff !== a.diff) return (b.diff || 0) - (a.diff || 0)
      if (b.scored !== a.scored) return (b.scored || 0) - (a.scored || 0)
      return String(a.name).localeCompare(String(b.name))
    }
    if (b.winPct !== a.winPct) return (b.winPct || 0) - (a.winPct || 0)
    if (b.wins !== a.wins) return (b.wins || 0) - (a.wins || 0)
    return String(a.name).localeCompare(String(b.name))
  })
}

async function fetchEspnTable(comp) {
  const url = `${ESPN_V2}/${comp.sport}/${comp.espn}/standings`
  const json = await getJSON(url)
  if (!json || !Array.isArray(json.children) || !json.children.length) return null

  // children 有两种形态：足球是「赛季」（名字带年份），NBA 是「东/西部分区」（不带年份）。
  //   · 带年份 → 只取第一个（当前赛季），历史赛季不展示
  //   · 不带年份 → 全是分区，逐个当一组
  const kids = json.children
  const seasonKids = kids.filter((c) => /(19|20)\d{2}/.test(c.name || ''))
  const seasonPool = seasonKids.length ? [seasonKids[0]] : kids

  const groups = []
  for (const kid of seasonPool) {
    const st = (kid && kid.standings) || {}
    const kidGroups = Array.isArray(st.groups) && st.groups.length
      ? st.groups.map((g) => ({ name: groupLabel(g.groupName || ''), entries: g.entries || [] }))
      : [{
        name: seasonPool.length > 1 ? groupLabel(kid.name || '') : groupLabel(st.groupName || ''),
        entries: st.entries || [],
      }]
    kidGroups.forEach((g) => { if (g.entries.length) groups.push(g) })
  }
  if (!groups.length) return null

  const out = []
  for (const g of groups) {
    const rows = g.entries.map((e, i) => espnRow(e, comp.cat, i)).filter(Boolean)
    out.push({ name: g.name, rows: sortRows(rows, comp.cat) })
  }
  if (!out.length) return null

  return {
    comp: comp.key,
    season: (seasonPool[0] && seasonPool[0].name) || '',
    columns: COLUMNS[comp.cat] || COLUMNS.football,
    zones: [],
    groups: out,
  }
}

/* ------------------------------------------------------------------ ② CBA / KPL：没有官方排名，自己算 */

/**
 * 按已结束场次的比分算胜负表。
 *
 * ⚠️ 只能用「整赛季」的原始数据，不能用 data/matches.js —— 那份快照只有 ±窗口内的比赛，
 * 拿它算积分榜会严重失真（赛季才开始两周时会显示成 2 支球队并列第一）。
 */
function computeTable(rows, opt) {
  const teams = {}
  const ensure = (id, name) => {
    if (!teams[id]) {
      teams[id] = {
        id, name, zh: name, abbr: name.slice(0, 6),
        pos: 0, played: 0, wins: 0, losses: 0, draws: opt.draws ? 0 : null,
        scored: 0, conceded: 0, diff: 0, pts: opt.usePoints ? 0 : null,
        winPct: null, ppg: null, oppg: null, streak: '', note: '',
      }
    }
    return teams[id]
  }

  rows.forEach((r) => {
    if (!r.homeId || !r.awayId) return
    // 待定 / TBD 不是真球队
    if (String(r.homeId) === 'TBD' || String(r.awayId) === 'TBD') return
    if (r.homeScore == null || r.awayScore == null) return
    const h = ensure(String(r.homeId), r.homeName)
    const a = ensure(String(r.awayId), r.awayName)
    h.played += 1
    a.played += 1
    h.scored += r.homeScore
    h.conceded += r.awayScore
    a.scored += r.awayScore
    a.conceded += r.homeScore
    if (r.homeScore > r.awayScore) {
      h.wins += 1; a.losses += 1
      if (opt.usePoints) h.pts += 3
    } else if (r.homeScore < r.awayScore) {
      a.wins += 1; h.losses += 1
      if (opt.usePoints) a.pts += 3
    } else if (opt.draws) {
      h.draws += 1; a.draws += 1
      if (opt.usePoints) { h.pts += 1; a.pts += 1 }
    }
  })

  const list = Object.values(teams).map((t) => {
    t.diff = t.scored - t.conceded
    t.winPct = t.played ? Number((t.wins / t.played).toFixed(3)) : 0
    return t
  })
  const sorted = sortRows(list, opt.cat)
  sorted.forEach((t, i) => { t.pos = i + 1 })
  return sorted
}

/** CBA：一次返回整赛季 490 场，按已结束的场次算 */
async function fetchCbaTable(comp) {
  const json = await getJSON(`${CBA}/home/home_schedules`)
  const list = (json && Array.isArray(json.data) && json.data) || null
  if (!list) return null
  const rows = list.map((ev) => ({
    homeId: String(ev.HomeTeamID || ev.HomeTeamName || ''),
    homeName: ev.HomeTeamName || '',
    awayId: String(ev.VisitingTeamID || ev.VisitingTeamName || ''),
    awayName: ev.VisitingTeamName || '',
    homeScore: ev.HomeTeamScore != null ? Number(ev.HomeTeamScore) : null,
    awayScore: ev.VisitingTeamScore != null ? Number(ev.VisitingTeamScore) : null,
  }))
  const table = computeTable(rows, { cat: 'basketball', draws: false, usePoints: false })
  // ⚠️ 赛季还没开打时所有比分都是 null，此时算出来的「全队 0 胜」会误导，
  //    不如直接返回 null，让页面显示「赛季尚未开始」。
  if (table.length < 4 || !table.some((t) => t.played > 0)) return null
  return {
    comp: comp.key,
    season: '本赛季',
    columns: COLUMNS.basketball,
    zones: [],
    groups: [{ name: '', rows: table }],
  }
}

/** KPL：POST getScheduleList 返回当前赛季赛程，按已结束的场次算 */
async function fetchKplTable(comp) {
  const json = await postJSON(`${KPL}/getScheduleList`, { seasonid: '' })
  const list = (json && json.data && Array.isArray(json.data.list) && json.data.list) || null
  if (!list) return null

  const rows = []
  list.forEach((ev) => {
    // ⚠️ 未开赛的接口也返回 0-0，必须先用 schedule_status 判出「真打完了」，
    //    否则会把整份未来赛程当成 0:0 平局算进去，积分榜当场失真。
    // 官方语义取自官网前端（kpl.qq.com/static/Schedule-*.js）：
    //   1=未开始 2=已取消 3=进行中 4=已结束
    const state = Number(ev.schedule_status)
    const played = Number(ev.team_a_score || 0) + Number(ev.team_b_score || 0)
    // 只认 4（已结束）；上游滞后时靠比分兜底，但要排除 2（已取消）和 3（进行中——
    // BO5 打完第一局的 1:0 是中间局比分，算进去会让积分榜提前失真）
    const finished = state === 4 || (state !== 2 && state !== 3 && played > 0)
    if (!finished) return
    rows.push({
      homeId: String(ev.team_a_id || ev.team_a_name || ''),
      homeName: ev.team_a_name || '',
      awayId: String(ev.team_b_id || ev.team_b_name || ''),
      awayName: ev.team_b_name || '',
      homeScore: Number(ev.team_a_score || 0),
      awayScore: Number(ev.team_b_score || 0),
    })
  })
  if (rows.length < 4) return null
  const table = computeTable(rows, { cat: 'esports', draws: false, usePoints: false })
  if (table.length < 4) return null
  return {
    comp: comp.key,
    season: '本赛季',
    columns: COLUMNS.esports,
    zones: [],
    groups: [{ name: '', rows: table }],
  }
}

/* ------------------------------------------------------------------ 主流程 */

/**
 * 有积分榜的赛事。
 * 杯赛（worlds / msi / demacia / agames）和中国国字号（chn）天然没有积分榜，不列。
 */
const TARGETS = [
  { key: 'ucl', cat: 'football', sport: 'soccer', espn: 'uefa.champions' },
  { key: 'epl', cat: 'football', sport: 'soccer', espn: 'eng.1' },
  { key: 'liga', cat: 'football', sport: 'soccer', espn: 'esp.1' },
  { key: 'seriea', cat: 'football', sport: 'soccer', espn: 'ita.1' },
  { key: 'bundesliga', cat: 'football', sport: 'soccer', espn: 'ger.1' },
  { key: 'ligue1', cat: 'football', sport: 'soccer', espn: 'fra.1' },
  { key: 'nations', cat: 'football', sport: 'soccer', espn: 'uefa.nations' },
  { key: 'uel', cat: 'football', sport: 'soccer', espn: 'uefa.europa' },
  { key: 'csl', cat: 'football', sport: 'soccer', espn: 'chn.1' },
  { key: 'nba', cat: 'basketball', sport: 'basketball', espn: 'nba' },
  { key: 'cba', cat: 'basketball', from: 'cba' },
  { key: 'kpl', cat: 'esports', from: 'kpl' },
]

async function main() {
  const tables = {}
  let ok = 0
  const failed = []

  for (const comp of TARGETS) {
    process.stdout.write(`积分榜 ${comp.key.padEnd(11)} …`)
    let table = null
    try {
      if (comp.from === 'cba') table = await fetchCbaTable(comp)
      else if (comp.from === 'kpl') table = await fetchKplTable(comp)
      else table = await fetchEspnTable(comp)
    } catch (err) {
      log(`${comp.key} 异常：${err.message}`)
    }
    if (table) {
      // 分区着色只用「单组 + 足够多队伍」的表
      const g0 = table.groups[0]
      if (comp.cat === 'football' && table.groups.length === 1) {
        table.zones = zonesFor(comp.key, g0.rows.length)
      }
      tables[comp.key] = table
      ok += 1
      console.log(` ${g0.rows.length} 队${table.groups.length > 1 ? `（${table.groups.length} 组）` : ''}`)
    } else {
      failed.push(comp.key)
      console.log(' 失败')
    }
  }

  const payload = { generatedAt: new Date().toISOString(), tables }
  const body = `/** 本文件由 node tools/standings.js 生成，请勿手动修改 */\nmodule.exports = ${JSON.stringify(payload)}\n`
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  fs.writeFileSync(OUT_FILE, body)

  const sizeKB = Math.round(fs.statSync(OUT_FILE).size / 1024)
  console.log(`\n写入 data/standings.js：${ok} 个赛事 / ${sizeKB} KB`)
  if (failed.length) console.log(`  ⚠ 以下赛事没拿到积分榜：${failed.join('、')}`)
  console.log('')
}

main().catch((err) => {
  console.error('[standings] 未预期错误：', err && err.stack ? err.stack : err)
  process.exit(1)
})
