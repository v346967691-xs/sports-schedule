/**
 * 球员中文名「种子」生成器
 * ============================================================
 * 用法： node tools/player-names.js [--dry] [--only=ucl,epl] [--limit=200] [--concurrency=1] [--sleep=6500]
 *
 *   --limit=N   只处理本轮前 N 个「还没查过」的球员。
 *              每批结束都会落盘，比一把梭哈更抗中断。
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
 * ⚠️ **译名优先级：Wikidata `zh-cn` → `zh-hans` → 中文维基条目标题**（见 `zhNameOf`）。
 *   ① 召回靠中文维基全文检索：Wikidata 的 `wbsearchentities` 对「M. Olise」这种缩写
 *      基本搜不到，而 zhwiki 全文检索能命中；实测同一批球员命中数高出一倍以上。
 *      ⚠️ **后来推翻**：改用 Wikidata `wbsearchentities` 查完整英文名，命中率 95%+，见 searchEntities 注释。
 *   ② 译名取 Wikidata 的 **`zh-cn`/`zh-hans` 标签**（大陆译法），
 *      **不要用 `zh` 标签** —— 实测它大量是港台写法（路易斯·賀爾 / 詹姆斯·塔爾斯基）。
 *      zh-cn/zh-hans 都缺时才回落中文维基标题（已过 `varianttitles` 转简体）。
 *
 * ⚠️ **三道闸，缺一个都会污染字典**（踩过的坑都写在注释里）：
 *   ① 命中的必须是**人**且是**足球运动员**（P31=Q5 且 P106=Q937857 或 P641=Q2736）；
 *      —— 不加 P31=Q5 这道，俱乐部/国家队/赛事条目都会混进来（它们也带足球属性）；
 *   ② 英文标签/别名必须和 ESPN 给的名字对得上（去变音符号、忽略大小写，**词集合包含**，
 *      允许 Wikidata 多出父姓/中间名，如 `Sergio Canales Madrazo`）；
 *      —— 不加这道，「João Gomes」会串到另一个同名球员身上；
 *   ③ 译名必须**含中日韩汉字**，且**不带繁体专用字**；
 *      —— 防 Wikidata/维基的港台译名混进面向大陆的界面（宁可回落英文）。
 *
 * 输出 `tools/player-zh.js`，被 `zh-names.js` 引用。**该文件是构建期资产**，
 * `tools/` 已在 packOptions.ignore 里，不进代码包；生成的中文名会被
 * `tools/scorers.js` 烘焙进 `data/scorers.js` 的 `z` 字段。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const OUT_FILE = path.join(__dirname, 'player-zh.js')
/** 抓取阶段的候选结果缓存 —— 见 main() 里的说明，是「可续跑」的关键 */
const CACHE_FILE = path.join(__dirname, '.player-names-cache.json')
/**
 * 缓存格式版本。**改了检索通道 / 闸门口径就必须 +1** ——
 * 版本对不上会整份作废重抓，避免拿旧口径的结果冒充新结果。
 * 历史：1 = zhwiki 全文检索 gsrlimit 5；2 = 同上 limit 20；3 = 改用 Wikidata wbsearchentities。
 */
const CACHE_VERSION = 3

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports'
const WD_API = 'https://www.wikidata.org/w/api.php'
const ZHWIKI_API = 'https://zh.wikipedia.org/w/api.php'
const UA = 'sports-schedule-miniprogram/1.0 (player name dictionary; contact: repo owner)'

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1]
const LIMIT = Math.max(0, Number((args.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0)
// 🔴 默认**串行**（CONC=1）。MediaWiki 的 API 礼仪明确要求「请求必须串行、每秒不超过 1 次」，
//    并发请求本身就会触发限流 —— 踩过：并发 2 时约 22% 的请求吃 429，每次要退避 4~16 秒，
//    实测吞吐掉到 ~5 秒/人，比串行（~1.3 秒/人）还慢 4 倍。**调大并发只会更慢。**
const CONC = Math.max(1, Number((args.find((a) => a.startsWith('--concurrency=')) || '').split('=')[1]) || 1)

// 🔴 **默认串行 + 6.5 秒间隔（≈ 9 次/分钟），这不是保守，是最快。**
//    WMF 对单个 IP 的 API 配额大约每窗口 10 次，用满之后**所有请求秒回 429**，与节拍无关。
//    实测对比：800ms + 并发 2 → 592 人里 163 次撞墙、耗 55 分钟、还得再补一遍；
//              6500ms 串行   → 撞墙 0 次。
//    「慢就是快」在这里是真的 —— 撞一次墙要退避 30 秒，比老实等 6.5 秒贵得多。
const SLEEP = Math.max(0, Number((args.find((a) => a.startsWith('--sleep=')) || '').split('=')[1]) || 6500)

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
  for (let i = 0; i < 4; i += 1) {
    try {
      await waitCooldown()
      const c = new AbortController()
      const t = setTimeout(() => c.abort(), 30000)
      const res = await fetch(url, { signal: c.signal, headers: { 'User-Agent': UA } })
      clearTimeout(t)
      if (res.status === 429) {
        // 🔴 撞上限流：把**全局**冷却窗往后推，让所有在途请求一起等。
        //    实测这个 429 是**秒回**的（~240ms），说明不是拥塞而是**配额硬顶**：
        //    WMF 对单个 IP 的 API 配额大约每窗口 10 次，一旦用满，之后不管你多慢
        //    都直接拒绝 —— 所以退避要给足（30 秒），短退避（试过 5 秒）等于白撞，
        //    反而把整轮拖长。真要靠的是**把请求速率本身压到 9 次/分钟以下**。
        cooldownUntil = Math.max(cooldownUntil, Date.now() + 30000)
        await sleep(30000)
        continue
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      try {
        return JSON.parse(text)
      } catch (e) {
        // 非 JSON（多半就是那段限流提示文本），同样进全局冷却
        cooldownUntil = Math.max(cooldownUntil, Date.now() + 5000)
        await sleep(5000)
        continue
      }
    } catch (e) {
      if (i === 3) return null
      await sleep(1000 * (i + 1))
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

/**
 * 全局冷却闸 —— 限流是**按 IP 算的**，一个工人撞了 429，所有人都该停下来，
 * 否则剩下的人继续请求只会把窗口越拖越久。串行时它就是个直通的 await。
 */
let cooldownUntil = 0
async function waitCooldown() {
  const now = Date.now()
  if (now < cooldownUntil) await sleep(cooldownUntil - now)
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
const FOOTBALL_SPORT_Q = 'Q2736'
const HUMAN_Q = 'Q5'

/** 取某个 claim 的实体 id 列表 */
const claimIds = (ent, prop) => (((ent && ent.claims) || {})[prop] || [])
  .map((c) => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value && c.mainsnak.datavalue.value.id)

/**
 * 🔴 必须是**人**，且是足球运动员。
 *
 * 只查 `P641=足球` 是不够的 —— 实测**俱乐部、国家队、赛事条目都带足球属性**：
 * 「塞內加爾國家足球隊」「摩纳哥体育协会足球俱乐部」「2026年國際足協世界盃外圍賽」
 * 全都会通过，白白占掉候选位。先卡 `P31=Q5`（instance of: human）就能一步滤干净。
 */
function isFootballer(ent) {
  if (!claimIds(ent, 'P31').includes(HUMAN_Q)) return false
  return claimIds(ent, 'P106').includes(FOOTBALLER_Q) || claimIds(ent, 'P641').includes(FOOTBALL_SPORT_Q)
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

/**
 * 「只在繁体里出现」的常用字 —— 粗筛，用来在多个写法里优先挑简体。
 * ⚠️ 它抓不住**港式音译**（「伊斯高」三个字简繁同形、「安祖·罗拔臣」字符已简体），
 *    那种只能靠 Wikidata 的 zh-cn 标签救，这里的字表只解决字符级差异。
 */
const TRAD_ONLY = /[羅爾賓貝蘭馬奧薩費華維賀蘇積龍衛頓遜謝贊亞倫齊傑納萊內魯歷聯賽國隊韋]/
const looksTraditional = (s) => TRAD_ONLY.test(String(s || ''))

/**
 * 挑中文译名 —— **优先级：Wikidata `zh-cn` → `zh-hans` → 中文维基条目标题**。
 *
 * 🔴 **不要用 Wikidata 的 `zh` 标签**：实测它大量是港台写法
 *    （路易斯·賀爾 / 詹姆斯·塔爾斯基 / 亞力斯·格里馬爾多），而 `zh-cn`/`zh-hans`
 *    才是大陆译法（安德鲁·罗伯逊 / 若昂·坎塞洛 / 巴勃罗·伊瓦涅斯）。
 *    没有 zh-cn/zh-hans 时回落中文维基标题（已过 `varianttitles` 转简体），最后才用 `zh`。
 *
 * 🔴 **四个候选里如果都带繁体专用字，返回空串**（宁可回落英文）—— 见 looksTraditional。
 */
function zhNameOf(ent, wikiTitle) {
  const L = (ent && ent.labels) || {}
  const cands = [
    L['zh-cn'] && L['zh-cn'].value,
    L['zh-hans'] && L['zh-hans'].value,
    wikiTitle,
    // `zh` 排最后：它常常是港台写法，只有前面都取不到时才用（且还要过 looksTraditional）
    L.zh && L.zh.value,
  ].map((v) => stripParen(v)).filter((v) => v && hasCJK(v))
  if (!cands.length) return ''
  return cands.find((v) => !looksTraditional(v)) || ''
}

/**
 * 名字核对：ESPN 的名 vs Wikidata 的英文标签/别名。
 *
 * 🔴 不能只比「末段姓氏」—— Wikidata 常带父姓/中间名（`Sergio Canales Madrazo`、
 *    `Nico González Iglesias`），末段就成了 `Madrazo`，直接判不符把正确条目丢掉。
 *    改成**词集合包含**：两个方向的包含都算命中。
 */
function nameMatches(espnName, enNames) {
  const want = fold(espnName).split(/[\s.]+/).filter(Boolean)
  const sur = surnameOf(espnName)
  if (!want.length || !sur) return false
  for (const n of enNames) {
    const got = fold(n).split(/[\s.]+/).filter(Boolean)
    if (!got.length) continue
    if (got[got.length - 1] === sur) return true
    if (want.every((t) => got.includes(t))) return true
    if (got.every((t) => want.includes(t))) return true
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

/* ---------------- 第二步：找实体 —— Wikidata `wbsearchentities`
 *
 * 🔴 **不要用中文维基全文检索来「找人」。** 这是本项目最大的一个误判，记在这里：
 *    早期结论写的是「wbsearchentities 对 `M. Olise` 这种缩写基本搜不到」，于是改用
 *    zhwiki 全文检索。但那个结论**只对缩写名成立** —— 当时拿去搜的是 ESPN 的
 *    `shortName`。改用完整英文名（`displayName`）之后，wbsearchentities 的命中率
 *    几乎是 95%+：`Lamine Camara → Senegalese footballer (born 2004)`、
 *    `Issam Jebali → Tunisian association football player`、`Louis Patris → Belgian footballer`……
 *    而 zhwiki 全文检索搜 `Lamine Camara` 返回的是「塞內加爾國家足球隊 / 摩纳哥体育协会
 *    足球俱乐部 / 2026年世界盃外圍賽」这类噪音，`Gonzalo García` 返回「加西亚·马尔克斯 /
 *    百年孤独 / 神父俱乐部」。**检索通道选错，后面所有闸门都是在垃圾里挑。**
 *
 * 另一个好处：wbsearchentities 直接返回 **QID**，不再需要从条目名反查 wikibase_item，
 * 请求量从「每人 1 次 zhwiki」变成「每人 1 次 wikidata」，而 Wikidata 的限流宽容得多
 * （zhwiki 是按 IP 惩罚性限流，实测能把整轮拖到 50 分钟）。
 */
async function searchEntities(name) {
  const url = `${WD_API}?action=wbsearchentities&search=${encodeURIComponent(name)}` +
    '&language=en&uselang=en&type=item&limit=10&format=json'
  const j = await getJSON(url)
  // ⚠️ 返回 null = **请求失败**（限流/超时），调用方必须**不缓存**，下轮重试；
  //    返回 [] = 「搜过了，确实没有」—— 这个是可信的负结果，要缓存。
  if (!j) return null
  return ((j.search) || []).map((c) => c.id).filter(Boolean)
}

/* --------- 第三步：qid → 实体（批量），带上 zhwiki 的 sitelink 标题 */

async function qidsToEntities(qids) {
  const map = {}
  const uniq = [...new Set(qids)].filter(Boolean)
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50)
    const url = `${WD_API}?action=wbgetentities&ids=${chunk.join('|')}` +
      '&props=labels|aliases|claims|sitelinks&sitefilter=zhwiki' +
      '&languages=en|zh|zh-hans|zh-cn&format=json'
    const j = await getJSON(url)
    Object.assign(map, (j && j.entities) || {})
    await sleep(300)
  }
  return map
}

/**
 * 第四步：**批量**把中文维基标题转成简体。
 *
 * ⚠️ 中文维基的规范标题常常是繁体（「拉明·亞馬爾」），单加 `variant=zh-cn` 只影响正文、
 *    **标题照样回繁体**（实测）；要 `prop=info&inprop=varianttitles&variant=zh-cn`。
 * ⚠️ 关键在**批量**：`titles` 支持 50 个一批，所以 600 个人的标题只要 ~12 次请求，
 *    而不是一人一次。这是把 zhwiki 用量压到可接受范围的办法。
 * ⚠️ 顺带 `redirects=1`：港台译名常常是重定向（「阿根廷國家足球隊」→「阿根廷国家足球队」）。
 */
async function titlesToSimplified(titles) {
  const map = {}
  const uniq = [...new Set(titles.filter(Boolean))]
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50)
    const url = `${ZHWIKI_API}?action=query&titles=${encodeURIComponent(chunk.join('|'))}` +
      '&redirects=1&prop=info&inprop=varianttitles&variant=zh-cn&format=json&formatversion=2'
    const j = await getJSON(url)
    const q = (j && j.query) || {}
    ;(q.pages || []).forEach((p) => {
      const vt = p.varianttitles || {}
      const simp = vt['zh-cn'] || vt['zh-hans'] || vt['zh-sg'] || p.title
      if (simp) map[p.title] = simp
    })
    // 重定向/规范化：把原始写法也映射到同一个结果
    const alias = {}
    ;(q.normalized || []).forEach((r) => { alias[r.from] = r.to })
    ;(q.redirects || []).forEach((r) => { alias[r.from] = r.to })
    Object.keys(alias).forEach((from) => { if (map[alias[from]]) map[from] = map[alias[from]] })
    await sleep(500)
  }
  return map
}

/** 从 sitelinks 里取该实体的中文维基条目标题 */
const zhwikiTitleOf = (ent) => ((((ent || {}).sitelinks) || {}).zhwiki || {}).title || ''

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

  const all = players.filter((p) => !manual[p.id])

  // ⚠️ 中文维基对**来源 IP** 限流极狠（不像 Wikidata 只按请求速率）：
  //    实测连续 5 次请求后就开始 429，而且之后即使降到 0.3 秒一次也不解封，
  //    要闲置一段时间才恢复。→ 默认**串行 + 每次间隔 1 秒**，贴合 MediaWiki 的 API 礼仪。
  //
  // 🔴 **所以候选结果必须落盘缓存**：检索阶段占了这个脚本 99% 的耗时
  //    （解析阶段是瞬时的）—— 中途断一次就全白跑。命中缓存的人直接跳过请求，
  //    中断后重跑只补没抓到的，越跑越全。
  //
  // 🔴 **缓存语义**：`cacheStore[id]` = 这个人的候选 QID 数组。
  //    * key **不存在**     = 还没查过
  //    * key 存在但数组为空 = 查过了，`wbsearchentities` 确实没返回可用实体（可信的负结果）
  //    * 请求失败（`searchEntities` 返回 null）**绝不写缓存** —— 否则一次 429 就会把
  //      「这个人永远补不上」固化下来。踩过：早期版本把失败当 `[]` 缓存，而 JS 里 `[]` 是真值，
  //      判断写得稍微松一点就会把负结果当成命中，缓存被永久毒化。
  //
  // 🔴 **缓存带版本号**：改了检索通道 / 闸门口径就必须 +1，老缓存是**错的**。
  //    历史：1 = zhwiki 全文检索 gsrlimit 5；2 = 同上 limit 20；
  //          3 = 改用 Wikidata `wbsearchentities`（通道换了，前两版整份作废）。
  let cacheStore = {}
  if (!DRY) {
    try {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {}
      cacheStore = raw.v === CACHE_VERSION && raw.d ? raw.d : {}
    } catch (e) {
      cacheStore = {}
    }
  }
  const saveCache = () => {
    if (DRY) return
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ v: CACHE_VERSION, d: cacheStore }))
    } catch (e) { /* 缓存写不进去不该影响主流程 */ }
  }
  const cached = (id) => Object.prototype.hasOwnProperty.call(cacheStore, id)

  let todo = all.filter((p) => !cached(p.id))
  if (LIMIT > 0 && todo.length > LIMIT) {
    log(`--limit=${LIMIT}：本轮只处理 ${LIMIT}/${todo.length} 个未查过的`)
    todo = todo.slice(0, LIMIT)
  }
  log(`开始检索（并发 ${CONC}、间隔 ${SLEEP}ms）：待查 ${todo.length} 人 / 已缓存 ${all.length - todo.length} 人`)

  let done = 0
  let failed = 0
  let noneFound = 0
  await mapPool(todo, CONC, async (p) => {
    const qids = await searchEntities(p.full)
    if (qids === null) failed += 1
    else {
      cacheStore[p.id] = qids
      if (!qids.length) noneFound += 1
    }
    await sleep(SLEEP)
    done += 1
    if (done % 50 === 0) {
      saveCache()
      log(`  已查 ${done}/${todo.length}（请求失败 ${failed}／无实体 ${noneFound}）`)
    }
  })
  saveCache()
  log(`检索完成：本轮查 ${todo.length} 人（请求失败 ${failed}，其中无实体 ${noneFound}）`)

  const allQids = []
  const seenQid = {}
  Object.keys(cacheStore).forEach((id) => (cacheStore[id] || []).forEach((q) => {
    if (q && !seenQid[q]) { seenQid[q] = 1; allQids.push(q) }
  }))
  log(`去重后 wikibase item ${allQids.length} 个，开始批量取实体（含 zhwiki sitelink）…`)

  const ents = await qidsToEntities(allQids)

  // 批量把候选的中文维基标题转成简体 —— 一次请求 50 个标题，所以这一步很便宜
  const wikiTitles = allQids.map((q) => zhwikiTitleOf(ents[q])).filter(Boolean)
  log(`其中带中文维基条目的 ${wikiTitles.length} 个，批量转简体 …`)
  const simp = await titlesToSimplified(wikiTitles)

  const result = {}
  const cache = { seenZh: {} }
  // 先占位：手工表与上一轮已生成的名字先登记，避免同一个译名被两个人抢
  Object.keys(manual).forEach((id) => { if (manual[id]) cache.seenZh[manual[id]] = 1 })
  players.forEach((p) => { if (prev[p.id]) cache.seenZh[prev[p.id]] = 1 })

  let hit = 0
  let miss = 0
  let tradOnly = 0
  let notFoot = 0
  let nameBad = 0
  const misses = []
  // 遍历 `all` 而不是本轮的 `todo` —— 缓存命中的人也要参与匹配，
  // 否则分批跑（--limit）时，前几批已经查过的人永远进不了输出。
  all.forEach((p) => {
    let picked = ''
    for (const q of cacheStore[p.id] || []) {
      const ent = ents[q]
      if (!ent || ent.missing !== undefined) continue
      if (!isFootballer(ent)) { notFoot += 1; continue }
      if (!nameMatches(p.full, enNamesOf(ent))) { nameBad += 1; continue }
      const raw = zhwikiTitleOf(ent)
      // 译名：Wikidata 的 zh-cn/zh-hans 优先（大陆译法），回落中文维基条目（已转简体）
      const zh = zhNameOf(ent, simp[raw] || raw)
      if (!zh || !hasCJK(zh)) continue
      // 仍然带繁体专用字 → 这个条目没有简体写法（多半是港台译名）。
      // 面对大陆读者的界面，港台译名比英文短名更让人困惑，**宁可回落英文**。
      if (looksTraditional(zh)) { tradOnly += 1; continue }
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

  log(`命中 ${hit} 人 / 未命中 ${miss} 人（命中率 ${Math.round((hit / Math.max(1, all.length)) * 100)}%）`)
  log(`闸门挡下次数：非人类/非足球员 ${notFoot}｜英文名不符 ${nameBad}｜港台译名回落英文 ${tradOnly}`)

  // 保留上一轮里本轮没拿到的（射手上下榜会掉出集合，不该因此丢字典）
  //
  // ⚠️ **但只结转「看着像简体」的名字**：上一版用中文维基全文检索时留下一批港式译名
  //    （「安祖·罗拔臣」「伊斯高」「尼曼查·马迪」），面对大陆读者比英文短名更困惑。
  //    不带这道守卫，新通道查不到的那一刻就会被旧值顶住，永远换不掉。
  let carried = 0
  players.forEach((p) => {
    if (!result[p.id] && prev[p.id] && !manual[p.id] && !looksTraditional(prev[p.id])) {
      result[p.id] = prev[p.id]
      cache.seenZh[prev[p.id]] = 1
      carried += 1
    }
  })
  if (carried) log(`另有 ${carried} 人沿用上一轮的名字（本轮没查到的）`)

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

/**
 * ⚠️ 必须用 `require.main === module` 守住 —— 否则诊断脚本 / smoke `require` 这个文件时
 *    会把整轮抓取（几十分钟）跑一遍。tools 里其他脚本都遵守这条。
 */
if (require.main === module) {
  main().catch((err) => {
    console.error('[player-names] 未预期错误：', err && err.stack ? err.stack : err)
    process.exit(1)
  })
}

// 供诊断脚本 / smoke 复用的纯函数与单步能力
module.exports = {
  TARGETS,
  CACHE_FILE,
  CACHE_VERSION,
  sleep,
  getJSON,
  searchEntities,
  titlesToSimplified,
  zhwikiTitleOf,
  qidsToEntities,
  collectPlayers,
  isFootballer,
  enNamesOf,
  nameMatches,
  zhNameOf,
  looksTraditional,
  stripParen,
  hasCJK,
  fold,
  surnameOf,
}
