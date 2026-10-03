/**
 * 球员中文名「种子」生成器
 * ============================================================
 * 用法： node tools/player-names.js [--dry] [--only=ucl,epl] [--concurrency=4]
 *
 * 为什么需要它：ESPN **全站不提供任何球员中文名**（`?lang=zh` 实测无效，
 * 见 tools/scorers.js 顶部的探测结论），所以球员汉化只能自建字典。
 * 而射手榜每个赛季都会冒出一两百个新名字，纯手工维护不现实 —— 这个脚本负责
 * 批量播种，人工只需在 `zh-names.js` 的 PLAYER_ZH 里纠错与改简称。
 *
 * 优先级（高 → 低）：
 *   ① `zh-names.js` 的 PLAYER_ZH     —— 人工，权威，可覆盖任何自动结果
 *   ② `player-zh.js` 的 AUTO_PLAYER_ZH —— 本脚本生成，覆盖面广
 *   ③ 回落英文短名（形如 "E. Haaland"）—— 未命中，正常现象
 *
 * ------------------------------------------------------------ 取数策略
 * ⚠️ **以中文维基百科的条目标题为准**，不用 Wikidata 的 zh 标签。两个原因：
 *   ① 召回更好：Wikidata 的 `wbsearchentities` 对「M. Olise」这种缩写基本搜不到，
 *      而 zhwiki 全文检索能命中；实测同一批球员命中数高出一倍以上；
 *   ② 译名更自然：zhwiki 标题是「埃尔梅丁·德米罗维奇」「尼科·帕斯」这类通用译名，
 *      而 Wikidata 的 zh 标签常是港台译法（「米高·奧利斯」）或是照字面拼的
 *      （「约埃里·蒂耶莱曼斯」），读起来不像中文体育媒体会用的叫法。
 *
 * ⚠️ **三道闸，缺一个都会污染字典**（踩过的坑都写在注释里）：
 *   ① 命中的必须是**人物条目**，且该人物是**足球运动员**（Wikidata P106 = Q937857）；
 *      —— 不加这道，会搜出「2026年至2027年歐洲冠軍聯賽聯賽階段」这种赛季条目；
 *   ② 实体的英文标签/别名必须和 ESPN 给的名字对得上（去变音符号、忽略大小写，姓氏段一致即可）；
 *      —— 不加这道，「João Gomes」会串到另一个同名球员身上；
 *   ③ 译名必须**含中日韩汉字**；
 *      —— Wikidata 请求带 languagefallback 时，缺中文标签会**回填英文**，
 *        直接采信会往字典里写进 'Danijel Šturm' 这种"中文名"。zhwiki 标题天然免疫，
 *        但这条仍然要留着兜住那条回落路径。
 *
 * 输出 `tools/player-zh.js`，被 `zh-names.js` 引用。**该文件是构建期资产**，
 * `tools/` 已在 packOptions.ignore 里，不进代码包；生成的中文名会被
 * `tools/scorers.js` 烘焙进 `data/scorers.js` 的 `z` 字段。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const OUT_FILE = path.join(__dirname, 'player-zh.js')

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports'
const WD_API = 'https://www.wikidata.org/w/api.php'
const ZHWIKI_API = 'https://zh.wikipedia.org/w/api.php'
const UA = 'sports-schedule-miniprogram/1.0 (player name dictionary; contact: repo owner)'

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1]
const CONC = Math.max(1, Number((args.find((a) => a.startsWith('--concurrency=')) || '').split('=')[1]) || 2)

/** 与 scorers.js 的目标一致：只有这些赛事上游有榜 */
const TARGETS = [
  { key: 'ucl', espn: 'uefa.champions' },
  { key: 'epl', espn: 'eng.1' },
  { key: 'liga', espn: 'esp.1' },
  { key: 'seriea', espn: 'ita.1' },
  { key: 'bundesliga', espn: 'ger.1' },
  { key: 'ligue1', espn: 'fra.1' },
  { key: 'nations', espn: 'uefa.nations' },
  { key: 'uel', espn: 'uefa.europa' },
  { key: 'csl', espn: 'chn.1' },
  { key: 'acl', espn: 'afc.champions' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function log(...a) {
  console.log('[player-names]', ...a)
}

/**
 * ⚠️ 429 必须特殊对待：维基系对短时间高频请求会直接吐一段纯文本
 *    "You are making too many requests to the API."（不是 JSON），
 *    按普通错误退避 1 秒是没用的，还容易把整轮抓取连累成全空
 *    （踩过：并发 4 跑 95 个球员，后面所有 pageprops 请求全部 429 → 0 命中）。
 */
async function getJSON(url) {
  for (let i = 0; i < 5; i += 1) {
    try {
      const c = new AbortController()
      const t = setTimeout(() => c.abort(), 25000)
      const res = await fetch(url, { signal: c.signal, headers: { 'User-Agent': UA } })
      clearTimeout(t)
      if (res.status === 429) {
        const wait = 4000 * (i + 1)
        if (i < 4) { await sleep(wait); continue }
        return null
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      try {
        return JSON.parse(text)
      } catch (e) {
        // 非 JSON（多半就是限流提示），当限流处理
        if (i < 4) { await sleep(4000 * (i + 1)); continue }
        return null
      }
    } catch (e) {
      if (i === 4) return null
      await sleep(800 * (i + 1))
    }
  }
  return null
}

/** 有限并发的 map（维基系接口对并发容忍度低，默认 2 路） */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  async function worker() {
    for (;;) {
      const i = cursor
      cursor += 1
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(new Array(Math.min(limit, items.length)).fill(0).map(worker))
  return out
}

/* ------------------------------------------------------ 名字归一与校验 */

/** 与 zh-names.js 的 foldKey 同一口径：剥声调、剥撇号、忽略大小写 */
const fold = (s) => String(s)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/['’`]/g, '')
  .toLowerCase().trim()

/** 取名字的「姓氏段」用于宽松匹配： "Erling Haaland" → "haaland" */
function surnameOf(name) {
  const parts = fold(name).split(/[\s.]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

/** 必须含中日韩汉字，否则不是中文译名（防 Wikidata languagefallback 回填英文） */
const hasCJK = (s) => /[\u3400-\u9fff]/.test(String(s || ''))

/** 去掉维基百科标题的消歧义后缀：「若昂·戈梅斯 (2001年)」→「若昂·戈梅斯」 */
const stripParen = (s) => String(s || '').replace(/\s*[（(][^）)]*[）)]\s*$/, '').trim()

const FOOTBALLER_Q = 'Q937857'

function isFootballer(ent) {
  const claims = (ent && ent.claims) || {}
  const occ = (claims.P106 || []).map((c) => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value && c.mainsnak.datavalue.value.id)
  if (occ.includes(FOOTBALLER_Q)) return true
  const sport = (claims.P641 || []).map((c) => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value && c.mainsnak.datavalue.value.id)
  return sport.includes('Q2736')
}

/** 实体身上所有英文名字（label + aliases），用于和 ESPN 名字核对 */
function enNamesOf(ent) {
  const out = []
  const labels = (ent && ent.labels) || {}
  if (labels.en && labels.en.value) out.push(labels.en.value)
  const aliases = (ent && ent.aliases) || {}
  if (aliases.en) aliases.en.forEach((a) => a && a.value && out.push(a.value))
  return out
}

function nameMatches(espnName, enNames) {
  const want = fold(espnName)
  const sur = surnameOf(espnName)
  if (!want || !sur) return false
  for (const n of enNames) {
    const got = fold(n)
    if (got === want) return true
    // 宽松：姓氏段一致即可（ESPN 常写 "M. Olise"，维基写全名）
    if (sur.length >= 4 && surnameOf(n) === sur) return true
  }
  return false
}

/* ------------------------------------------------------ 第一步：待补的球员 */

async function collectPlayers() {
  const keys = ONLY ? ONLY.split(',').map((s) => s.trim()) : null
  const out = new Map() // id -> { id, full, short }
  for (const t of TARGETS) {
    if (keys && !keys.includes(t.key)) continue
    const json = await getJSON(`${ESPN}/soccer/${t.espn}/statistics`)
    const stats = (json && json.stats) || []
    stats
      .filter((s) => s.name === 'goalsLeaders' || s.name === 'assistsLeaders')
      .forEach((s) => {
        ;(s.leaders || []).forEach((l) => {
          const a = l.athlete || {}
          const id = String(a.id || '')
          if (!id || out.has(id)) return
          const full = String(a.displayName || '').trim()
          const short = String(a.shortName || '').trim()
          if (!full && !short) return
          out.set(id, { id, full: full || short, short: short || full })
        })
      })
    log(`${t.key} 累计待补 ${out.size} 人`)
  }
  return [...out.values()]
}

/* --------- 第二步：中文维基检索（一步同时拿到条目名与 wikibase item）
   `generator=search` 把「搜索 + 取 pageprops」并成**一次**请求，
   比「先 list=search 再 prop=pageprops」省一半请求量 —— 维基那边对请求数很敏感。 */

async function searchZhwiki(name) {
  const url = `${ZHWIKI_API}?action=query&generator=search` +
    `&gsrsearch=${encodeURIComponent(name)}&gsrnamespace=0&gsrlimit=5` +
    // ⚠️ prop=info + inprop=varianttitles + variant=zh-cn 是关键：
    //    中文维基的**规范标题常常是繁体**（「拉明·亞馬爾」），
    //    单加 `variant=zh-cn` 只影响正文渲染，**标题照样回繁体**（实测）。
    //    varianttitles 才会把标题按变体转换一遍，拿到简体「拉明·亚马尔」。
    '&prop=info|pageprops&inprop=varianttitles&variant=zh-cn&ppprop=wikibase_item' +
    '&format=json&formatversion=2'
  const j = await getJSON(url)
  const pages = (j && j.query && j.query.pages) || []
  return pages.map((p) => {
    const vt = p.varianttitles || {}
    return {
      title: vt['zh-cn'] || vt['zh-hans'] || vt['zh-sg'] || p.title,
      raw: p.title,
      qid: (p.pageprops && p.pageprops.wikibase_item) || '',
    }
  }).filter((x) => x.title)
}

/* ------------------------------- 第三步：qid → 实体（批量），核验并取译名 */

async function qidsToEntities(qids) {
  const map = {}
  for (let i = 0; i < qids.length; i += 50) {
    const chunk = qids.slice(i, i + 50)
    const url = `${WD_API}?action=wbgetentities&ids=${chunk.join('|')}` +
      '&props=labels|aliases|claims&languages=en|zh|zh-hans|zh-cn|zh-hant|zh-hk|zh-tw&format=json'
    const j = await getJSON(url)
    Object.assign(map, (j && j.entities) || {})
    await sleep(120)
  }
  return map
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const zhNames = require('./zh-names')
  const manual = zhNames.PLAYER_ZH || {}

  let prev = {}
  try {
    prev = require('./player-zh').AUTO_PLAYER_ZH || {}
  } catch (e) {
    prev = {}
  }

  const players = await collectPlayers()
  log(`待补球员 ${players.length} 人（手工表已覆盖 ${players.filter((p) => manual[p.id]).length} 人）`)

  const targets = players.filter((p) => !manual[p.id])
  log(`开始检索（并发 ${CONC}）…`)

  // 一趟：每个人搜中文维基，同时拿到候选条目名与 wikibase item
  //
  // ⚠️ 中文维基对**来源 IP** 限流极狠（不像 Wikidata 只按请求速率）：
  //    实测连续 5 次请求后就开始 429，而且之后即使降到 0.3 秒一次也不解封。
  //    所以这里只能慢慢来（默认并发 2、每次间隔 1.2 秒），并且脚本是**可续跑**的
  //    —— 和上一轮的 player-zh.js 合并，跑几次就能把覆盖面一点点攒起来。
  //    别为了快把并发调高：换来的只是更长的一串 429 退避，总耗时反而更久。
  const candById = {}
  await mapPool(targets, CONC, async (p) => {
    candById[p.id] = await searchZhwiki(p.full)
    await sleep(1200)
  })

  const allQids = []
  const seenQid = {}
  Object.keys(candById).forEach((id) => candById[id].forEach((c) => {
    if (c.qid && !seenQid[c.qid]) { seenQid[c.qid] = 1; allQids.push(c.qid) }
  }))
  log(`候选条目 ${Object.values(candById).reduce((n, a) => n + a.length, 0)} 个，去重后 wikibase item ${allQids.length} 个，开始批量核验 …`)

  const ents = await qidsToEntities(allQids)

  const result = {}
  const cache = { seenZh: {} }
  // 先占位：手工表与上一轮已生成的名字先登记，避免同一个译名被两个人抢
  Object.keys(manual).forEach((id) => { if (manual[id]) cache.seenZh[manual[id]] = 1 })
  players.forEach((p) => { if (prev[p.id]) cache.seenZh[prev[p.id]] = 1 })

  let hit = 0
  let miss = 0
  const misses = []
  targets.forEach((p) => {
    let picked = ''
    for (const cand of candById[p.id] || []) {
      if (!cand.qid) continue
      const ent = ents[cand.qid]
      if (!ent || ent.missing !== undefined) continue
      if (!isFootballer(ent)) continue
      if (!nameMatches(p.full, enNamesOf(ent))) continue
      const zh = stripParen(cand.title)
      if (!hasCJK(zh)) continue
      if (cache.seenZh[zh]) continue
      picked = zh
      break
    }
    if (picked) {
      hit += 1
      result[p.id] = picked
      cache.seenZh[picked] = 1
    } else {
      miss += 1
      misses.push(p)
    }
  })

  log(`命中 ${hit} 人 / 未命中 ${miss} 人（命中率 ${Math.round((hit / Math.max(1, targets.length)) * 100)}%）`)

  // 保留上一轮里本轮没抓到的（射手上/下榜会掉出集合，不该因此丢字典）
  players.forEach((p) => {
    if (!result[p.id] && prev[p.id] && !manual[p.id]) {
      result[p.id] = prev[p.id]
      cache.seenZh[prev[p.id]] = 1
    }
  })

  const ids = Object.keys(result).sort((a, b) => Number(a) - Number(b))
  const body = [
    '/**',
    ' * 球员中文名（自动生成的种子，按 ESPN athlete id）',
    ' * ============================================================',
    ' * ⚠️ 本文件由 `node tools/player-names.js` 生成，请勿手工编辑 ——',
    ' *    要纠错或改简称，请写进 `tools/zh-names.js` 的 PLAYER_ZH（优先级更高）。',
    ' *    来源：中文维基百科条目标题，经「足球运动员职业校验 + 英文名核对」双重过滤。',
    ' *',
    ' * 怎么重建：`node tools/player-names.js`；只重建某几个赛事：',
    ' *    `node tools/player-names.js --only=ucl,epl`',
    ' * 看生成结果而不落盘：`node tools/player-names.js --dry`',
    ' */',
    '',
    'const AUTO_PLAYER_ZH = {',
  ]
  ids.forEach((id) => {
    body.push(`  '${id}': '${String(result[id]).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}',`)
  })
  body.push('}')
  body.push('')
  body.push('module.exports = { AUTO_PLAYER_ZH }')
  body.push('')

  if (DRY) {
    log('--dry：不落盘，以下是前 80 条')
    ids.slice(0, 80).forEach((id) => console.log(`  '${id}': '${result[id]}',`))
  } else {
    fs.writeFileSync(OUT_FILE, body.join('\n'))
    log(`写入 tools/player-zh.js：${ids.length} 名球员 / ${Math.round(fs.statSync(OUT_FILE).size / 1024)} KB`)
    log('⚠️ 记得重跑 `node tools/scorers.js` 把中文名烘焙进 data/scorers.js')
  }

  // 把没命中的列出来，方便人工判断「值得补」的那几个
  if (misses.length) {
    log(`未命中的 ${misses.length} 人（前 30，可人工补进 PLAYER_ZH）：`)
    misses.slice(0, 30).forEach((p) => console.log(`  ${p.id}\t${p.short}\t${p.full}`))
  }
}

main().catch((err) => {
  console.error('[player-names] 未预期错误：', err && err.stack ? err.stack : err)
  process.exit(1)
})
