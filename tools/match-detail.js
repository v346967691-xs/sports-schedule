#!/usr/bin/env node
/**
 * 比赛详情抓取：一次 ESPN summary 请求，抽出五个模块
 *
 *   ① 事件时间轴  keyEvents    —— 进球 / 点球 / 红黄牌 / 换人，带分钟与文字描述
 *   ② 双方近况    lastFiveGames —— 两队各自最近 5 场（主客、比分、胜负）
 *   ③ 历史交锋    seasonseries  —— 近 5 次交手与总战绩
 *   ④ 技术统计    boxscore     —— 控球率 / 射门 / 射正 / 角球 / 犯规 / 传球成功率
 *   ⑤ 首发阵容    rosters      —— 两队首发 11 人 + 替补席（号码 / 位置），仅足球
 *
 * 用法：node tools/match-detail.js [--force] [--status-json=<path>]
 *   --force  连已结束的比赛也重抓一次。平常常规运行**不需要**它（已结束的抓一次就够）；
 *   --status-json=<path>
 *            用一份 `{id: {status, hs, as}}` 覆盖 `data/matches.js` 里的旧状态。
 *            供 cloud-sync 的「详情快通道」使用 —— 那时本地快照最多是 97 分钟前的，
 *            刚完赛的比赛在里头还是 live/upcoming，needsFetch 会走错分支。
 *            改过 SCHEMA 或想一次性把「阵容球员池」补齐时才用。
 * * ⚠️ 三个硬约束（改这个文件前先读）：
 *   1. **小程序不能直连 ESPN**，必须由本脚本预抓、抽取字段后落云表；
 *      绝不能把原文存下来 —— 单场 390KB，上千场会直接把云表和流量打爆。
 *   2. **必须增量抓**。已结束的比赛抓一次就够（事件不会变），只有进行中的
 *      场次需要每班重抓（比分在变）。全量抓的话一天 1~2GB 流量，会被限流。
 *      已抓过的名单从云端 match_detail 现读，不落本地文件（Actions 每次是
 *      干净 checkout，本地文件留不住）。
 *   3. 与积分榜同级别：失败只告警，绝不让赛程主链路跟着失败。
 *
 * ⚠️ ⑤ 是最贵的一块：`data/match-details.js` 是**打进包**的（包体积是稀缺资源），
 *    所以阵容只在「开赛后 48 小时内」保留，细节见 pickLineups 与 LINEUP_KEEP_DAYS。
 */
const fs = require('fs')
const path = require('path')
const https = require('https')

const zhNames = require('./zh-names')
const publicConfig = require('../utils/cloud-config')
const { decodeSnapshot } = require('../utils/snapshot')
// 位置分组规则的唯一来源（`basketPos` 就在里面，工具侧与页面侧共用一份）
const rosterView = require('../utils/roster.js')

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports'

/** 见文件顶部的 --force 说明 */
const FORCE = process.argv.slice(2).includes('--force')

/**
 * 详情快通道用的「最新状态覆盖表」（一个 JSON 文件路径）。
 *
 * 🔴 为什么需要它（2026-10-07）：本脚本从 `data/matches.js` 读比赛状态，
 *    而那份快照只在主闸放行时才被 `sync.js` 重写 —— 也就是**最多 97 分钟前**的状态。
 *    快通道（主闸跳过的班次）跑进来时，刚完赛的比赛在旧快照里还是 `live` / `upcoming`：
 *      · 判成 upcoming → needsFetch 走「12 小时刷一次」分支 → 根本不抓；
 *      · 判成 live     → 虽然会抓，但 `fin=false` 存成壳，下次还得等 2 小时补抓门槛。
 *    → 由 cloud-sync 把云端 `live_scores`（60 秒粒度的最新状态）喂进来覆盖掉。
 */
const STATUS_JSON = (function () {
  const hit = process.argv.slice(2).find((a) => a.indexOf('--status-json=') === 0)
  return hit ? hit.slice('--status-json='.length) : ''
})()
/** 只有 ESPN 源的赛事有 summary 端点；LoL / CBA / KPL 没有 */
const SLUG = {
  ucl: 'uefa.champions',
  epl: 'eng.1',
  liga: 'esp.1',
  seriea: 'ita.1',
  bundesliga: 'ger.1',
  ligue1: 'fra.1',
  nations: 'uefa.nations',
  uel: 'uefa.europa',
  uecl: 'uefa.europa.conf',
  csl: 'chn.1',
  acl: 'afc.champions',
  // 亚冠二级有中超球队（2026 赛季上海申花），详情照抓
  acl2: 'afc.cup',
  wucl: 'uefa.wchampions',
  mls: 'usa.1',
  lib: 'conmebol.libertadores',
  // ⚠️ 北美国家联赛**故意不抓详情**（与国际友谊赛同一个理由）：
  //    实测 10 天窗口 37 场 = **63KB** 包体积，是同期新增赛事里最大的一笔，
  //    而中文语境下它的「历史交锋 / 双方近况」几乎没人看。赛程 + 比分已经够用。
  //    cnl: 'concacaf.nations.league',
  asiacup: 'afc.asian.cup',
  // ⚠️ 国际友谊赛**故意不抓详情**：友谊赛密集（未来 7 天就有 40 场），而且
  //    它的「历史交锋 / 双方近况」本来就是最没参考价值的一类，
  //    实测要占 38KB 包体积（详情桶是打进包的）。赛程 + 比分已经够用。
  //    friendly: 'fifa.friendly',
  u17: 'fifa.world.u17',
  u17w: 'fifa.wworld.u17',
  nba: 'nba',
}
const BASKETBALL = { nba: true }

/**
 * 抽取结果的 schema 版本。
 * ⚠️ 改了任何 pick* 的抽取逻辑都要 +1：云端存的是「抽完的成品」，
 *    已结束的比赛只抓一次、之后永不刷新，光改代码老数据不会变。
 *    needsFetch 见到版本号不同会强制重抓一次，老数据自动淘汰。
 */
const SCHEMA = 6 // 6 = 新增 KPL 单局详情（pickKplDetail：逐局胜方 + 十名选手 + 英雄中文名）

const FINISHED_MS = 48 * 3600 * 1000 // 已结束：只补最近 48 小时
const UPCOMING_MS = 7 * 24 * 3600 * 1000 // 赛前预览：未来 7 天内开赛的也抓
const UPCOMING_REFRESH_MS = 12 * 3600 * 1000 // 未开赛的近况变化慢，12 小时刷一次就够
const KEEP_DAYS = 7 // 云端保留天数（与 RLS 的 DELETE 策略一致）
/**
 * 首发阵容的保留窗口：**保留「今天 / 昨天」两个日桶，约等于最近 48 小时**。
 * ⚠️ 这是一条**包体积红线**，别随手调大：详情桶是打进 `data/match-details.js` 的。
 *    单场阵容实测 ~1.5KB（46 人：首发 22 + 替补席 24）；旺季单日最多 43 场足球，
 *    两个日桶 ≈ 86 场 ≈ 130KB。放到 7 天就是 200+ 场、300KB+，等于白送一个半分享底图。
 *    超出窗口的桶在写文件前会把 lineups 摘掉（见主流程的 lineups 裁剪）。
 */
const LINEUP_KEEP_DAYS = 1

/**
 * NBA 单场球员数据的列名（顺序 = `stats` 数组顺序，实测 14 列）。
 * ⚠️ 存进 payload 的 `l` 字段，页面渲染前**必须**先比对这份列表 —— 上游一旦调整
 *    列顺序，值和表头就会错位（比缺数据严重得多），比对不上就整块隐藏。
 */
const BASKET_STAT_LABELS = [
  'MIN', 'PTS', 'FG', '3PT', 'FT', 'REB', 'AST', 'TO', 'STL', 'BLK', 'OREB', 'DREB', 'PF', '+/-',
]

/**
 * KPL 单局详情的**补抓**窗口。
 *
 * 🔴 事故一（2026-10-06 用户反馈）：10-05 14:00 的北京WB vs 长沙TES.A 在详情页看不到对局数据。
 *    原因：BO5 打到 16:30 才结束，而 14:22 那班去抓时上游 `round_details` 还是空的
 *    —— 于是存了一条 `kpl: null`，再叠加「已结束的比赛只抓一次」，这条**从此再也不会被重抓**，
 *    数据永久缺失（16:40 之后上游其实早就结算好了，实测现在能抓到 5 局）。
 *
 * 🔴 事故二（同日稍晚）：广州TTG 3:0 济南RW侠 只显示第 1 局。
 *    比赛还 live 的时候抓过一次（那时只打了 1 局，存了 1 局），打完后因为
 *    「prev.kpl 不是 null」而永远不重抓 → 局数缺一半。**有数据 ≠ 数据完整。**
 *
 * 🔴 事故三（2026-10-07，用户报「今天结束的足球赛事都没有进球/红黄牌/技术统计」）：
 *    **同一类问题，但不只是 KPL —— 所有赛事都一样。**
 *    比赛**还没开打时**就被抓过一次（增量规则里 upcoming 也要抓，为了拿交锋/近况），
 *    那一刻 `events` / `stats` 是空的、`box` 是 null，payload 里 `fin: false`。
 *    等它打完，`needsFetch` 的「已结束 → 不重抓」直接把它锁死 → **永远补不回来**。
 *    实测：10-07 那批欧国联的 payload 抓于 10-06 22:31（开赛前 4 小时），
 *    events=[] / stats=[] / box=null，用户在详情页什么都看不到。
 *
 * → 三类壳数据都要补抓（空值 / 局数不足 / 未结束时抓的空壳），统一控制代价：
 *   · 只在开赛后 `RETRY_WINDOW_MS` 内重试（超出就认了，再往后桶也要过期了）
 *   · 每 `RETRY_GAP_MS` 才试一次（不跟着 15 分钟一班白打上游）
 *   · 「局数不足」的判据：已存局数 < 双方最终比分之和（3:0 → 该有 3 局）。
 *     比分本身也可能滞后（那轮快照里还是 1:0）→ 比分补齐后的下一轮自然触发。
 *   · 「未结束时抓的空壳」判据：`prev.fin === false`（抓那一刻比赛还没结束）。
 *     ⚠️ 必须是 `=== false` 而不是 `!== true`：老 payload 里没有 fin 字段（undefined），
 *        用 `!== true` 会把所有历史数据都判成要重抓，请求量直接翻几倍。
 *     补抓一次后 fin 就变 true，不会反复打上游 —— 加的请求量约等于「完赛场次数」。
 *
 * 🔴 事故四（2026-10-07 全盘体检发现，**与前三类都不同，且是防御性的**）：
 *    上面三类的 `fin` 语义是「抓那一刻比赛是否已结束」，但**它并不代表抓到了内容**。
 *    于是存在第四种壳：请求本身"成功"了（没抛错、JSON 合法），但上游返回的是一份
 *    **残缺响应** —— header 有、boxscore / plays / head2head 全没有（ESPN 偶发，
 *    尤其 `--force` 一次性重抓上百场被限流时）。它的 `fin` 照样是 true →
 *    前面三类判据全部不成立 → **永久锁死，永远不会重抓**。
 *
 *    ⚠️⚠️ 排查结论要如实记下来（别让下一个人再查一遍）：
 *    最初怀疑的实证案例 —— 10-05 的 `nba-401914127`（掘金 97-109 爵士）与
 *    `nba-401918010`（快船 104-101 勇士）在包里确实是全空壳 —— **后来查明不是残缺响应**，
 *    而是下面「box / lineups 裁剪」的正常结果：这两场在 `d-20261005` 桶，
 *    超过 `LINEUP_KEEP_DAYS`，`box` 在推送前被主动摘掉了，球员数据当天存在过。
 *    所以事故四目前**没有实证案例**，属于防御性补丁 —— 但代价极低，留着。
 *
 * → 两道补丁：
 *   · **写入侧**：已完赛的比赛若 `hasContent()` 为假，视为抓取失败（返回 null），
 *     不覆盖云端已有的旧值，也不制造新的永久空壳。
 *   · **读取侧**：`needsFetch` 增加第 ④ 类 —— 已完赛且 `prev` 是空壳 → 补抓。
 *     ⚠️ 窗口是 **24h**（不是前面三类的 48h），且必须小于 `lineups` 裁剪窗口，
 *       否则会把「被裁掉 box 的老桶」误判成残缺响应而反复重抓，详见 needsFetch 内注释。
 *
 * ⚠️ 顺带记一条**容易误判为 bug 的设计**：`lineups` / `box` 只保留 `LINEUP_KEEP_DAYS` 天，
 *    超期的桶在推送前会被摘掉这两块（包体积红线，见下方 `staleLineups`）。
 *    表现是「NBA 比赛完赛一天后，详情页的球员数据整块消失」—— 这是刻意的，不是数据丢了。
 */
const RETRY_WINDOW_MS = 48 * 3600 * 1000
const RETRY_GAP_MS = 2 * 3600 * 1000
// 第 ④ 类（全空壳）的窗口比上面三类短：见 needsFetch 里与 box/lineups 裁剪的冲突说明
const EMPTY_RETRY_WINDOW_MS = 24 * 3600 * 1000

/* ------------------------- 阵容球员池（给球员字典播种） -------------------------
 *
 * 这里抓 summary 时，手里那份 `rosters` 已经含**每位球员的 id + 全名 + 短名**，
 * 而球员汉化字典（tools/zh-names.js）的自动播种器需要「ESPN athlete id + 完整英文名」才能干活
 * ——完整英文名是关键：Wikidata 的 `wbsearchentities` 对 `W. Zhen` 这种缩写几乎搜不到，
 * 对 `Wang Zhen` 才有效（结论见 tools/player-names.js 顶部）。
 *
 * 所以顺手把「还没中文名的球员」攒进一份侧产物，**零额外上游请求**。
 * 为什么不在播种器里自己抓：那要重新下载 80+ 份 390KB 的 summary，纯属浪费；
 * 而同步任务本来就每 15 分钟跑一次，池子自然越跑越全。
 *
 * ⚠️ 这是**构建期侧产物**：`tools/` 与它一起不进小程序包，也不入 git（见 .gitignore）。
 *    它只是播种器的输入，随时可以重建。
 * ⚠️ **`--force` 才会重抓已结束的比赛**（见 needsFetch）—— 平时池子只靠新增场次长；
 *    想一次性把池子补齐，用 `node tools/match-detail.js --force`。
 */
const PLAYER_POOL_FILE = path.join(__dirname, '.lineup-players.json')

/** 本轮见到的「还没中文名」的球员：id → { id, full, short } */
const playerPool = new Map()

/**
 * 把 summary 里两队名单的球员记进池子。
 * @param {Object} j  ESPN summary 原文
 * @param {Map} [into] 目标容器（默认模块内的池子）。**留出这个参数是为了 smoke 能测** ——
 *                     否则测它就得污染真实池子。
 * @param {string} [comp] 这场属于哪个赛事。**要记下来**，播种器才能按赛事排优先级：
 *                     五大联赛/欧冠的球员值得先补，欧国联/U17 的替补席排在后面。
 * @returns {number} 容器当前大小
 */
function noteRosterPlayers(j, into, comp) {
  const sink = into || playerPool
  const rs = Array.isArray(j && j.rosters) ? j.rosters : []
  rs.forEach((r) => {
    ((r && r.roster) || []).forEach((p) => {
      const a = (p && p.athlete) || {}
      const id = String(a.id || '')
      if (!id) return
      const hit = sink.get(id)
      if (hit) {
        // 同一个球员会横跨多个赛事（俱乐部 + 国家队），把赛事并起来
        if (comp && hit.c.indexOf(comp) === -1) hit.c.push(comp)
        return
      }
      const full = String(a.displayName || '').trim()
      const short = String(a.shortName || '').trim()
      if (!full && !short) return
      // 已经有中文名的不用进池 —— 播种器不需要，池子也能小一半
      if (zhNames.playerZh(id)) return
      sink.set(id, { id, full: full || short, short: short || full, c: comp ? [comp] : [] })
    })
  })
  return sink.size
}

/**
 * 把本轮池子并进磁盘上的旧池（**并集**，不覆盖）：历史场次的球员不该因为这场没上而丢掉。
 * ⚠️ 赛事列表也要取并集 —— 否则这轮没碰到的那支队会把赛事标签弄丢，优先级就排错了。
 * @param {string} [file] 目标路径（默认 PLAYER_POOL_FILE；参数是给 smoke 测并集用的）
 */
function savePlayerPool(file) {
  const target = file || PLAYER_POOL_FILE
  if (!playerPool.size) {
    console.log('[match-detail] 本轮没有新增待汉化球员')
    return 0
  }
  const merged = new Map()
  try {
    const prev = JSON.parse(fs.readFileSync(target, 'utf8'))
    ;(Array.isArray(prev) ? prev : []).forEach((p) => {
      const id = String((p && p.id) || '')
      if (id) merged.set(id, p)
    })
  } catch (e) { /* 首次运行：没有旧池 */ }
  playerPool.forEach((v, k) => {
    const old = merged.get(k)
    if (!old) { merged.set(k, v); return }
    const c = Array.isArray(old.c) ? old.c.slice() : []
    ;(v.c || []).forEach((x) => { if (c.indexOf(x) === -1) c.push(x) })
    merged.set(k, Object.assign({}, old, v, { c }))
  })
  try {
    fs.writeFileSync(target, JSON.stringify([...merged.values()]), 'utf8')
    console.log(`[match-detail] 阵容球员池：本轮新增 ${playerPool.size} 人 → 池内共 ${merged.size} 人（${path.basename(target)}）`)
  } catch (e) {
    console.warn('[match-detail] 球员池写盘失败（不影响详情）', e && e.message)
  }
  return merged.size
}

/* ---------------------------- 事件：过滤与汉化 ---------------------------- */

/**
 * ESPN 的 keyEvents 里有大量噪音：一场比赛约 1/4 是 "Start Delay" / "End Delay"，
 * 还有 Kickoff / Halftime / Start 2nd Half / End Regular Time 这类结构性节点。
 * 只留真正的关键事件：进球（含点球、乌龙）、红黄牌、换人、点球罚失。
 */
function keepEvent(k) {
  const t = String((k && k.type && k.type.text) || '')
  if (!t) return false
  if (/delay/i.test(t)) return false
  if (/kickoff|halftime|half time|start 2nd half|end regular|full.?time|end of|period/i.test(t)) return false
  if (k.scoringPlay) return true
  return /goal|card|substitution|penalty/i.test(t)
}

const EVENT_ZH = [
  [/missed penalty|penalty (missed|saved)|saved penalty/i, '点球罚失'],
  [/own goal/i, '乌龙球'],
  [/penalty/i, '点球'],
  [/header/i, '头球'],
  [/volley/i, '凌空'],
  [/free kick/i, '任意球'],
  [/^goal/i, '进球'],
  [/second yellow/i, '两黄变红'],
  [/red card/i, '红牌'],
  [/yellow card/i, '黄牌'],
  // 「VAR 介入后把黄牌升级成红牌」—— 比赛回顾里算一张红牌，但上游给的是独立句式；
  // 落在 `/yellow card/i` 之后、这里之前的顺序别动：它同时含 "Card" 与 "Red"。
  [/var.*card upgrade|card upgrade/i, 'VAR 改判红牌'],
  [/substitution/i, '换人'],
]

function zhEvent(t) {
  const s = String(t || '')
  for (const [re, zh] of EVENT_ZH) if (re.test(s)) return zh
  return null
}

/**
 * ESPN 的事件描述是英文整句（"Kenny Kindle (Liechtenstein) is shown the yellow card"），
 * 塞进中文界面很难看，而且一条几十字节、上千条会撑大 payload。
 * 这里只抽最关键的那一小段：换人抽「谁换下谁」，其余抽「球员名」。
 */
function briefOf(text, type) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  const sub = raw.match(/^Substitution,[^.]*\.\s*(.+?)\s+replaces\s+(.+?)\.?$/i)
  // 换人常带 "because of an injury" 尾巴，截掉
  if (sub) {
    const inn = sub[1].trim()
    const out = sub[2].trim().replace(/\s+because of an injury$/i, '')
    return `${inn} 换下 ${out}`
  }
  const who = raw.match(/([A-Z][\p{L}\p{M}'’\-\. ]{1,28}?)\s*\([^)]{2,40}\)/u)
  if (who) return who[1].trim()
  return raw.length > 40 ? `${raw.slice(0, 38)}…` : raw
}

/* ------------------------------ 技术统计 ------------------------------ */

/** 只挑球迷真正会看的几项，并且顺序固定（主队在前） */
const STAT_ROWS = [
  ['possessionPct', '控球率', (v) => `${Number(v).toFixed(1)}%`],
  ['totalShots', '射门'],
  ['shotsOnTarget', '射正'],
  ['wonCorners', '角球'],
  ['foulsCommitted', '犯规'],
  ['yellowCards', '黄牌'],
  ['redCards', '红牌'],
  ['offsides', '越位'],
  ['passPct', '传球成功率', (v) => `${Math.round(Number(v) * 100)}%`],
]

/* ------------------------------- 抓取 ------------------------------- */

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        let d = ''
        res.on('data', (c) => { d += c })
        res.on('end', () => {
          try { resolve(JSON.parse(d)) } catch (e) { reject(e) }
        })
      })
      .on('error', reject)
  })
}

/**
 * KPL 官方接口是 POST + JSON body。
 * 🔴 必须带这三个头，否则 404（结论见 REFERENCE §十五，2026-10-05 实测）：
 *    `User-Agent`(Chrome) + `Referer: https://kpl.qq.com/` + `Origin: https://kpl.qq.com`
 */
const KPL = 'https://kplshop-op.timi-esports.qq.com/kplow'
const KPL_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Referer: 'https://kpl.qq.com/',
  Origin: 'https://kpl.qq.com',
  'Content-Type': 'application/json',
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const payload = JSON.stringify(body || {})
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: Object.assign({ 'Content-Length': Buffer.byteLength(payload) }, KPL_HEADERS),
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        let d = ''
        res.on('data', (c) => { d += c })
        res.on('end', () => {
          try { resolve(JSON.parse(d)) } catch (e) { reject(e) }
        })
      }
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}


async function mapLimit(items, limit, worker) {
  const out = []
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i
        i += 1
        out[idx] = await worker(items[idx], idx)
      }
    })
  )
  return out
}

/* --------------------------- 抽取：单场比赛 --------------------------- */

/**
 * 队名索引：lastFiveGames 只给了对手的 id，没有名字，直接查会出空字符串。
 * 从本地快照里把所有出现过的队（id → 中文名/英文名）建一张表兜底。
 */
let TEAM_IDX = {}
function buildTeamIndex(list) {
  const idx = {}
  ;(list || []).forEach((m) => {
    ;['home', 'away'].forEach((side) => {
      const t = m[side]
      if (!t || !t.id) return
      const id = String(t.id)
      if (!idx[id]) idx[id] = zhNames.espnZh(id) || t.zh || t.name || ''
    })
  })
  TEAM_IDX = idx
}

function teamZh(id, fallback) {
  return (
    zhNames.espnZh(String(id)) ||
    TEAM_IDX[String(id)] ||
    zhNames.nameZh(fallback) ||
    fallback ||
    ''
  )
}

function pickEvents(j, homeId) {
  const list = Array.isArray(j.keyEvents) ? j.keyEvents : []
  return list
    .filter(keepEvent)
    .map((k) => {
      const raw = String((k.type && k.type.text) || '')
      return {
        m: String((k.clock && k.clock.displayValue) || ''),
        t: zhEvent(raw) || raw,
        s: briefOf(k.text, zhEvent(raw)),
        side: k.team ? (String(k.team.id) === String(homeId) ? 'home' : 'away') : '',
        goal: !!k.scoringPlay,
      }
    })
    .filter((e) => e.t)
}

function pickForm(j) {
  const out = {}
  ;(Array.isArray(j.lastFiveGames) ? j.lastFiveGames : []).forEach((g) => {
    const tid = String(g.team && g.team.id)
    const list = (g.events || []).slice(0, 5).map((e) => {
      const isHome = String(e.homeTeamId) === tid
      // ⚠️ 对手名不在 homeTeamId/awayTeamId 里，而在 opponent 对象里（有 id + displayName）
      const opp = e.opponent || {}
      const sc = String(e.score || '')
      return {
        at: isHome ? '主' : '客',
        opp: teamZh(opp.id, opp.displayName),
        sc,
        r: String(e.gameResult || ''),
      }
    })
    out[tid] = list
  })
  return out
}

/** 交锋记录只认已结束的：ESPN 会把「已排定未开赛」的比赛也算进 seasonseries（比分 0-0） */
function isPlayed(e) {
  return !!(e && e.statusType && e.statusType.state === 'post')
}

function pickH2H(j) {
  const ss = (Array.isArray(j.seasonseries) ? j.seasonseries : [])[0]
  if (!ss) return null
  return {
    // ESPN 的 summary 是英文整句（"AZE leads series 2-0-1"），直接用会中英混排。
    // 战绩改成自己从交手列表里数，标题也改成「近 N 次交手」——所见即所列，不会前后矛盾。
    // ⚠️ seasonseries 里混着「本赛程已排定但还没打」的未来比赛（比分 0-0），
    //    赛季初尤其多，直接显示会被当成数据错误 —— 只保留 state==='post' 的。
    list: (ss.events || []).filter(isPlayed).slice(0, 5).map((e) => {
      const cs = e.competitors || []
      const h = cs.find((c) => c.homeAway === 'home') || cs[0] || {}
      const a = cs.find((c) => c.homeAway === 'away') || cs[1] || {}
      return {
        d: String(e.date || '').slice(0, 10),
        ho: teamZh(h.team && h.team.id, h.team && h.team.displayName),
        ao: teamZh(a.team && a.team.id, a.team && a.team.displayName),
        hs: String(h.score == null ? '' : h.score),
        as: String(a.score == null ? '' : a.score),
      }
    }),
  }
}

function pickStats(j, homeId) {
  const teams = (j.boxscore && j.boxscore.teams) || []
  const stat = (t, key) => {
    const s = ((t && t.statistics) || []).find((x) => x.name === key)
    return s ? s.displayValue : null
  }
  const home = teams.find((t) => t.team && String(t.team.id) === String(homeId)) || teams[0]
  const away = teams.find((t) => t.team && String(t.team.id) !== String(homeId)) || teams[1]
  if (!home || !away) return []
  const rows = []
  STAT_ROWS.forEach(([key, label, fmt]) => {
    const hv = stat(home, key)
    const av = stat(away, key)
    if (hv == null || av == null || hv === '' || av === '') return
    rows.push({ k: label, h: fmt ? fmt(hv) : String(hv), a: fmt ? fmt(av) : String(av) })
  })
  return rows
}

/**
 * 位置归组：ESPN 给的是**很细的位置**（Goalkeeper / Center Left Defender /
 * Left Back / Center Left Midfielder / Center Left Forward / Substitute），
 * 缩写是 `G` / `CD-L` / `LB` / `CM-L` / `CF-R` / `SUB`（同一支队能出 11 种不同值）。
 * 中文界面用不到这么细，而且一一映射要维护一张表 —— 统一归成 4 组，
 * 首发按「门将 → 后卫 → 中场 → 前锋」排就是这个顺序。
 * ⚠️ 判定顺序不能乱：`/back/` 要在 `/midfielder/` 之前（"Left Back" 里没有 midfielder，
 *    但 "Defensive Midfielder" 里也没有 defender —— 两者其实不冲突，仍然按最具体的先判）。
 */
function posGroup(raw) {
  const s = String(raw || '')
  if (!s) return ''
  if (/goalkeeper/i.test(s)) return 'G'
  if (/defender|\bback\b/i.test(s)) return 'D'
  if (/midfielder/i.test(s)) return 'M'
  if (/forward|striker|winger/i.test(s)) return 'F'
  return ''
}

/* ------------------------------ 首发阵容 ------------------------------ */

/**
 * 首发阵容：summary 的 `rosters` 里两队各 22~25 人，`starter` 标出首发 11 人。
 *
 * ⚠️ 三个刻意的取舍（改这里前先想清楚，每条都有实测依据）：
 *  1. **没有首发标记就整个返回 null**。实测未开赛的比赛**也会**返回 rosters，
 *     但 `starter` 全是 0 —— 那只是一份 23 人大名单，没有"首发"这层信息。
 *     而快照里 45 天前向窗口有 600+ 场待开赛，全存会把包撑爆。
 *     所以「无首发 → 不存」，这个功能天然只覆盖已开踢的比赛。
 *  2. **姓名内联，不存 athlete id 引用查表**。7 天窗口里同一支队最多打 2 场，
 *     去重省不下多少；内联反而让页面零查表、payload 自解释。
 *  3. **位置只存归组后的 1 个字母**（G/D/M/F，见 posGroup）。
 *  姓名优先取中文名（`tools/zh-names.js` 按 ESPN athlete id 查，
 *  与射手榜共用同一套字典与自动播种），查不到回落英文短名 ——
 *  **中英混排是预期内的正常状态，不要改成留空**。
 *  NBA 的 summary 没有 rosters，这里自然返回 null，页面会整块隐藏。
 */
function pickLineups(j, homeId) {
  const rs = Array.isArray(j.rosters) ? j.rosters : []
  if (rs.length < 2) return null
  const one = (r) =>
    ((r && r.roster) || [])
      .map((p) => {
        const a = p.athlete || {}
        const name = zhNames.playerZh(a.id) || String(a.shortName || a.displayName || '')
        if (!name) return null
        const row = { n: name }
        if (p.jersey) row.j = String(p.jersey)
        const pos = posGroup(p.position && (p.position.name || p.position.displayName))
        if (pos) row.p = pos
        if (p.starter) row.st = 1
        return row
      })
      .filter(Boolean)
  // 优先按队伍 id 认主客；认不出来就退回 ESPN 给的顺序（home 在前）
  const home = rs.find((r) => String((r.team && r.team.id) || '') === String(homeId)) || rs[0]
  const away = rs.find((r) => r !== home) || rs[1]
  const H = one(home)
  const A = one(away)
  if (!H.some((x) => x.st) || !A.some((x) => x.st)) return null
  return { home: H, away: A }
}

/**
 * NBA 单场球员数据：`summary.boxscore.players`。
 *
 * 🔴 为什么非得单独抽一份：足球那套 `pickStats` 用的是**足球字段**
 *    （控球率/射门/角球…），而 NBA 的 `boxscore.teams[].statistics` 只有
 *    `streak` / `avgPointsAgainst` 两项 → 一项都匹配不上 → **NBA 详情页技术统计恒为空**。
 *    球员维度的数据在 `boxscore.players` 里，是另一棵树。
 *
 * ⚠️ 三个刻意的取舍（都是包体积/正确性实测出来的）：
 *  1. **未开赛的比赛没有 `boxscore.players`**（上游只给 `boxscore.teams`）→ 返回 null，
 *     页面整块隐藏。所以这个功能天然只覆盖**已结束**的比赛。
 *  2. **没上场的球员不存**（`didNotPlay` 或 MIN=0）。一场 NBA 报名 19 人、实际出场 13 人左右，
 *     剔除 DNP 能省掉三分之一体积，而「谁没上场」对读者没有价值。
 *  3. **14 列合成一个 `|` 分隔的字符串**。JSON 里 14 个数组元素要带 14 组引号和逗号，
 *     压成一行能省一半字节 —— 页面 split('|') 就能还原。
 *  4. 位置走 `utils/roster.js` 的 `basketPos()`（G/F/C → BG/BF/BC），
 *     **不复用足球的 posGroup** —— 足球的 `G` 是门将、篮球的 `G` 是后卫。
 */
function pickBasketballPlayers(j, homeId) {
  const ps = (j && j.boxscore && j.boxscore.players) || []
  if (ps.length < 2) return null
  const one = (p) => {
    const seg = ((p && p.statistics) || [])[0] || {}
    const labels = seg.labels || []
    if (labels.join(',') !== BASKET_STAT_LABELS.join(',')) return null
    return (seg.athletes || [])
      .map((a) => {
        if (!a || a.didNotPlay) return null
        const st = (a.stats || []).map((v) => String(v == null ? '' : v))
        if (st.length !== BASKET_STAT_LABELS.length) return null
        if (!st[0] || st[0] === '0') return null // MIN = 0，没上场
        const ath = a.athlete || {}
        const name = zhNames.playerZh(ath.id) || String(ath.shortName || ath.displayName || '')
        if (!name) return null
        const row = { n: name, s: st.join('|') }
        if (ath.jersey) row.j = String(ath.jersey)
        const pos = rosterView.basketPos(ath.position)
        if (pos) row.p = pos
        if (a.starter) row.t = 1
        return row
      })
      .filter(Boolean)
  }
  const home = ps.find((p) => String((p.team && p.team.id) || '') === String(homeId)) || ps[0]
  const away = ps.find((p) => p !== home) || ps[1]
  const H = one(home)
  const A = one(away)
  if (!H || !A || (!H.length && !A.length)) return null
  return { l: BASKET_STAT_LABELS, home: H, away: A }
}

/**
 * 定位 ESPN 端点用的联赛 slug。
 * 单一来源赛事（五大联赛/欧冠/中超/NBA）直接查 SLUG 表；
 * 多来源赛事（中国国字号）没有固定 slug，由 sync.js 在抓取时写进比赛对象。
 */
function resolveSlug(m) {
  return m.slug || SLUG[m.comp] || null
}

/**
 * 这个赛事会不会抓详情（= 有没有可用的 summary 端点）。
 * `chn` 是唯一的多来源赛事，它每场比赛自带 slug，所以特殊放行。
 *
 * ⚠️ 用途是**清理「以前抓过、现在不要了」的赛事**（比如国际友谊赛）：
 *    详情桶是按天存的，历史行在接下来的推送里会一直被带上去，
 *    光把 `SLUG` 里的键删掉，云端老数据不会消失（详情桶是打进包的，占体积）。
 */
function detailCapable(comp) {
  return !!SLUG[comp] || comp === 'chn' || comp === 'kpl'
}

/**
 * 这份详情里**有实质内容吗**（事故四的判据，详见文件头）。
 *
 * 判的是"有没有任何一块非空"，不是"全不全"：
 *   足球已完赛 → events / stats / lineups 至少有一块非空；
 *   篮球已完赛 → box（boxscore.players）非空（⚠️ NBA 的 `stats` 恒为空，见 pickBasketballPlayers 注释，
 *                所以**不能**拿 stats 当篮球的唯一判据）；
 *   KPL 已完赛  → kpl.list 非空；
 *   未开赛      → 至少还有 form / h2h（ESPN 赛前也给 lastFiveGames / seasonseries）。
 *
 * ⚠️ 只对**已完赛**的比赛用。未开赛的比赛本来就没有 events/stats/box，
 *    有些新赛季首轮连 form/h2h 都没有，判成空壳会让它被无休止地重抓。
 */
function hasContent(d) {
  if (!d) return false
  if (Array.isArray(d.events) && d.events.length) return true
  if (Array.isArray(d.stats) && d.stats.length) return true
  if (d.box) return true
  if (d.lineups) return true
  if (d.kpl && Array.isArray(d.kpl.list) && d.kpl.list.length) return true
  if (d.h2h && Array.isArray(d.h2h.list) && d.h2h.list.length) return true
  const f = d.form || {}
  if ((Array.isArray(f.home) && f.home.length) || (Array.isArray(f.away) && f.away.length)) return true
  return false
}

/* --------------------------- KPL 单局详情 ---------------------------
 *
 * KPL 没有 ESPN summary，走官方 `getScheduleDetail`：
 *   `round_details[]` 每局给 round / win_team / win_team_name / vid / players[10]。
 *   `data.players[]`（12 人 = 10 首发 + 替补）才有**选手中文名 / 真名 / 头像**，
 *   round_details 里只有 playerid —— 所以两份要合起来用。
 *
 * 🔴 参数陷阱：`scheduleid` 与 `seasonid` **必须同时传**，只传一个 → `10020003`。
 *    scheduleid 从比赛 id 前缀还原（`kpl-KPL2026S3M1W1D1`），seasonid 在 sync.js 写进比赛对象。
 *
 * 体积刻意压到 ~2.5KB/场（BO5 实测 4.0KB）：英雄名与选手名按 id 去重成字典，
 * picks 只存 `(playerid, hero_id)`；头像/图标是 URL，**页面端拼接，不落库**。
 */
function pickKplDetail(j, m) {
  const data = (j && j.data) || {}
  const rounds = data.round_details || []
  if (!rounds.length) return null
  const homeId = (m.home && m.home.id) || ''
  const awayId = (m.away && m.away.id) || ''
  const sideOf = (teamId) => (teamId === homeId ? 'h' : teamId === awayId ? 'a' : '')

  const heroes = {}
  const people = {}
  const picks = []
  const list = rounds.map((r) => {
    picks.push(
      ((r && r.players) || []).map((p) => {
        const hid = Number(p && p.hero_id) || 0
        if (hid && p.hero_name && !heroes[hid]) heroes[hid] = p.hero_name
        const pid = String((p && p.playerid) || '')
        if (pid && !people[pid]) people[pid] = { q: Number(p && p.position) || 0 }
        return { i: pid, h: hid }
      })
    )
    return {
      n: Number(r.round) || 0,
      w: r.win_team_name || '',
      s: sideOf(r.win_team),
      v: r.vid || '',
    }
  })
  ;(data.players || []).forEach((p) => {
    const pid = String((p && p.playerid) || '')
    if (!pid) return
    const o = people[pid] || (people[pid] = { q: Number(p.position) || 0 })
    if (p.player_name_short) o.n = p.player_name_short
    if (p.player_name_real) o.r = p.player_name_real
    if (p.player_icon) o.av = p.player_icon
    if (p.team_id) o.t = sideOf(p.team_id)
  })
  return { list, picks, people, heroes }
}

async function fetchKplDetail(m) {
  const scheduleid = String(m.id).replace(/^kpl-/, '')
  const seasonid = m.seasonid || ''
  // 只传一个会被上游当成「查不到」，而且**不传参时返回「默认最新一场」看起来像成功**
  // —— 宁可跳过也不存错数据（用户红线：宁可不要，也不要错的）
  if (!scheduleid || !seasonid) return null
  const j = await postJSON(`${KPL}/getScheduleDetail`, { scheduleid, seasonid })
  return {
    id: m.id,
    comp: m.comp,
    fin: m.status === 'finished',
    v: SCHEMA,
    ts: Date.now(),
    kpl: pickKplDetail(j, m),
  }
}

async function fetchDetail(m) {
  const slug = resolveSlug(m)
  if (!slug) return null
  const sport = BASKETBALL[m.comp] ? 'basketball' : 'soccer'
  const eid = String(m.id).split('-').pop()
  const j = await getJSON(`${ESPN}/${sport}/${slug}/summary?event=${eid}`)
  // 顺手把阵容里「还没中文名」的球员攒进池子（**零额外上游请求**），给 tools/player-names.js 播种用。
  // 副作用写在这里是因为只有这个函数手里有原始 summary；失败（null）时它是空操作。
  // 带上 m.comp：播种器据此按赛事排优先级（联赛/欧冠的球员比欧国联替补席值得先补）。
  noteRosterPlayers(j, null, m.comp)
  const homeId = m.home && m.home.id
  const awayId = m.away && m.away.id
  const form = pickForm(j)
  const h2h = pickH2H(j)
  if (h2h) {
    const hz = teamZh(homeId, m.home && m.home.name)
    const az = teamZh(awayId, m.away && m.away.name)
    let hw = 0
    let aw = 0
    let d = 0
    h2h.list.forEach((e) => {
      const hs = Number(e.hs)
      const as = Number(e.as)
      if (!Number.isFinite(hs) || !Number.isFinite(as)) return
      if (hs === as) { d += 1; return }
      const homeWon = hs > as
      const ourSide = e.ho === hz ? 'h' : (e.ho === az ? 'a' : '')
      if (ourSide === 'h') { if (homeWon) hw += 1; else aw += 1 }
      else if (ourSide === 'a') { if (homeWon) aw += 1; else hw += 1 }
    })
    const parts = []
    if (hw) parts.push(`${hz} ${hw} 胜`)
    if (aw) parts.push(`${az} ${aw} 胜`)
    if (d) parts.push(`${d} 平`)
    h2h.total = h2h.list.length
    h2h.summary = parts.length ? `近 ${h2h.list.length} 次交手 ${parts.join(' · ')}` : ''
  }
  const out = {
    id: m.id,
    comp: m.comp,
    fin: m.status === 'finished',
    v: SCHEMA, // 抽取逻辑版本，变了就重抓一次
    ts: Date.now(), // 抓取时刻：未开赛的场次据此判断要不要刷新
    events: pickEvents(j, homeId),
    form: { home: form[String(homeId)] || [], away: form[String(awayId)] || [] },
    h2h,
    stats: pickStats(j, homeId),
    lineups: pickLineups(j, homeId),
    // 🔴 只有篮球有（足球的球员维度数据在 `rosters` 里，已由 lineups 覆盖）
    box: BASKETBALL[m.comp] ? pickBasketballPlayers(j, homeId) : null,
  }
  // 🔴 事故四（写入侧）：已完赛却一块内容都没有 = 上游给了残缺响应，
  //    当成失败返回 null —— 这样既不会覆盖云端已有的好数据，也不会造出新的永久空壳。
  if (out.fin && !hasContent(out)) return null
  return out
}

/* --------------------------- 云端已抓名单 --------------------------- */

/**
 * 从云端读回已经抓过的比赛，避免重复下载。
 * 只读，失败就当作「全部没抓过」——最坏情况是多抓一轮，不会出错。
 */
async function loadCaptured() {
  const captured = {}
  const buckets = {}
  try {
    const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk')
    const cloud = createWorkBuddyCloud({
      endpoint: publicConfig.endpoint,
      publishableKey: publicConfig.publishableKey,
    })
    const { data } = await cloud.database.from('match_detail').select('id, day, payload')
    ;(data || []).forEach((row) => {
      buckets[row.id] = { day: row.day, payload: row.payload || {} }
      Object.keys(row.payload || {}).forEach((k) => {
        if (row.payload[k]) captured[k] = row.payload[k]
      })
    })
  } catch (err) {
    console.warn('[match-detail] ⚠ 读云端已抓名单失败，本次按全量抓：', (err && err.message) || err)
  }
  return { captured, buckets }
}

/* ------------------------------- 主流程 ------------------------------- */

function dayKey(iso) {
  // 统一按北京时间归档，与小程序展示口径一致
  const d = new Date(new Date(iso).getTime() + 8 * 3600 * 1000)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

/**
 * 判断这场要不要重新抓 —— 全量重抓的话一天 1~2GB 流量会被 ESPN 限流
 *   进行中：每班重抓（比分在变）
 *   已结束：抓一次就够（事件不会变）
 *   未开赛：12 小时一次（近况/交锋变化慢，而且赛前 ESPN 也没更多东西可给）
 */
function needsFetch(m, captured) {
  // --force：连已结束的比赛也重抓（改过 SCHEMA 或要补齐阵容球员池时用）
  if (FORCE) return true
  if (m.status === 'live' || m.status === 'inprogress') return true
  const prev = captured[m.id]
  if (!prev) return true
  // 老版本抽出来的数据（比如早期没过滤未开赛交锋）强制重抓一次
  if (prev.v !== SCHEMA) return true
  if (m.status === 'finished') {
    // 🔴 补抓四类「壳数据」（详见文件头注释）：
    //   ① 所有赛事：抓的时候比赛还没结束（prev.fin === false）→ 打完必须补一次
    //   ② KPL：空值（上游结算延迟，抓早了 round_details 是空的）
    //   ③ KPL：局数不足（live 时抓过一次只存了已打完的局）
    //   ④ 所有赛事：已完赛但整份 payload 一块内容都没有（上游残缺响应，事故四）
    //   ⚠️ 不能每班都试（15 分钟一次太浪费）→ 开赛 48 小时内、每 2 小时补一次，过期认了。
    const t = Date.parse(m.start)
    const inWindow = Number.isFinite(t) && Date.now() - t < RETRY_WINDOW_MS
    const gapOk = Date.now() - (prev.ts || 0) > RETRY_GAP_MS
    if (!inWindow || !gapOk) return false
    if (prev.fin === false) return true
    // ⚠️ 放在 ① 之后、KPL 分支之前：空壳连 fin 判断都靠不住（残缺响应里 fin 也可能写 true）
    // ⚠️⚠️ 必须卡在 EMPTY_RETRY_WINDOW_MS 内，否则会和「box / lineups 裁剪」打架：
    //    超过 LINEUP_KEEP_DAYS 的桶在推送前会被**主动摘掉** lineups 和 box（包体积红线），
    //    摘完的 payload 看起来跟「残缺响应」一模一样（实测 10-05 两场 NBA 就是这种）。
    //    若不限制，这类桶会在 48h 内每 2h 被重抓一次，抓回来又被裁掉 —— 纯浪费请求量。
    //    而真正的残缺响应在开赛当天就会被发现，24h 足够补上。
    if (Date.now() - t < EMPTY_RETRY_WINDOW_MS && !hasContent(prev)) return true
    if (m.comp === 'kpl') {
      if (prev.kpl == null) return true
      // 局数完整性：已存局数 < 主队得分 + 客队得分（3:0 → 该有 3 局）
      const need = Number((m.home && m.home.score) || 0) + Number((m.away && m.away.score) || 0)
      const have = Array.isArray(prev.kpl.list) ? prev.kpl.list.length : 0
      if (need > 0 && have < need) return true
    }
    return false
  }
  return Date.now() - (prev.ts || 0) > UPCOMING_REFRESH_MS
}

async function main() {
  const matches = decodeSnapshot(require('../data/matches.js'))
  const list = Array.isArray(matches) ? matches : matches.matches || []
  const now = Date.now()

  // 快通道：用最新状态覆盖旧快照（详见 STATUS_JSON 的注释）
  if (STATUS_JSON) {
    let ov = null
    try {
      ov = JSON.parse(fs.readFileSync(STATUS_JSON, 'utf8'))
    } catch (err) {
      console.warn('[match-detail] ⚠ 状态覆盖表读取失败，退回本地快照：', (err && err.message) || err)
    }
    if (ov && Object.keys(ov).length) {
      let hit = 0
      list.forEach((m) => {
        const o = ov[m.id]
        if (!o) return
        if (o.status) m.status = o.status
        if (m.home && o.hs != null) m.home.score = o.hs
        if (m.away && o.as != null) m.away.score = o.as
        hit += 1
      })
      console.log(`[match-detail] 快通道：${Object.keys(ov).length} 条最新状态，命中 ${hit} 场`)
    }
  }

  const targets = list.filter((m) => {
    // ⚠️ 必须走 resolveSlug（含比赛自带的 slug），只查 SLUG 表会把中国国字号漏掉
    //    KPL 走另一条链路（官方 getScheduleDetail），不在 SLUG 表里
    if (!resolveSlug(m) && m.comp !== 'kpl') return false
    const t = new Date(m.start).getTime()
    if (Number.isNaN(t)) return false
    if (m.comp === 'kpl') {
      // 单局信息只在开打之后才存在，未开赛抓不到任何东西
      return m.status === 'finished' || m.status === 'live' || m.status === 'inprogress'
    }
    if (m.status === 'finished') return now - t < FINISHED_MS + 6 * 3600 * 1000
    if (m.status === 'live' || m.status === 'inprogress') return true
    // 赛前预览：ESPN 对未开赛的比赛照样给 lastFiveGames / seasonseries，
    // 只是没有事件和统计 —— 页面已有 hasTimeline / hasStats 判断会自动隐藏那两块
    return m.status === 'upcoming' && t - now < UPCOMING_MS
  })

  buildTeamIndex(list)
  const { captured, buckets } = await loadCaptured()
  const todo = targets.filter((m) => needsFetch(m, captured))
  console.log(`[match-detail] 目标 ${targets.length} 场，其中待抓 ${todo.length} 场（进行中每班重抓）`)

  let ok = 0
  const failed = []
  await mapLimit(todo, 4, async (m) => {
    try {
      const d = m.comp === 'kpl' ? await fetchKplDetail(m) : await fetchDetail(m)
      if (!d) return
      const key = `d-${dayKey(m.start)}`
      if (!buckets[key]) buckets[key] = { day: dayKey(m.start), payload: {} }
      buckets[key].payload[m.id] = d
      ok += 1
    } catch (err) {
      failed.push(`${m.id}: ${(err && err.message) || err}`)
    }
  })

  // 清理过期桶：本地不删云端行，交给 cloud-sync 在推送后处理
  const cutoffOf = (days) => {
    const d = new Date(now - days * 24 * 3600 * 1000 + 8 * 3600 * 1000)
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
  }
  const cutoff = cutoffOf(KEEP_DAYS)
  // ⚠️ 阵容 / 单场球员数据的窗口比整桶的保留期短得多（包体积红线，见 LINEUP_KEEP_DAYS）。
  //    超过窗口的桶把 lineups / box 摘掉再推 —— 已结束的比赛不会被重抓，
  //    不主动裁的话它会一直躺在桶里占着包体积。
  const lineupCutoff = cutoffOf(LINEUP_KEEP_DAYS)

  const touched = []
  let lineups = 0
  let boxes = 0
  Object.keys(buckets).forEach((id) => {
    const day = String(id).slice(2)
    if (day < cutoff) return // 过期桶整行丢掉，不再推送（云端的旧行由 cloud-sync 清理）
    const payload = buckets[id].payload || {}
    const staleLineups = day < lineupCutoff
    // 清掉已经不再抓详情的赛事（比如后来决定不抓的国际友谊赛），
    // 否则这些行会一直被推到云端、也一直占着包体积
    Object.keys(payload).forEach((k) => {
      const d = payload[k]
      if (!detailCapable(d && d.comp)) { delete payload[k]; return }
      if (staleLineups && d && d.lineups) d.lineups = null
      if (staleLineups && d && d.box) d.box = null
      if (d && d.lineups) lineups += 1
      if (d && d.box) boxes += 1
    })
    if (!Object.keys(payload).length) return
    touched.push({ id, day, payload })
  })

  const out = {
    generatedAt: new Date().toISOString(),
    buckets: touched,
    stats: {
      targets: targets.length,
      fetched: ok,
      failed: failed.length,
      buckets: touched.length,
      lineups,
      boxes,
    },
  }
  const file = path.join(__dirname, '..', 'data', 'match-details.js')
  fs.writeFileSync(
    file,
    `// 自动生成，请勿手改：由 tools/match-detail.js 写入\nmodule.exports = ${JSON.stringify(out)}\n`,
    'utf8'
  )
  const size = Math.round(fs.statSync(file).size / 1024)
  console.log(`[match-detail] 抓取成功 ${ok} 场，失败 ${failed.length} 场，${touched.length} 个日桶 / 阵容 ${lineups} 场 / ${size}KB`)
  savePlayerPool()
  if (failed.length) console.warn('[match-detail] 失败场次：', failed.slice(0, 6).join(' | '))
  if (!ok) {
    console.warn('[match-detail] ⚠ 本轮没有抓到任何详情，不覆盖已有数据')
    process.exit(3)
  }
}

// ⚠️ 只在直接执行时跑 main —— smoke.js 会 require 本文件来测纯函数，
//    不守卫的话一 require 就整轮抓取（与 sync.js 同样的坑）
if (require.main === module) {
  main().catch((err) => {
    console.error('[match-detail] 未预期错误：', err && err.stack ? err.stack : err)
    process.exit(1)
  })
}

module.exports = { SCHEMA, SLUG, LINEUP_KEEP_DAYS, BASKET_STAT_LABELS, PLAYER_POOL_FILE, keepEvent, zhEvent, briefOf, dayKey, pickEvents, pickForm, pickH2H, pickStats, pickLineups, pickBasketballPlayers, pickKplDetail, fetchKplDetail, posGroup, resolveSlug, detailCapable, hasContent, needsFetch, isPlayed, teamZh, noteRosterPlayers, savePlayerPool }
