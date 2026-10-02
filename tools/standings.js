/**
 * 积分榜 / 排名抓取
 * ============================================================
 * 用法： node tools/standings.js            抓取并写入 data/standings.js
 *
 * 为什么单独一个文件：
 *   sync.js 一 require 就会执行底部的 main()，没法被别处复用；
 *   积分榜又是独立于赛程的另一份数据流，混在一起会让两边都难改。
 *
 * 数据来源只有**官方积分榜**（2026-10-02 用户定：只拉官方榜，不自己算）：
 *   ① ESPN —— 10 个赛事全通，team.id 与 scoreboard 同源，
 *      所以 tools/zh-names.js 里现成的中文映射可以直接复用，零汉化成本。
 *   ② 英雄联盟 —— 官方 getStandings（LPL / LCK / LEC 都有当前赛季榜），
 *      队名简码与 zh-names.js 的 LOL_ZH 同键，同样零汉化成本。
 *   ❌ CBA / KPL —— 官方**没有**排名端点（2026-10-02 实测：CBA 8 个候选、
 *      KPL 6 个候选全 404），按「没有官方榜就不拉」的原则**不做**，等官方出接口再说。
 *   ❌ 杯赛（全球总决赛 / 季中赛 / 德玛西亚杯 / 亚运会）与国字号 —— 本来就没有积分榜。
 *
 * ⚠️ 任何失败都返回空表，绝不抛错：积分榜是增强功能，不能拖垮赛程主链路。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const OUT_FILE = path.join(ROOT, 'data', 'standings.js')

const ESPN_V2 = 'https://site.api.espn.com/apis/v2/sports'
// 英雄联盟官方（与 sync.js 抓赛程同一域名同一 key，不用新加白名单）
const LOL = 'https://esports-api.lolesports.com/persisted/gw'
const LOL_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z'

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
 * 紧凑列定义（2026-10-02 按用户参考图改版）：
 * 原来平铺 8 列把队名挤成两个字的折叠，现在合并成 4 列，
 * 「胜/平/负」「进/失」各自合成一个单元格，宽度让给队名。
 * 单元格文本在页面端 renderRow() 按 key 拼接，两边必须配套改。
 */
const COLUMNS = {
  football: [
    { key: 'played', label: '赛' },
    { key: 'wdl', label: '胜/平/负' },
    { key: 'goals', label: '进/失' },
    { key: 'pts', label: '积分', strong: true },
  ],
  basketball: [
    { key: 'played', label: '赛' },
    { key: 'wdl', label: '胜/负' },
    { key: 'winPct', label: '胜率', strong: true },
    { key: 'goals', label: '得/失' },
  ],
  esports: [
    { key: 'played', label: '赛' },
    { key: 'wdl', label: '胜/负' },
    { key: 'winPct', label: '胜率', strong: true },
  ],
}

/**
 * 分区配色（参考用户给的对照图：欧冠区红、欧联区蓝）。
 * color = 标签块底色，bg = 整行底色（浅色版）。
 */
const ZONE_STYLE = {
  ucl: { label: '欧冠区', color: '#D03A3A', bg: '#FCECEB' },
  uel: { label: '欧联区', color: '#2C6BC9', bg: '#E9F0FC' },
  uecl: { label: '欧协联区', color: '#12977E', bg: '#E6F4F0' },
  rel: { label: '降级区', color: '#5C6470', bg: '#F0F1F4' },
  relpo: { label: '降级附加赛', color: '#C77E1F', bg: '#FBF2E3' },
  r16: { label: '直接晋级', color: '#2F7A52', bg: '#E9F4EE' },
  po: { label: '附加赛区', color: '#C77E1F', bg: '#FBF2E3' },
  out: { label: '淘汰区', color: '', bg: '' },
  acl: { label: '亚冠区', color: '#2F7A52', bg: '#E9F4EE' },
  po2: { label: '季后赛区', color: '#2F7A52', bg: '#E9F4EE' },
  playin: { label: '附加赛区', color: '#C77E1F', bg: '#FBF2E3' },
  // 欧国联专用（note 文本 "Qualifies for QFs" / "Promotion"）
  qf: { label: '晋级八强', color: '#2F7A52', bg: '#E9F4EE' },
  promo: { label: '直接升级', color: '#2F7A52', bg: '#E9F4EE' },
  promo_po: { label: '升级附加赛', color: '#C77E1F', bg: '#FBF2E3' },
}

/** ESPN 的英文 note → 我们的分区。用前缀匹配，qualifying 归并到同一分区（标签保持简短） */
function zoneFromNote(note) {
  const n = String(note || '')
  if (/^champions league/i.test(n)) return ZONE_STYLE.ucl
  if (/^europa league/i.test(n)) return ZONE_STYLE.uel
  if (/^conference league/i.test(n)) return ZONE_STYLE.uecl
  if (/relegation playoff/i.test(n)) return ZONE_STYLE.relpo
  if (/relegation/i.test(n)) return ZONE_STYLE.rel
  // 欧冠/欧联的 36 队联赛阶段：直接晋级 / 附加赛 / 淘汰
  if (/qualifies for round of 16/i.test(n)) return ZONE_STYLE.r16
  // 欧国联：A 组前二 "Qualifies for QFs"（必须排在 promotion 之前，
  // 因为 B-D 的 note 是 "...; B-D: Promotion playoffs"，同一段文字两种含义）
  if (/qualifies for qf/i.test(n)) return ZONE_STYLE.qf
  if (/knockout phase playoffs/i.test(n)) return ZONE_STYLE.po
  if (/promotion playoff/i.test(n)) return ZONE_STYLE.promo_po
  if (/promotion/i.test(n)) return ZONE_STYLE.promo
  if (/eliminated/i.test(n)) return ZONE_STYLE.out
  return null
}

/** 没有官方 note 时的固定区间兜底（自算榜 / NBA / 欧国联各组） */
function zoneFallback(compKey, cat, pos, count, groupName) {
  if (compKey === 'csl') {
    if (pos <= 2) return ZONE_STYLE.acl
    if (pos >= count - 1) return ZONE_STYLE.rel
    return null
  }
  if (compKey === 'nations') {
    // 欧国联：ESPN 只给部分组挂了 note（2026-10-02 只挂了 A1），其他组会显得
    // 「有的有色块有的没有」。这里的规则**逐条取自 ESPN 官方 note 的四个模板**：
    //   1st：A=晋级八强(QF) / B-D=直接升级
    //   2nd：A=晋级八强(QF) / B-D=升级附加赛
    //   3rd：A/B=降级附加赛 / C-D 无
    //   4th：A/B=降级区 / C=降级附加赛（官方原文 Relegation or playoffs）/ D 无
    // 组名已被 groupLabel 翻成「A1 组」这种，所以匹配开头的联赛字母。
    const lg = (String(groupName || '').match(/^([A-D])\d*\s*组/) || [])[1] || ''
    if (lg === 'A') {
      if (pos <= 2) return ZONE_STYLE.qf
      if (pos === 3) return ZONE_STYLE.relpo
      if (pos === 4) return ZONE_STYLE.rel
    } else if (lg === 'B') {
      if (pos === 1) return ZONE_STYLE.promo
      if (pos === 2) return ZONE_STYLE.promo_po
      if (pos === 3) return ZONE_STYLE.relpo
      if (pos === 4) return ZONE_STYLE.rel
    } else if (lg === 'C') {
      if (pos === 1) return ZONE_STYLE.promo
      if (pos === 2) return ZONE_STYLE.promo_po
      if (pos === 3) return ZONE_STYLE.relpo
      if (pos === 4) return ZONE_STYLE.relpo
    } else if (lg === 'D') {
      if (pos === 1) return ZONE_STYLE.promo
      if (pos === 2) return ZONE_STYLE.promo_po
    }
    return null
  }
  if (cat === 'basketball') {
    // NBA 每个分区前 6 进季后赛、7-10 打附加赛
    if (pos <= 6) return ZONE_STYLE.po2
    if (pos <= 10) return ZONE_STYLE.playin
    return null
  }
  return null
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
    pts: cat === 'football' ? pick(stats, 'points') : null,
    winPct: cat === 'football' ? null : Number((pick(stats, 'winPercent') || 0).toFixed(3)),
    streak: cat === 'basketball' ? pickText(stats, 'streak') : '',
  }
  // 分区直接采信 ESPN 的官方标注（note），它连「西甲 1-5 欧冠、10 也是欧联」
  // 这种不规则区间都能表达；没有 note 的（自算榜 / NBA）走固定区间兜底
  const notes = Array.isArray(entry.note)
    ? entry.note.map((n) => n.description).filter(Boolean)
    : (entry.note && entry.note.description ? [entry.note.description] : [])
  for (const n of notes) {
    const z = zoneFromNote(n)
    if (z && z.bg) { row.zone = { label: z.label, color: z.color, bg: z.bg }; break }
  }
  return row
}

/** 给整张表补分区：官方 note 优先（espnRow 里已标），剩余按固定区间兜底 */
function applyZones(table, compKey, cat) {
  ;(table.groups || []).forEach((g) => {
    const count = (g.rows || []).length
    ;(g.rows || []).forEach((r) => {
      if (r.zone) return
      const z = zoneFallback(compKey, cat, r.pos, count, g.name)
      if (z && z.bg) r.zone = { label: z.label, color: z.color, bg: z.bg }
    })
  })
  return table
}

/**
 * 排序：足球按积分、其余按胜率。
 * ⚠️ 足球同分时**先比 ESPN 的官方名次（rank），再比净胜球/进球** ——
 *    rank 里含 head-to-head 等官方同分裁决，我们自己用进球数排会排反：
 *    2026-10-02 欧国联 A1 意大利21、比利时22 同分同净胜球，官方名次是
 *    比利时第 2、意大利第 3（互相交锋占优），按进球排就把意大利顶到了第 2，
 *    分区色带（降级附加赛）也跟着挂到了第 2 名头上，用户一眼看出异常。
 * ⚠️ 排完必须按数组顺序重新编号 —— NBA 季前赛全 0 胜时 ESPN 的 playoffSeed
 *    会整体退化成 1，直接用它的值会出现「15 支球队都排第 1」的荒唐场面。
 */
function sortRows(rows, cat) {
  // espnRow 里 pos 存的是 ESPN 官方 rank，排序前先存下来（排序后会重编号覆盖）
  rows.forEach((r) => { r._esRank = Number(r.pos) || 0 })
  rows.sort((a, b) => {
    if (cat === 'football') {
      if (b.pts !== a.pts) return (b.pts || 0) - (a.pts || 0)
      if (a._esRank && b._esRank && a._esRank !== b._esRank) return a._esRank - b._esRank
      if (b.diff !== a.diff) return (b.diff || 0) - (a.diff || 0)
      if (b.scored !== a.scored) return (b.scored || 0) - (a.scored || 0)
      return String(a.name).localeCompare(String(b.name))
    }
    if (b.winPct !== a.winPct) return (b.winPct || 0) - (a.winPct || 0)
    if (b.wins !== a.wins) return (b.wins || 0) - (a.wins || 0)
    return String(a.name).localeCompare(String(b.name))
  })
  rows.forEach((r, i) => { r.pos = i + 1 })
  return rows
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

  return applyZones({
    comp: comp.key,
    // ⚠️ 只有「赛季型」children（名字带年份）才能当赛季名展示；
    //    欧国联/NBA 的 children 是分组，children[0].name 是「Group A1」/
    //    「Eastern Conference」，当赛季名显示会很怪（2026-10-02 用户截图发现）
    season: seasonKids.length ? ((seasonPool[0] && seasonPool[0].name) || '') : '',
    columns: COLUMNS[comp.cat] || COLUMNS.football,
    groups: out,
  }, comp.key, comp.cat)
}

/* ------------------------------------------------------------------ ② 英雄联盟：官方 getStandings */

/**
 * 英雄联盟官方积分榜（2026-10-02 实测可用）
 *
 * 两步：① getTournamentsForLeague 拿该赛区所有赛季，取 startDate 最新的那个；
 *       ② getStandings 拿这个赛季的榜。
 *
 * ⚠️ 只取 stages[0]（小组赛 / 常规赛）：后面的「骑士之路」「淘汰赛」「赛区资格赛」
 *    不是循环赛排名，混进来会让同一支队在两张表里各出现一次。
 * ⚠️ sections[] = 分组（LPL 涅槃组 + 登峰组、LCK 传奇组 + 突破组、LEC 就一组）。
 * ⚠️ rankings[] 的每一项是**一个名次**（ordinal），teams[] 是并列这个名次的队 ——
 *    所以 pos 取 ordinal，不是数组下标，否则并列时名次会错。
 * ⭐ teams[].code（BLG / T1 / G2…）就是 zh-names.js 里 LOL_ZH 的键，中文名直接复用。
 */
async function fetchLolTable(comp) {
  const headers = { 'x-api-key': LOL_KEY }

  const tr = await getJSON(`${LOL}/getTournamentsForLeague?hl=zh-CN&leagueId=${comp.lol}`, headers)
  const tournaments = (tr && tr.data && tr.data.leagues && tr.data.leagues[0]
    && tr.data.leagues[0].tournaments) || []
  if (!tournaments.length) return null
  const season = tournaments.slice()
    .sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)))[0]

  const st = await getJSON(`${LOL}/getStandings?hl=zh-CN&tournamentId=${season.id}`, headers)
  const stages = (st && st.data && st.data.standings && st.data.standings[0]
    && st.data.standings[0].stages) || []
  if (!stages.length) return null

  const stage = stages[0]
  const groups = (stage.sections || []).map((sec) => {
    const rows = []
    ;(sec.rankings || []).forEach((rk, i) => {
      const ordinal = Number(rk.ordinal || 0) || (i + 1)
      ;(rk.teams || []).forEach((tm) => {
        const code = tm.code || ''
        const wins = (tm.record && Number(tm.record.wins)) || 0
        const losses = (tm.record && Number(tm.record.losses)) || 0
        const played = wins + losses
        rows.push({
          id: String(tm.id || code),
          // ⚠️ 电竞俱乐部一律显示英文简称（BLG / T1 / G2），2026-10-02 用户要求；
          //    显示口径是 `zh || name`，所以 name 放简码、zh 留空
          name: code || tm.name,
          zh: '',
          abbr: code || String(tm.name || '').slice(0, 6),
          pos: ordinal,
          played,
          wins,
          losses,
          draws: null,
          scored: null,
          conceded: null,
          pts: null,
          winPct: played ? Number((wins / played).toFixed(3)) : 0,
          streak: '',
        })
      })
    })
    return { name: sec.name || '', rows }
  }).filter((g) => g.rows.length)

  if (!groups.length) return null
  // 只有一个分组时不再重复画组名（赛程名已经写在上面了）
  if (groups.length === 1) groups[0].name = ''

  return {
    comp: comp.key,
    season: stage.name || '',
    columns: COLUMNS.esports,
    groups,
  }
}

/* ------------------------------------------------------------------ 主流程 */

/**
 * 有**官方**积分榜的赛事。
 * 杯赛（worlds / msi / demacia / agames）和中国国字号（chn）天然没有积分榜，不列。
 * CBA / KPL 官方没有排名端点，按「没有官方榜就不拉」的原则也不列（2026-10-02 用户定）。
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
  // 英雄联盟：官方榜，leagueId 与 sync.js 的 COMPETITIONS 保持一致
  { key: 'lpl', cat: 'esports', from: 'lol', lol: '98767991314006698' },
  { key: 'lck', cat: 'esports', from: 'lol', lol: '98767991310872058' },
  { key: 'lec', cat: 'esports', from: 'lol', lol: '98767991302996019' },
]

async function main() {
  const tables = {}
  let ok = 0
  const failed = []

  for (const comp of TARGETS) {
    process.stdout.write(`积分榜 ${comp.key.padEnd(11)} …`)
    let table = null
    try {
      if (comp.from === 'lol') table = await fetchLolTable(comp)
      else table = await fetchEspnTable(comp)
    } catch (err) {
      log(`${comp.key} 异常：${err.message}`)
    }
    if (table) {
      ok += 1
      const g0 = table.groups[0]
      console.log(` ${g0.rows.length} 队${table.groups.length > 1 ? `（${table.groups.length} 组）` : ''}`)
      tables[comp.key] = table
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
