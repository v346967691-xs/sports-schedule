/**
 * 球员中文名「种子」生成器
 * ============================================================
 * 用法： node tools/player-names.js [--dry] [--only=ucl,epl] [--limit=200] [--source=all|scorers|lineups]
 *                                  [--channel=a|b|both] [--concurrency=1] [--sleep=6500]
 *
 *   --limit=N   只处理本轮前 N 个「还没查过」的球员。
 *              每批结束都会落盘，比一把梭哈更抗中断。
 *   --source=   取哪些球员当输入：
 *                 scorers（默认之一）= 射手榜 / 助攻榜（上游有榜的 10 个赛事）
 *                 lineups            = 比赛详情首发阵容里出现过的球员
 *                 all（默认）        = 两者并集
 *   --channel=  用哪条检索通道：
 *                 a（默认） = Wikidata `wbsearchentities`，按知名度返回前 10
 *                 b         = 服务端足员过滤（`haswbstatement:P106=Q937857`），
 *                             **专治中文/亚洲常见名**（`Li Yang` 的足员挤不进 A 的前 10）
 *                 both      = 两条都跑，候选取并集（A 在前）
 *               ⚠️ 两条通道各有独立缓存文件，互不作废 → 详见 CACHE_FILE / B_CACHE_FILE 注释。
 *               🔴 推荐节奏：先 `--channel=a` 跑一遍（覆盖欧美球员），
 *                  再 `--channel=b` 补那些「仍然没有中文名」的人。
 *
 * 为什么需要它：ESPN **全站不提供任何球员中文名**（`?lang=zh` 实测无效，
 * 见 tools/scorers.js 顶部的探测结论），所以球员汉化只能自建字典。
 * 而射手榜每个赛季都会冒出一两百个新名字，纯手工维护不现实 —— 这个脚本负责
 * 批量播种，人工只需在 `zh-names.js` 的 PLAYER_ZH 里纠错与改简称。
 *
 * ------------------------------------------------------------ 两个输入源
 * ① **射手榜**（直连 ESPN `/statistics`）—— `collectFromScorers()`。
 * ② **阵容球员池**（读 `tools/.lineup-players.json`）—— `readPool()`。
 *    这份池子由 `tools/match-detail.js` 在同步时**顺手**写下（它手里已经有 summary 的
 *    `rosters`，零额外请求），内容是「抓到了但还没有中文名」的球员 id + 全名。
 *
 *    ⚠️ 为什么必须有第二个源：阵容里 46 人里有一多半是后卫/门将，
 *       **射手榜永远覆盖不到他们**。只靠 ① 时，阵容界面上会冒出 `W. Zhen` 这类英文
 *       （实测覆盖率只有 13%）。②补上之后覆盖率才谈得上"够用"。
 *    ⚠️ 池子是**累积**的，且 `tools/` 不进包不入 git，随时可重建：
 *       一次性补齐用 `node tools/match-detail.js --force`（否则只靠新增场次慢慢长）。
 *
 * 优先级（高 → 低）：
 *   ① `zh-names.js` 的 PLAYER_ZH     —— 人工，权威，可覆盖任何自动结果
 *   ② `player-zh.js` 的 AUTO_PLAYER_ZH —— 本脚本生成，覆盖面广
 *   ③ 回落英文短名（形如 "E. Haaland"）—— 未命中，正常现象
 *
 * ------------------------------------------------------------ 取数策略
 * ⚠️ **译名优先级：Wikidata `zh-cn` → `zh-hans` → 中文维基条目标题**（见 `zhNameOf`）。
 *   ① **召回用哪条通道——改过一次、又补了一刀**（结论都在，别再来回改）：
 *      · 最早用中文维基全文检索 —— **已推翻**（搜 `Gonzalo García` 返回「加西亚·马尔克斯／百年孤独」，
 *        通道选错，后面所有闸门都是在垃圾里挑）。
 *      · 改用 Wikidata `wbsearchentities` 查**完整英文名**（不是 `shortName`）→ 欧美球员命中率 95%+。
 *      · 但它按**知名度**排序，**中文/亚洲常见名全线失效**（`Li Yang` 足员挤不进前 10）。
 *        → 补一条通道 B：`haswbstatement:P106=Q937857` 交给服务端预过滤，实测可回收 5/6。
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
/** 阵容球员池（输入源 ②）—— 由 tools/match-detail.js 写，见那里的 noteRosterPlayers */
const POOL_FILE = path.join(__dirname, '.lineup-players.json')
/**
 * 缓存格式版本。**改了检索通道 / 闸门口径就必须 +1** ——
 * 版本对不上会整份作废重抓，避免拿旧口径的结果冒充新结果。
 * 历史：1 = zhwiki 全文检索 gsrlimit 5；2 = 同上 limit 20；3 = 改用 Wikidata wbsearchentities。
 *
 * ⚠️ **通道 B 有它自己的缓存文件与版本号**（见 B_CACHE_FILE），
 *    所以加 B 不需要把这里抬到 4 —— A 的查询语句没变，它的缓存依然有效，
 *    抬版本等于让已经查过的 1300 人白查一遍（约 2.4 小时）。**两条通道各自独立失效。**
 */
const CACHE_VERSION = 3

/**
 * 通道 B（服务端足员过滤）的候选缓存。
 *
 * 独立落盘的理由见上：只让「真正需要的人」重查，而不是整份作废。
 */
const B_CACHE_FILE = path.join(__dirname, '.player-names-cache-b.json')
/** 通道 B 的缓存版本。改了 B 的查询语句（`haswbstatement` 的口径）就 +1。 */
const B_CACHE_VERSION = 1

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports'
const WD_API = 'https://www.wikidata.org/w/api.php'
const ZHWIKI_API = 'https://zh.wikipedia.org/w/api.php'
const UA = 'sports-schedule-miniprogram/1.0 (player name dictionary; contact: repo owner)'

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1]
const LIMIT = Math.max(0, Number((args.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0)
/** 输入源：all（默认）| scorers | lineups —— 见文件顶部说明 */
const SOURCE = (() => {
  const v = ((args.find((a) => a.startsWith('--source=')) || '').split('=')[1] || 'all').trim()
  return ['all', 'scorers', 'lineups'].includes(v) ? v : 'all'
})()
/**
 * 检索通道：`a`（默认，`wbsearchentities`）| `b`（服务端足员过滤）| `both`。
 *
 * 默认保持 `a` 是为了**不改变既有行为**（老缓存的语义、日志里的命中率口径都跟着变）。
 * 要捞回中文/亚洲常见名，跑 `--channel=b` —— 只查那些「还没有中文名」的人，
 * 用独立的缓存续跑，参见 `searchEntitiesBySport` 与 B_CACHE_FILE 的注释。
 */
const CHANNEL = (() => {
  const v = ((args.find((a) => a.startsWith('--channel=')) || '').split('=')[1] || 'a').trim()
  return ['a', 'b', 'both'].includes(v) ? v : 'a'
})()
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

/**
 * 阵容球员的**赛事优先级**（越靠前越先补）。
 *
 * 依据是「用户真的会点开看的比赛」：俱乐部联赛与欧战 > 中国球队 > 杯赛 > 国字号/U17/友谊赛。
 * ⚠️ **这是一张会影响成本的表**：`--limit=N` 是按池子排序切的，而池子按这张表排 ——
 *    所以表的顺序直接决定「先花出去的 1 小时买到了什么」。
 *    五大联赛/欧冠的阵容最值得汉化；欧国联与 U17 的大名单一半是观众不认识的替补，排后面。
 * 没列到的赛事排最后（原始顺序）。
 */
const COMP_RANK = [
  'ucl', 'epl', 'liga', 'seriea', 'bundesliga', 'ligue1', 'uel', 'uecl',
  'csl', 'acl', 'chn', 'nba', 'cba',
  'nations', 'asiacup', 'friendly', 'u17', 'u17w', 'worlds', 'demacia',
  'lpl', 'lck', 'kpl', 'lec', 'msi', 'agames',
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
 *    → 那类**简体字形的港台译名**改由下面的 `MANUAL_REJECT` 兜底。
 *
 * 2026-10-03 补：上一轮通道 B 捞回「湯·京治」「卡恩·凱里寧」「阿尼斯·邁赫邁蒂」，
 *    原表只有 48 字、太窄。这里按球员译名的实际用字范围补一批。
 * 🔴 **只加「繁体专用字」** —— 简繁同形的字（高/路/非/面/革…）或简体字混进来，
 *    会把正常的简体译名整片误杀。加字前逐个确认「简体写法一定不同」。
 */
const TRAD_ONLY = new RegExp(
  '[' +
  '羅爾賓貝蘭馬奧薩費華維賀蘇積龍衛頓遜謝贊亞倫齊傑納萊內魯歷聯賽國隊韋' +
  '湯凱寧邁嚴區單團園圖壓聲職聽讀語調談請諾講識議護譯豐趙躍軌載軟較輔輕輛輝輩輪輸轉' +
  '辦農適選遺鄉鄭鐘鋼錢鎮鏈鐵門閉開關陽階際隨隱難雲靜韓頂項順須預領頭題顏願類顧' +
  '風飛飯飲飾養館駐驗體麗麥黃點齒龜' +
  ']'
)
const looksTraditional = (s) => TRAD_ONLY.test(String(s || ''))

/**
 * 🔴 **人工复核后确认「不能用」的 id** —— 命中过、但译名是错的，必须挡在字典外。
 *
 * 为什么需要这张表：通道 B 只解决「必须是足球运动员」，**解决不了同名同姓**。
 * 按英文名搜出来的条目，可能是**另一个球员**，也可能是**港台译名**。
 * 用户红线是「错的比英文更糟」，所以这些宁可落回英文短名。
 *
 * 两类典型错法（2026-10-03 通道 B 首轮 43 条里，17 条中招，命中率不到六成）：
 *   ① **张冠李戴**：`Carlos Augusto` 命中卡瓦利亚尔（那是教练 Carlos Carvalhal）、
 *      `Leonardo` 命中莱昂纳多·博努奇、`Pedro Malheiro` 命中若泽·萨。
 *   ② **港台译名**：戴雅高 / 梅里路 / 湯·京治 / 盎尼·瓦拉卡里 —— 字符是简体，
 *      `looksTraditional` 抓不到，但对大陆读者等于不认识。
 *
 * ⚠️ **维护方式**：跑完 `--channel=b` 后，把日志里的 30 条抽查样本
 *    （以及 `git diff tools/player-zh.js` 出的**全部**新增）逐条核英文名与译名，
 *    确认不可用的写进这里。**不要因为"看着还行"就放行** —— 这一轮 43 条里
 *    明确错的就有 9 条，靠"看着差不多"是过不去的。
 */
const MANUAL_REJECT = new Map([
  // 张冠李戴：英文名指向的是另一个人
  ['271769', 'Carlos Augusto → 卡洛斯·卡瓦利亚尔（那是教练 Carlos Carvalhal）'],
  ['302013', 'Leonardo → 莱昂纳多·博努奇（Bonucci 是另一个人）'],
  ['324588', 'Pedro Malheiro → 若泽·萨（José Sá 是另一个人）'],
  ['165085', 'Fabiano → 路易斯·法比亚诺（多出来的 Luis 是另一个人）'],
  ['20016', 'Patrick Kelly → 连姆·凯利（Liam ≠ Patrick）'],
  ['278038', 'Benjamin Kallman → 本杰明·谢尔曼（Kallman 不是 Sherman）'],
  ['323973', 'Cristian Shpendi → 克里斯蒂安·姆彭帝（Shpendi 不是 Mpenti）'],
  ['229556', 'Yan → 提哈罗（对不上任何常见译名）'],
  // 名姓颠倒
  ['240900', 'Li Yang → 杨丽（名姓颠倒，且"杨丽"是女足球员）'],
  // 港台译名：简体字形，但大陆读者不认
  ['134169', 'Lukas Hradecky → 鲁卡斯·哈迪基（港澳译法，大陆叫赫拉德茨基）'],
  ['148515', 'Tom King → 湯·京治（香港译法，且残留繁体「湯」）'],
  ['192278', 'Diego Gómez → 戴雅高（港澳译法）'],
  ['235669', 'Kaan Kairinen → 卡恩·凱里寧（港澳译法，且残留繁体）'],
  ['277212', 'Onni Valakari → 盎尼·瓦拉卡里（港澳译法）'],
  ['296406', 'Lucas Bergstrom → 卢卡斯·贝治斯特朗（港澳译法）'],
  ['308891', 'Anis Mehmeti → 阿尼斯·邁赫邁蒂（港澳译法，且残留繁体）'],
  ['338894', 'Murillo → 梅里路（港澳译法，大陆叫穆里略）'],
])

/** 手工复核通过的样本，用来在日志里对照「什么才算能用的译名」。 */
const REVIEW_SAMPLE_OK = ['陈蒲', '魏震', '刘洋', '程进', '钟义浩', '岳鑫', '林创益', '戴伟浚', '黄晟豪']

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

/* ------------------------------------------- 输入源 ①：射手榜 / 助攻榜 */

async function collectFromScorers() {
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

/* --------------------------------------------- 输入源 ②：阵容球员池 */

/**
 * 读 `tools/.lineup-players.json`（由 tools/match-detail.js 写）。
 * ⚠️ 池子里的 `full` 就是 ESPN 的 `displayName` —— 这是关键，
 *    播种走的 `wbsearchentities` 只有拿到完整英文名才有 95%+ 命中率。
 * 读不到不是错误（比如还没跑过 match-detail），只是这个源为空。
 *
 * ⚠️ **排序即优先级**：`--limit=N` 是按这个顺序切的，所以这里按赛事价值排序 ——
 *    用户会点开的比赛（欧冠/五大联赛/中超/亚冠）排前面，
 *    欧国联/U17/友谊赛的大名单排后面。不然 `--limit` 切到的是抓取顺序，纯看运气。
 * @param {string} [file] 池子路径（默认 POOL_FILE；参数是给 smoke 测「读不到」用的）
 */
function readPool(file) {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file || POOL_FILE, 'utf8'))
  } catch (e) {
    log('⚠️ 没有阵容球员池（tools/.lineup-players.json），这个源为空。')
    log('   要补齐：node tools/match-detail.js --force')
    return []
  }
  // ⚠️ 这里读的是**映射之后**的字段名 `comps`。写成 `p.c` 的话 rank 恒为「最后一档」，
  //    sort 会变成静默的空操作 —— 池子看着有序、其实完全是抓取顺序。
  //    （smoke 有一条「池子按赛事优先级排序」专门守这个。）
  const rank = (p) => {
    const cs = (p && (p.comps || p.c)) || []
    let best = COMP_RANK.length
    cs.forEach((c) => {
      const i = COMP_RANK.indexOf(c)
      if (i > -1 && i < best) best = i
    })
    return best
  }
  return (Array.isArray(raw) ? raw : [])
    .map((p) => {
      const id = String((p && p.id) || '')
      const full = String((p && p.full) || '').trim()
      const short = String((p && p.short) || '').trim()
      return { id, full: full || short, short: short || full, comps: (p && p.c) || [] }
    })
    .filter((p) => p.id && p.full)
    .sort((a, b) => rank(a) - rank(b))
}

/** 合并两个源；同 id 以**先加入的**为准（射手榜在前：那边的 displayName 更完整） */
async function collectPlayers() {
  const out = new Map()
  const add = (list, tag) => {
    let n = 0
    list.forEach((p) => {
      if (out.has(p.id)) return
      out.set(p.id, p)
      n += 1
    })
    log(`源「${tag}」${list.length} 人，净增 ${n} 人`)
  }
  const keys = ONLY ? ONLY.split(',').map((s) => s.trim()) : null
  // 阵容池同样支持 --only 过滤（池子里记了赛事），这样「只补五大联赛」对两个源都成立
  let pool = readPool()
  if (keys) {
    const before = pool.length
    pool = pool.filter((p) => (p.comps || []).some((c) => keys.includes(c)))
    log(`阵容池按 --only=${ONLY} 过滤：${before} → ${pool.length} 人`)
  }
  if (SOURCE !== 'lineups') add(await collectFromScorers(), '射手榜 / 助攻榜')
  if (SOURCE !== 'scorers') add(pool, '阵容球员池')
  log(`两源合并后共 ${out.size} 人`)
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

/**
 * 通道 B：把「必须是足球运动员」这道闸门**交给服务端**。
 *
 * ⚠️ **为什么需要它**：通道 A 的 `wbsearchentities` 按**知名度**排序返回前 10，
 *    `Li Yang` / `Chen Pu` / `Jin Cheng` 这种中文常见名，真正的足员条目根本挤不进去，
 *    闸门看到的是 10 条同名的导演 / 研究员 / 明朝人 → 全员判负。
 *    本轮实测：688 人只命中 20%，闸门记「非人类/非足球员」1022 次，挡掉的几乎全是这类噪音。
 *    改用 CirrusSearch 的 `haswbstatement` 预过滤后，实测可回收 5/6
 *    （证据表见 `tools/probe-wd-channel.js` 与 REFERENCE.md §二）。
 *
 * ⚠️ **两点实现约定，别改错**：
 *  1. `srnamespace=0` 在 Wikidata 上就是「条目」，而条目的 **title 本身就是 QID**
 *     （`Q19840344`），所以拿到的是 QID、不需要再换一次 id。
 *     但仍要 `^Q\d+$` 过一道 —— disambiguation 之类的会在结果里混进非 Q 标题。
 *  2. 名字必须打**引号**做精确短语匹配，否则 `Li Yang` 会被拆成两个词。
 *     代价是 `M. Sierra` 这种首字母缩写名一个也搜不出来 ——
 *     所以 B 是 **A ∪ B 取并集**（A 的候选排在前面），**不是替换掉 A**。
 *
 * 返回：QID 数组（可信负结果为 `[]`）／`null`（请求失败，**不缓存**，与通道 A 同约定）。
 */
async function searchEntitiesBySport(name) {
  const q = `"${name}" haswbstatement:P106=Q937857`
  const url = `${WD_API}?action=query&list=search&srsearch=${encodeURIComponent(q)}` +
    '&srnamespace=0&srlimit=10&format=json'
  const j = await getJSON(url)
  if (!j) return null
  const list = ((j.query || {}).search) || []
  return list.map((c) => String((c && c.title) || '')).filter((t) => /^Q\d+$/.test(t))
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

  // ---- 通道 B 的缓存（独立文件、独立版本号，见 B_CACHE_FILE 的注释） ----
  const needA = CHANNEL === 'a' || CHANNEL === 'both'
  const needB = CHANNEL === 'b' || CHANNEL === 'both'
  let bStore = {}
  if (!DRY && needB) {
    try {
      const raw = JSON.parse(fs.readFileSync(B_CACHE_FILE, 'utf8')) || {}
      bStore = raw.v === B_CACHE_VERSION && raw.d ? raw.d : {}
    } catch (e) {
      bStore = {}
    }
  }
  const saveBCache = () => {
    if (DRY) return
    try {
      fs.writeFileSync(B_CACHE_FILE, JSON.stringify({ v: B_CACHE_VERSION, d: bStore }))
    } catch (e) { /* 同上，缓存写不进去不该影响主流程 */ }
  }
  const bCached = (id) => Object.prototype.hasOwnProperty.call(bStore, id)

  // ⚠️ `--channel=b` 时只查「还没有中文名」的人：A 已经给出名字的人再补一次 B
  //    对结果没有影响（A 的候选排在并集前面），却要白花 ~6.5 秒/人。
  //    这条捷径只在 needB 且不需要 A 时生效，`--channel=a` 的行为完全不变。
  const bEligible = (p) => !prev[p.id] && !manual[p.id]

  let todo = all.filter((p) => {
    const wantA = needA && !cached(p.id)
    const wantB = needB && !bCached(p.id) && (needA || bEligible(p))
    return wantA || wantB
  })
  if (LIMIT > 0 && todo.length > LIMIT) {
    log(`--limit=${LIMIT}：本轮只处理 ${LIMIT}/${todo.length} 个未查过的`)
    todo = todo.slice(0, LIMIT)
  }
  log(`检索通道 ${CHANNEL}：待查 ${todo.length} 人 / 已缓存 ${all.length - todo.length} 人` +
    `（A 缓存 ${Object.keys(cacheStore).length}，B 缓存 ${Object.keys(bStore).length}）`)

  let done = 0
  let failed = 0
  let noneFound = 0
  let bFailed = 0
  let bNoneFound = 0
  await mapPool(todo, CONC, async (p) => {
    if (needA && !cached(p.id)) {
      const qids = await searchEntities(p.full)
      if (qids === null) failed += 1
      else {
        cacheStore[p.id] = qids
        if (!qids.length) noneFound += 1
      }
      // ⚠️ 双通道时两次请求之间也要等 —— 配额是按请求数算的，连发两枪就是 2 次
      if (needB) await sleep(SLEEP)
    }
    if (needB && !bCached(p.id)) {
      const qids = await searchEntitiesBySport(p.full)
      if (qids === null) bFailed += 1
      else {
        bStore[p.id] = qids
        if (!qids.length) bNoneFound += 1
      }
    }
    await sleep(SLEEP)
    done += 1
    if (done % 50 === 0) {
      saveCache()
      saveBCache()
      log(`  已查 ${done}/${todo.length}（A 请求失败 ${failed}／无实体 ${noneFound}；` +
        `B 请求失败 ${bFailed}／无实体 ${bNoneFound}）`)
    }
  })
  saveCache()
  saveBCache()
  log(`检索完成：本轮 ${todo.length} 人（A：请求失败 ${failed}，其中无实体 ${noneFound}）`)
  if (needB) log(`　　　　　　　　　　（B：请求失败 ${bFailed}，其中无实体 ${bNoneFound}）`)

  // 候选并集：**A 的候选排在前面**，B 只做补充 —— A 是按知名度排的，多数情况下第一个就是对的，
  // 让 B 插到前面反而会把「运气好撞上」的正确条目挤掉。
  const candOf = {}
  const pushCand = (id, q) => {
    if (!q) return
    if (!candOf[id]) candOf[id] = []
    if (candOf[id].indexOf(q) === -1) candOf[id].push(q)
  }
  Object.keys(cacheStore).forEach((id) => (cacheStore[id] || []).forEach((q) => pushCand(id, q)))
  /** 只被 B 找到的 QID —— 用来统计「这一轮有多少名字是靠通道 B 捞回来的」，人工抽查用 */
  const bOnlyQids = {}
  Object.keys(bStore).forEach((id) => (bStore[id] || []).forEach((q) => {
    if (!candOf[id] || candOf[id].indexOf(q) === -1) { pushCand(id, q); bOnlyQids[q] = 1 }
  }))

  const allQids = []
  const seenQid = {}
  Object.keys(candOf).forEach((id) => candOf[id].forEach((q) => {
    if (q && !seenQid[q]) { seenQid[q] = 1; allQids.push(q) }
  }))
  log(`去重后 wikibase item ${allQids.length} 个（其中 ${Object.keys(bOnlyQids).length} 个只有通道 B 能查到），` +
    '开始批量取实体（含 zhwiki sitelink）…')

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
  let rejected = 0
  let fromB = 0
  const fromBSample = []
  const misses = []
  // 遍历 `all` 而不是本轮的 `todo` —— 缓存命中的人也要参与匹配，
  // 否则分批跑（--limit）时，前几批已经查过的人永远进不了输出。
  all.forEach((p) => {
    // 人工复核判定不可用的（张冠李戴 / 港台译名）：连查都不查。
    // ⚠️ 这里必须排在结转逻辑**之前** —— 否则上一轮已经写进字典的错名会被结转顶回来。
    if (MANUAL_REJECT.has(p.id)) { rejected += 1; return }
    let picked = ''
    // 候选是 A ∪ B 的并集（A 在前），见上面 candOf 的注释
    for (const q of candOf[p.id] || []) {
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
      if (bOnlyQids[q]) {
        fromB += 1
        if (fromBSample.length < 30) fromBSample.push(`${p.id}\t${zh}\t${p.full}`)
      }
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
  log(`闸门挡下次数：非人类/非足球员 ${notFoot}｜英文名不符 ${nameBad}｜港台译名回落英文 ${tradOnly}｜人工复核否决 ${rejected}`)
  if (fromB) {
    log(`其中 ${fromB} 人是靠通道 B（服务端足员过滤）捞回来的 —— 抽查这 30 条：`)
    fromBSample.forEach((l) => console.log('  ' + l))
  }

  // 保留上一轮里本轮没拿到的（射手上下榜会掉出集合，不该因此丢字典）
  //
  // ⚠️ **必须遍历 `prev` 的全部 key，不能只遍历本轮的 `players`。**
  //    踩过的坑：`--only=ucl,epl`（只重建两个联赛）或 `--source=lineups` 会**缩小输入集合**，
  //    而结转如果只看本轮集合，集合外那些早就查好的名字会被**整批丢掉** ——
  //    字典是只增不减的资产，不该因为一次「只重建两个联赛」就缩水。
  // ⚠️ **但只结转「看着像简体」的名字**：上一版用中文维基全文检索时留下一批港式译名
  //    （「安祖·罗拔臣」「伊斯高」「尼曼查·马迪」），面对大陆读者比英文短名更困惑。
  //    不带这道守卫，新通道查不到的那一刻就会被旧值顶住，永远换不掉。
  // ⚠️ 结转要放在匹配循环**之后**：`result` 里已有的名字不该被旧值覆盖。
  let carried = 0
  let carriedOutside = 0
  const inInput = {}
  players.forEach((p) => { inInput[p.id] = 1 })
  Object.keys(prev).forEach((id) => {
    if (!prev[id] || result[id] || manual[id]) return
    // 人工否决的 id 也不许结转回来（它可能已经在上一轮写进了字典）
    if (MANUAL_REJECT.has(id)) return
    if (looksTraditional(prev[id])) return
    result[id] = prev[id]
    cache.seenZh[prev[id]] = 1
    carried += 1
    if (!inInput[id]) carriedOutside += 1
  })
  if (carriedOutside) log(`其中 ${carriedOutside} 人来自本轮输入集合之外（保住字典不缩水）`)
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
    ' *',
    ' * 🔴 通道 A 对**中文 / 亚洲常见名**基本失效（`Li Yang`、`Chen Pu` 的足员条目挤不进前 10），',
    ' *    这类人要用通道 B 单独补一轮（只查还没有中文名的人，有独立缓存可续跑）：',
    ' *    `node tools/player-names.js --channel=b`',
    ' *',
    ' * 输入源：射手榜 / 助攻榜 + 比赛详情里的阵容球员池（tools/.lineup-players.json）。',
    ' * ⚠️ 顺序：**先 `node tools/match-detail.js --force` 把阵容池填满，再跑这个脚本**，',
    ' *    反过来的话那一轮的池子成员全都还没被查过，等于白跑一轮。',
    ' * 生成后要把中文名烘焙进数据文件才有用：',
    ' *    `node tools/scorers.js`        → data/scorers.js（射手榜）',
    ' *    `node tools/match-detail.js`   → data/match-details.js（首发阵容）',
    ' *    （`match-detail.js` 要带 `--force`，否则已结束的比赛不会重烘焙）',
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
    log('⚠️ 记得把中文名烘焙进数据文件：node tools/scorers.js 与 node tools/match-detail.js')
    log('   （前者管射手榜，后者管首发阵容；不改页面逻辑，推 GitHub 即可生效，不用发版）')
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
  COMP_RANK,
  CACHE_FILE,
  B_CACHE_FILE,
  POOL_FILE,
  CACHE_VERSION,
  B_CACHE_VERSION,
  SOURCE,
  CHANNEL,
  sleep,
  getJSON,
  searchEntities,
  searchEntitiesBySport,
  titlesToSimplified,
  zhwikiTitleOf,
  qidsToEntities,
  collectFromScorers,
  readPool,
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
