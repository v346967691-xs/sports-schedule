const matchStatus = require('../utils/match-status')
/**
 * 进行中比赛的实时比分（live 快通道）
 * ============================================================
 * 用途：只抓「正在打的比赛」的比分/状态，推到云表 `live_scores`（约 10KB），
 *       供小程序在 `schedule_cache` 之上打补丁 —— 让比分延迟从 ~9 分钟降到 ~1 分钟。
 *
 * 用法： node tools/live-watch.js [--once] [--minutes=14] [--every=60] [--dry] [--only=epl,nba] [--notify]
 * --notify：每轮比分落库后检查订阅通知；--dry 始终不领取或发送通知。
 *
 * 🔴 为什么不能靠「把主同步加密到 2 分钟」来解决：
 *    `schedule_cache` 一行 **891KB**（2322 场解码后的扁平数组），
 *    2 分钟一次 = 720 次/天 × 1.1MB ≈ 790MB/天，而其中 90% 的内容（未来 45 天赛程、
 *    积分榜、射手榜）压根没变。所以主同步保持 15 分钟，**只把进行中的比赛拆出来高频刷**。
 *
 * 🔴 为什么是「循环」而不是「独立的高频定时任务」：
 *    GitHub 原生 cron 在本仓库实测 2.5~5 小时才投递一次（改频率无效），
 *    可靠触发只能靠外部 cron-job.org POST `workflow_dispatch`。
 *    为了**不新增外部配置**，这里把 live 循环挂在**已有的** 15 分钟任务末尾：
 *    一次 Actions 运行 ≈ 2 分钟（主同步）+ 14 分钟（本循环），几乎连续覆盖，
 *    等效粒度 = `--every`（默认 60 秒）。详见 .github/workflows/sync-schedule.yml。
 *
 * 设计要点：
 *   1) **只推变化的部分**，客户端按 id 在内存里打补丁（`utils/data.js: applyLive()`）。
 *      小表同时收录「今天已结束」的比赛，这样终场哨响的瞬间最终比分也能立刻同步
 *      （否则比赛一结束就从 live 列表消失，客户端要等下一次 15 分钟全量）。
 *   2) **候选赛事集合在进程内收敛**：第一次全量扫所有 ESPN 赛事，
 *      之后只扫上一轮有 live 比赛的赛事（通常 <10 个），每 `DISCOVER_EVERY` 轮再全量一次
 *      —— 否则每 60 秒打 31 个赛事 × 3 个日期，上游请求量是主同步的 5 倍。
 *   3) **没有 live 比赛就立刻退出**（`--once` 或循环里连续 N 轮为空），
 *      凌晨没比赛时不白占 Actions 分钟数。
 *   4) **非 ESPN 源各开一路**：CBA（`scanCba`）与 KPL（`scanKpl`）走官方接口，
 *      一次请求就拿到全部场次 + 实时比分。KPL 是 2026-10-11 补上的 —— 此前它只走
 *      主闸（**90 分钟节流**），用户实测「上游 2:2 / 页面 1:1」滞后 62 分钟。
 *      LoL 系（`scanLol`）同日补上，但它不像 CBA/KPL 是「一次请求拿全部」——
 *      LoL 官方只支持按 leagueId 逐个拉，所以是 **7 个请求/轮**（见 scanLol 注释）。
 */
const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk')
const publicConfig = require('../utils/cloud-config')

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports'
const COMPETITIONS = require('../data/meta.js').competitions
// 复用 sync.js 的赛事表（它才有 `sport` 字段；data/meta.js 只有 `cat`）
// 🔴 KPL_STATE / KPL_CANCELED 也一并借用：KPL 的状态语义在 sync.js 里有完整取证注释，
//    别在这里重新猜一遍（两处一旦不一致，同一场比赛会出现两种状态）。
// 🔴 LOL / LOL_KEY 同理：LoL 快通道要打与主同步完全相同的上游和 key。
const SYNC = require('./sync.js')
const SYNC_COMPS = SYNC.COMPETITIONS
const { KPL_STATE, KPL_CANCELED, LOL, LOL_KEY, cbaStatus } = SYNC
// LoL 的「进行中也要出局分」判定在 lol-status.js 里（与主同步同源，别各写一份）
const lolStatus = require('./lol-status.js').lolStatus

const DAY = 86400000
const DISCOVER_EVERY = 5 // 每 5 轮做一次全量发现（防止漏掉刚开赛的联赛）
const IDLE_EXIT_ROUNDS = 3 // 连续 N 轮没有 live 比赛就退出（省 Actions 分钟数）
// 内容一直没变时，至少每隔 N 轮还是要写一次（=60s×5≈5 分钟一次心跳）。
// 目的：客户端要能区分「比分确实没变」和「同步挂了」这两种情况。
const HEARTBEAT_ROUNDS = 5
const sourceHealth = {}
function sourceResult(key, error) {
  const previous = sourceHealth[key] || {}
  sourceHealth[key] = {
    ok: !error, checkedAt: new Date().toISOString(),
    ...(error ? { lastSuccess: previous.ok ? previous.checkedAt : previous.lastSuccess || null,
      error: String(error.message || error).slice(0, 160) } : {}),
  }
}

function arg(name, def) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : def
}
const onlyArg = arg('only', '')
// KPL 不走 ESPN 的 TARGETS 过滤（它不是 ESPN 源），`--only` 得单独判一次，
// 否则 `--only=kpl` 会连它自己一起滤掉。
const kplOn = !onlyArg || onlyArg.split(',').indexOf('kpl') > -1
// LoL 系同理，而且它有 7 个 key（worlds/demacia/lpl/lck/lec/msi/agames），
// `--only=lol` / `--only=esports` 与单个 key（`--only=lpl`）都要能选中。
const LOL_COMPS = SYNC_COMPS.filter((c) => c.source === 'lol')
const LOL_KEYS = LOL_COMPS.map((c) => c.key)
const lolOn = !onlyArg || onlyArg === 'lol' || onlyArg === 'esports'
  || onlyArg.split(',').some((k) => LOL_KEYS.indexOf(k) > -1)
const minutes = Number(arg('minutes', 14))
const tennisOn = !onlyArg || onlyArg === 'tennis' || onlyArg.split(',').some(k => k === 'atp' || k === 'wta')
const everySec = Number(arg('every', 60))
const once = process.argv.includes('--once')
const dry = process.argv.includes('--dry')
const notify = process.argv.includes('--notify') && !dry
const tennisInsightsOn = process.argv.includes('--tennis-insights') && tennisOn && !dry

const pad = (n) => String(n).padStart(2, '0')

/** ESPN 的 `dates=YYYYMMDD` 用的是 UTC 日期；取昨天/今天/明天三天，覆盖所有时区 */
function espnDates() {
  const now = Date.now()
  const out = []
  for (let i = -1; i <= 1; i += 1) {
    const d = new Date(now + i * DAY)
    out.push(`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`)
  }
  return out
}

async function getJSON(url, headers = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let timer
    try {
      const controller = new AbortController()
      timer = setTimeout(() => controller.abort(), 12000)
      const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0', ...headers } })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      if (attempt === 1) throw err
      await new Promise((r) => setTimeout(r, 400))
    } finally { clearTimeout(timer) }
  }
  throw new Error('请求未完成')
}

/**
 * 进行中 / 刚结束的状态文案中文化。
 * 🔴 上游对 `state === 'in'` 给的是英文原文：篮球 `Q3 5:23`、足球 `45'`。
 *    直接显示英文不是不行，但「第3节 5:23」更符合中文阅读。
 */
function zhLiveStatus(sport, state, shortDetail) {
  const s = String(shortDetail || '')
  if (state === 'post') return '已结束'
  if (state === 'pre') return ''
  if (/halftime/i.test(s)) return '中场休息'
  if (sport === 'basketball') {
    let m = s.match(/^Q(\d+)\s*([\d:]+)?/)
    if (m) return m[2] ? `第${m[1]}节 ${m[2]}` : `第${m[1]}节`
    m = s.match(/^(\d+)(?:st|nd|rd|th)?\s*Qtr\s*([\d:]+)?/i)
    if (m) return m[2] ? `第${m[1]}节 ${m[2]}` : `第${m[1]}节`
    if (/^OT/i.test(s)) {
      const t = s.replace(/^OT\s*/i, '')
      return t ? `加时 ${t}` : '加时'
    }
    m = s.match(/End of (\d+)/i)
    if (m) return `第${m[1]}节结束`
    return s || '进行中'
  }
  // 足球：`45'` / `90+2'` / HT
  const fm = s.match(/^(\d+)(?:\+(\d+))?'/)
  if (fm) return fm[2] ? `${fm[1]}分钟+${fm[2]}` : `${fm[1]}分钟`
  return s || '进行中'
}

/**
 * 赛事 → {key, sport, league}。**只处理 ESPN 来源**；非 ESPN 源各走自己的那一路：
 * CBA → `scanCba`、KPL → `scanKpl`、LoL 系 → `scanLol`（见上方各自注释）。
 * ⚠️ 中国国字号（`chn`）**没有单一联赛**，横跨 4 个国际赛事（友谊赛/世预赛/亚洲杯/奥运会），
 *    所以一个 key 要展开成多条 league —— 漏了它的话，国足的比赛就没有实时比分。
 */
const TARGETS = (() => {
  const keys = new Set(COMPETITIONS.map((c) => c.key))
  const out = []
  SYNC_COMPS.forEach((c) => {
    if (c.source !== 'espn' || !c.sport || !keys.has(c.key)) return
    if (onlyArg && onlyArg.split(',').indexOf(c.key) === -1) return
    const slugs = (c.espns || []).map((s) => s.slug)
    if (!c.espn && !slugs.length) return
    ;(slugs.length ? slugs : [c.espn]).forEach((league) => {
      if (league) out.push({ key: c.key, sport: c.sport, league })
    })
  })
  return out
})()

/** 扫一轮：抓候选赛事的 scoreboard，抽出 live + 今天已结束的比赛 */
async function scan(comps) {
  const dates = espnDates()
  const rows = []
  const found = {}
  // ⚠️ 候选赛事要按「时间窗」判定，不能只看有没有 live：
  //    一个赛事今天第一场还没开打时，如果因为「没有 live」就被收敛掉，
  //    那这场开赛最多要等下一次全量发现（5 轮 = 5 分钟）才被扫到 ——
  //    用户会看到「比赛已经开打 4 分钟了，比分还是 0-0 未开始」。
  //    所以「3 小时内开赛 / 2 小时内结束」的赛事都要留在候选里。
  const now = Date.now()
  const near = (iso) => {
    const t = Date.parse(iso || '')
    return Number.isFinite(t) && t > now - 2 * 3600000 && t < now + 3 * 3600000
  }

  let cursor = 0
  const worker = async () => { while (cursor < comps.length) {
    const c = comps[cursor++]
    let hit = 0
    let problem = null
    for (const d of dates) {
      let j
      try {
        j = await getJSON(`${ESPN}/${c.sport}/${c.league}/scoreboard?dates=${d}`)
      } catch (err) {
        problem = err
        console.error(`[live-watch] ESPN(${c.key}/${d}) 失败：${err.message}`)
        continue
      }
      const evs = (j && j.events) || []
      for (const ev of evs) {
        const st = ev.status && ev.status.type && ev.status.type.state
        const comp = (ev.competitions && ev.competitions[0]) || null
        // 只保留时间窗内的赛事做候选（不论它现在是未开始/进行中/已结束）
        if (comp && near(comp.date || ev.date)) found[c.key] = 1
        if (st !== 'in' && st !== 'post') continue
        if (st === 'in') found[c.key] = 1
        if (!comp) continue
        const cs = comp.competitors || []
        const h = cs.find((x) => x.homeAway === 'home') || cs[0]
        const a = cs.find((x) => x.homeAway === 'away') || cs[1]
        if (!h || !a) continue
        const row = {
          id: `${c.key}-${ev.id}`,
          st: matchStatus.fromEspn(ev.status && ev.status.type).status,
          stt: matchStatus.fromEspn(ev.status && ev.status.type).statusText || zhLiveStatus(c.sport, st, ev.status && ev.status.type && ev.status.type.shortDetail),
          hs: Number(h.score) || 0,
          as: Number(a.score) || 0,
        }
        // 篮球的节次比分（足球没有 linescores）
        const ls = { h: [], a: [] }
        ;[h, a].forEach((side, i) => {
          ((side.linescores) || []).forEach((l) => {
            const v = Number(l.value != null ? l.value : l.displayValue)
            if (Number.isFinite(v)) ls[i ? 'a' : 'h'].push(v)
          })
        })
        if (ls.h.length || ls.a.length) row.ls = ls
        rows.push(row)
        hit += 1
      }
    }
    if (hit) found[c.key] = found[c.key] || 0
    sourceResult(`espn:${c.key}:${c.league}`, problem)
  } }
  await Promise.all(Array.from({ length: Math.min(6, comps.length) }, worker))
  return { rows, liveComps: Object.keys(found).filter((k) => found[k] === 1) }
}

async function scanTennis() {
  const { tennisScore, WTA_TOUR_EVENT_IDS } = require('./sync')
  const rows = new Map()
  const now = Date.now()
  for (const tour of ['atp', 'wta']) {
    if (onlyArg && onlyArg !== 'tennis' && onlyArg.split(',').indexOf(tour) < 0) continue
    try {
      const dates = espnDates()
      for (const date of dates) {
        const j = await getJSON(`${ESPN}/tennis/${tour}/scoreboard?dates=${date}`)
        for (const ev of (j.events || [])) for (const group of (ev.groupings || [])) {
          if (tour === 'wta' && !WTA_TOUR_EVENT_IDS.has(String(ev.id || '').split('-')[0])) continue
          const expected = tour === 'atp' ? 'mens-singles' : 'womens-singles'
          if (!group.grouping || group.grouping.slug !== expected) continue
          for (const game of group.competitions || []) {
            if (/qualif/i.test(game.round && game.round.displayName || '')) continue
            const state = game.status && game.status.type && game.status.type.state
            const start = Date.parse(game.date || '')
            if (!Number.isFinite(start) || (state !== 'in' && !(state === 'post' && start >= now - 12 * 3600000))) continue
            const players = game.competitors || []
            const h = players.find(x => x.homeAway === 'home') || players[0]
            const a = players.find(x => x.homeAway === 'away') || players[1]
            if (!h || !a) continue
            const number = x => x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x)
            const ls = { h: (h.linescores || []).map(x => number(x.value)), a: (a.linescores || []).map(x => number(x.value)) }
            const outcome=game.status&&game.status.type||{}
            const winner=players.find(player=>player.winner===true)
            const row = {
              id: `${tour}-${game.id}`, st: matchStatus.fromEspn(outcome).status,
              stt: matchStatus.fromEspn(outcome).statusText || (state === 'in' ? `第${game.status?.period || 1}盘进行中` : '已结束'),
              hs: tennisScore(h),
              as: tennisScore(a),
            }
            const seed=side=>Number.isInteger(side.curatedRank?.current)&&side.curatedRank.current>0?side.curatedRank.current:null
            if(seed(h)||seed(a))row.sd=[seed(h),seed(a)]
            if(row.st==='finished'&&winner)row.wi=String(winner.athlete&&winner.athlete.id||winner.id)
            if (ls.h.length || ls.a.length) row.ls = ls
            rows.set(row.id, row)
          }
        }
      }
      sourceResult(`tennis:${tour}`)
    } catch (err) {
      console.warn(`[live-watch] ${tour.toUpperCase()} 抓取失败：`, err.message)
      sourceResult(`tennis:${tour}`, err)
    }
  }
  return [...rows.values()]
}

/**
 * CBA：官方接口 `home_schedules` **一个请求**就给全部赛程 + 比分 + 节次时钟，
 *    不像 ESPN 要按联赛逐个打。所以加它几乎零成本。
 * ⚠️ 状态语义照搬 `sync.js`：`Status === 1` 未开始；其余看 `Quarter` ——
 *    有节次就是进行中，没有就是已结束（否则会误判成「进行中但比分 0-0」）。
 * ⚠️ 2026-10-05 加的时候CBA新赛季还没开打（全是 Status=1），
 *    `Minutes` / `Seconds` 的**具体格式没能实测**，所以时钟文案做了兜底：
 *    拼不出来就只说「第N节」，绝不显示成 "undefined:undefined"。
 */
const CBA = 'https://portal-server.cbaleague.com'

function cbaStatusText(ev) {
  const q = Number(ev.Quarter)
  if (!Number.isFinite(q) || q <= 0) return '进行中'
  const mm = ev.Minutes == null ? '' : String(ev.Minutes).padStart(2, '0')
  const ss = ev.Seconds == null ? '' : String(ev.Seconds).padStart(2, '0')
  return mm && ss ? `第${q}节 ${mm}:${ss}` : `第${q}节`
}

async function scanCba() {
  const j = await getJSON(`${CBA}/home/home_schedules`)
  if (!j || !j.data) throw new Error('CBA 响应缺少赛程')
  sourceResult('cba')
  const arr = Object.values((j && j.data) || {})
  const now = Date.now()
  const num = (v) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null)
  const lo = now - 2 * 3600000
  const hi = now + 3 * 3600000
  // 🔴 「窗口内有 CBA 比赛」（**含还没开打的**）—— 决定下一轮要不要继续扫 CBA。
  //    若只按「已开打」当收敛条件，一场 20 分钟后开打的比赛不会被看见，
  //    收敛就把 CBA 关掉了 → 开赛那一刻没人扫 → 最多晚 5 分钟才补上。
  //    ESPN 那条通道用同样的 near 窗口避开了这个坑，这里与它对齐。
  let near = false
  const rows = []
  arr.forEach((ev) => {
    const start = Date.parse(`${ev.dates}T${ev.time || '00:00'}:00+08:00`)
    if (Number.isFinite(start) && start >= lo && start <= hi) near = true
    if (!Number.isFinite(start) || start > hi) return
    const hs = num(ev.HomeTeamScore)
    const as = num(ev.VisitingTeamScore)
    const st = cbaStatus(ev, hs != null || as != null, start, now)
    if (st === 'upcoming') return
    // 进行中的比赛不受两小时窗口限制，末节/加时也必须持续跟踪。
    if (st === 'finished' && start < now - 12 * 3600000) return
    if (st === 'live') near = true
    rows.push({
      id: `cba-${ev.ScheduleID}`,
      st,
      stt: st === 'finished' ? '已结束' : cbaStatusText(ev),
      hs: hs || 0,
      as: as || 0,
    })
  })
  return { rows, near }
}

/* ------------------------------------------------------------------ KPL
 *
 * 王者荣耀 KPL 官方接口（`kpl.qq.com` 前端包里挖出来的后端，无需 key，POST + JSON）。
 * **一次请求返回整赛季全部场次**（含实时局分），所以接它几乎零上游成本。
 *
 * 🔴 为什么必须接（2026-10-11 用户报障）：
 *    KPL 之前只走主闸 `schedule_cache`，而主闸有 **90 分钟节流** ——
 *    实测「上游 广州TTG 2:2 上海EDG.M、我们显示 1:1」时，云端那份数据已滞后 62 分钟，
 *    最长能到 90 分钟。BO5 一局约 20~30 分钟，等于**整场比赛只更新 1~2 次**，
 *    用户直接感知为「实时比分是坏的」。
 *    （当初不接的理由是「局分变化慢，15 分钟粒度够用」—— 那个前提是错的：
 *      主闸实际是 90 分钟节流，不是 15 分钟。）
 *
 * ⚠️ id 必须与 `sync.js` 完全一致（`kpl-${scheduleid}`）。差一个字符客户端就打不上补丁，
 *    而且**不会报任何错** —— `applyLive()` 是按 id 匹配，匹配不上就静默跳过。
 *    `tools/smoke.js` 有守卫盯着这两处的 id 拼法。
 */
const KPL_API = 'https://kplshop-op.timi-esports.qq.com/kplow'

/** 上游状态 → 我们的三态。含「打完了还报未开始」的兜底（口径同 sync.js） */
function kplEffectiveStatus(ev) {
  const st = KPL_STATE[Number(ev.schedule_status)] || 'upcoming'
  const played = Number(ev.team_a_score || 0) + Number(ev.team_b_score || 0)
  return st === 'upcoming' && played > 0 ? 'finished' : st
}

/** 状态文案：与主表（sync.js）保持一致，别让同一场比赛在两个页面有两种说法 */
function kplStatusText(ev) {
  const st = kplEffectiveStatus(ev)
  return st === 'finished' ? '已结束' : st === 'live' ? '进行中' : ''
}

async function scanKpl() {
  let json
  try {
    const res = await fetch(`${KPL_API}/getScheduleList`, {
      signal: AbortSignal.timeout(12000),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
        Referer: 'https://kpl.qq.com/',
        Origin: 'https://kpl.qq.com',
      },
      body: JSON.stringify({ seasonid: '' }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    json = await res.json()
    if (!Array.isArray(json && json.data && json.data.list)) throw new Error('KPL 响应缺少赛程')
    sourceResult('kpl')
  } catch (err) {
    // 静默降级：KPL 挂了绝不能连累 ESPN 那条主通道
    console.error('[live-watch] KPL 抓取失败，本轮跳过：', (err && err.message) || err)
    sourceResult('kpl', err)
    return []
  }

  const list = (json && json.data && json.data.list) || []
  const now = Date.now()
  const num = (v) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null)
  const rows = []
  for (const ev of list) {
    if (Number(ev.schedule_status) === KPL_CANCELED) continue
    const ts = Number(ev.start_timestamp)
    if (!ts) continue
    const start = ts * 1000
    const st = kplEffectiveStatus(ev)
    if (st === 'upcoming') continue
    // 🔴 时间窗不能用「开赛 ≤2 小时」这种窄口径：BO5 打满能超过 3 小时，
    //    窄窗口会把**正在进行的比赛漏掉**（实测 17:00 开赛、19:30 仍在打）。
    //    所以：进行中的一律收；已结束的只留 5 小时内的，免得塞进几周前的老比赛。
    if (st === 'finished' && start < now - 5 * 3600000) continue
    if (start > now + 3 * 3600000) continue
    rows.push({
      id: `kpl-${ev.scheduleid}`,
      st,
      stt: kplStatusText(ev),
      hs: num(ev.team_a_score) || 0,
      as: num(ev.team_b_score) || 0,
    })
  }
  return rows
}

/* ------------------------------------------------------------------ LoL
 *
 * 英雄联盟 LoL Esports API（`esports-api.lolesports.com`，需要 `x-api-key`，
 * key 与主同步 `sync.js` 共用同一份）。
 *
 * 🔴 为什么必须接（2026-10-11，与 KPL 同批）：
 *    此前 LoL 系只走主闸（**90 分钟节流**）。一场 BO3/BO5 打 1~3 小时，
 *    等于整场只更新 1~2 次；而且 `lolStatus` 早先**只在系列赛结束时才出局分**，
 *    进行中恒为 null —— 用户看到的是「0:0 一直挂着」。
 *
 * 🔴 为什么不像 CBA/KPL 那样「一次请求拿全部」：
 *    LoL 官方只支持 `getSchedule?leagueId=` 按单个联赛拉，且 7 个联赛是
 *    7 个不同的 leagueId，**没有任何接口一次返回全部联赛**（`getLive` 只给
 *    当前 inProgress 的场次，比赛一结束就消失 → 会让比分「往回跳」到主闸旧值，
 *    所以不能只靠它）。只能逐联赛拉，**7 个请求/轮**。
 *    这点成本相对 ESPN 主通道（全量轮 40+ 组合 × 3 天 ≈ 120 请求/轮）可以忽略。
 *
 * ⚠️ id 必须与 `sync.js` 完全一致（`${comp.key}-${ev.match.id}`）。
 *    不一致时 `applyLive()` 匹配不到 → 不报错 → 用户看到的还是主闸那份旧比分。
 *    `tools/smoke.js` 有守卫盯着这两处的 id 拼法。
 */
// 时间窗：进行中的一律收；已结束只留 6 小时内的（BO5 最长 ~5h，再加上游 state 滞后）。
const LOL_FINISH_KEEP_MS = 12 * 3600000
const LOL_LAST_GOOD_MAX_AGE_MS = 15 * 60000

/** A temporary league API failure must not erase its recent rows from the shared live table. */
function preserveLastGoodLolRows(rows, previousData, failedLeagueKeys, sources, now = Date.now()) {
  const out = rows.slice()
  const ids = new Set(out.map(row => row.id))
  const previousRows = previousData && Array.isArray(previousData.rows) ? previousData.rows : []
  for (const key of failedLeagueKeys || []) {
    const health = sources && sources[`lol:${key}`]
    const lastSuccess = health && (health.ok ? health.checkedAt : health.lastSuccess)
    const lastSuccessAt = Date.parse(lastSuccess || '')
    if (!Number.isFinite(lastSuccessAt) || now - lastSuccessAt > LOL_LAST_GOOD_MAX_AGE_MS) continue
    const prefix = `${key}-`
    for (const row of previousRows) {
      if (typeof row.id !== 'string' || !row.id.startsWith(prefix) || ids.has(row.id)) continue
      out.push(row)
      ids.add(row.id)
    }
  }
  return out
}

async function scanLol() {
  const now = Date.now()
  // 7 个联赛**并行**拉（串行的话一轮就 20~30 秒，把 60 秒的循环周期挤满）
  const chunks = await Promise.all(LOL_COMPS.map(async (lg) => {
    let j
    const evs = []
    try {
      j = await getJSON(`${LOL}/getSchedule?hl=zh-CN&leagueId=${lg.lol}`, { 'x-api-key': LOL_KEY })
      if (!Array.isArray(j && j.data && j.data.schedule && j.data.schedule.events)) throw new Error('LoL 响应缺少赛程')
      evs.push(...j.data.schedule.events)
      let token = j.data.schedule.pages && j.data.schedule.pages.newer
      const seen = new Set()
      while (token && !seen.has(token) && seen.size < 12) {
        seen.add(token)
        j = await getJSON(`${LOL}/getSchedule?hl=zh-CN&leagueId=${lg.lol}&pageToken=${encodeURIComponent(token)}`, { 'x-api-key': LOL_KEY })
        const page = j && j.data && j.data.schedule
        if (!page || !Array.isArray(page.events)) throw new Error('LoL 翻页响应缺少赛程')
        evs.push(...page.events)
        token = page.pages && page.pages.newer
        if (page.events.some(ev => Date.parse(ev.startTime) > now + 3 * 3600000)) break
      }
      sourceResult(`lol:${lg.key}`)
    } catch (err) {
      // 静默降级：某个联赛挂了不能连累其它联赛，更不能连累 ESPN 主通道
      console.error(`[live-watch] LoL(${lg.key}) 抓取失败，跳过：`, (err && err.message) || err)
      sourceResult(`lol:${lg.key}`, err)
      return []
    }
    const out = []
    const seenIds = new Set()
    for (const ev of evs) {
      if (ev.type !== 'match' || !ev.match) continue
      if (seenIds.has(ev.match.id)) continue
      seenIds.add(ev.match.id)
      const st = lolStatus(ev)
      if (st.status === 'upcoming') continue
      const t = Date.parse(ev.startTime)
      if (st.status === 'finished' && Number.isFinite(t) && t < now - LOL_FINISH_KEEP_MS) continue
      out.push({
        id: `${lg.key}-${ev.match.id}`,
        st: st.status,
        stt: st.statusText,
        hs: st.homeScore,
        as: st.awayScore,
      })
    }
    return out
  }))
  return chunks.flat()
}

async function push(cloud, rows) {
  const nowIso = new Date().toISOString()
  const row = {
    id: 'latest',
    data: { v: 1, rows, sources: sourceHealth, generatedAt: nowIso },
    generated_at: nowIso,
    created_at: nowIso,
  }
  if (dry) {
    console.log('[live-watch] --dry：不写云端。样例：', JSON.stringify(rows[0] || {}))
    return true
  }
  const { error } = await cloud.database.from('live_scores').upsert(row, { onConflict: 'id' })
  if (error) {
    console.error('[live-watch] 推送失败：', JSON.stringify(error).slice(0, 200))
    return false
  }
  return true
}

async function main() {
  const cloud = createWorkBuddyCloud({
    endpoint: publicConfig.endpoint,
    publishableKey: publicConfig.publishableKey,
  })
  let previousLiveData = null
  try {
    const { data, error } = await cloud.database.from('live_scores')
      .select('data').eq('id', 'latest').maybeSingle()
    if (error) throw error
    previousLiveData = data && data.data || null
    // Carry only LoL health forward. Other sources are checked on their normal paths below.
    for (const key of LOL_KEYS) {
      const source = previousLiveData && previousLiveData.sources && previousLiveData.sources[`lol:${key}`]
      if (source) sourceHealth[`lol:${key}`] = source
    }
  } catch (err) {
    console.warn('[live-watch] 读取上一份实时比分失败，暂时无法保留 LoL 来源旧值：', (err && err.message) || err)
  }
  console.log(`[live-watch] 候选赛事 ${TARGETS.length} 个，间隔 ${everySec}s${once ? '（单次）' : `，最长 ${minutes} 分钟`}`)

  const deadline = Date.now() + minutes * 60 * 1000
  let round = 0
  let idle = 0
  let comps = TARGETS
  let total = 0
  let cbaActive = false // CBA 上一轮有没有「正在打 or 窗口内有」比赛（有就继续扫，省得每轮都白打 270KB）
  // 写入去重的状态（详见下面 while 里的「内容去重 + 心跳保活」）
  let lastSig = null
  let roundsSinceWrite = 0
  let idleWritesSkipped = 0
  let writeFailed = false
  let notificationFailed = false

  // eslint-disable-next-line no-constant-condition
  while (true) {
    round += 1
    // 每 DISCOVER_EVERY 轮全量发现一次，防止漏掉「刚开赛、上一轮还是 upcoming」的联赛
    const useAll = round === 1 || round % DISCOVER_EVERY === 1
    const t0 = Date.now()
    const { rows, liveComps } = await scan(useAll ? TARGETS : comps)
    // CBA 不在 TARGETS 里（它不走 ESPN），单独一路。收敛条件 = 「上一轮有 row
    // **或**窗口内有比赛（含未开打）」—— 后者是关键：只看已开打的话，
    // 开赛那一刻会没人扫（最多晚 5 分钟）。见 scanCba 的 near 注释。
    const cbaOn = cbaActive || useAll
    if (cbaOn) {
      let cba
      try { cba = await scanCba() } catch (err) {
        console.error('[live-watch] CBA 失败：', err.message)
        sourceResult('cba', err)
        cba = { rows: [], near: cbaActive }
      }
      const cbaRows = cba.rows
      if (cbaRows.length) {
        rows.push(...cbaRows)
        liveComps.push('cba')
      }
      cbaActive = cbaRows.length > 0 || cba.near
    }
    // KPL 同样走官方接口单独一路，**每轮都扫、不做收敛** ——
    // 一次 POST 返回整赛季（仅 1 个请求、22KB），比 CBA 便宜一个量级。
    if (kplOn) {
      const kplRows = await scanKpl()
      if (kplRows.length) {
        rows.push(...kplRows)
        liveComps.push('kpl')
      }
    }
    // LoL 系（7 个联赛）：每轮都扫。它与 CBA 不同 —— CBA 是 active 收敛（扫到过才继续扫），
    // 而 LoL 一轮 7 个请求、相对 ESPN 全量轮的 120 请求可忽略，
    // 收敛反而会引入「比赛刚开打晚 5 分钟才被扫到」的代价，不划算。
    if (lolOn) {
      const lolRows = await scanLol()
      if (lolRows.length) {
        rows.push(...lolRows)
        lolRows.forEach((r) => {
          const k = r.id.slice(0, r.id.indexOf('-'))
          if (liveComps.indexOf(k) === -1) liveComps.push(k)
        })
      }
      const failedLolKeys = LOL_KEYS.filter(key => sourceHealth[`lol:${key}`] && !sourceHealth[`lol:${key}`].ok)
      if (failedLolKeys.length) {
        const before = rows.length
        rows.splice(0, rows.length, ...preserveLastGoodLolRows(rows, previousLiveData, failedLolKeys, sourceHealth))
        const kept = rows.length - before
        if (kept > 0) console.warn(`[live-watch] 保留 ${failedLolKeys.join(', ')} 上次成功的 ${kept} 场 LoL 实时数据`)
      }
    }
    // 与 LoL 一样逐轮发现新开赛比赛，完赛比分也持续保留供赛果通知重试。
    if (tennisOn) {
      const tennisRows = await scanTennis()
      if (tennisRows.length) {
        rows.push(...tennisRows)
        tennisRows.forEach(r => { const k = r.id.slice(0, r.id.indexOf('-')); if (liveComps.indexOf(k) < 0 && r.st === 'live') liveComps.push(k) })
      }
    }
    const live = rows.filter((r) => r.st === 'live').length
    console.log(
      `[live-watch] 第 ${round} 轮 ${useAll ? '全量' : `收敛(${comps.length})`}：${rows.length} 场（进行中 ${live}），耗时 ${Date.now() - t0}ms`
    )
    rows.sort((a, b) => a.id.localeCompare(b.id))
    if (rows.length || Object.keys(sourceHealth).length) {
      // 🔴 内容去重 + 心跳保活（2026-10-05 云端额度事故后加）
      //    原本每一轮都无条件 upsert 一次，但**绝大多数轮次比分根本没变** ——
      //    那些写入既没有信息量，又实打实消耗云端资源点（若按请求数计费，这条路
      //    原本独占全部写入请求的 73%）。
      //    规则：内容变了立刻写（60 秒粒度、新鲜度零损失）；一直没变则每
      //    HEARTBEAT_ROUNDS 轮补一次，让客户端知道这条管道还活着，而不是同步挂了。
      const sig = JSON.stringify([rows, Object.keys(sourceHealth).sort().map(k => [k, sourceHealth[k].ok])])
      if (sig === lastSig && roundsSinceWrite < HEARTBEAT_ROUNDS) {
        idleWritesSkipped += 1
      } else {
        if (await push(cloud, rows)) {
          writeFailed = false
          lastSig = sig
          roundsSinceWrite = 0
          previousLiveData = {
            rows: rows.map(row => ({ ...row })),
            sources: JSON.parse(JSON.stringify(sourceHealth)),
          }
        } else writeFailed = true
      }
    }
    // 小型独立积分缓存内部每5分钟节流；资料/积分源故障不阻断比分或通知。
    if (tennisInsightsOn) {
      try {
        const result = await require('./tennis-insights').main(cloud, { enrich: false })
        if (result.some(row => row.error)) console.warn('[tennis-insights:live]', JSON.stringify(result))
      } catch (err) { console.warn('[tennis-insights:live]', err.message) }
    }
    // 先完成实时状态写入，再领取到期通知；内容未变也检查赛前时间窗口。
    // 使用原有原子领取/回写接口，并发班次不会重复领取同一份授权。
    if (notify && !writeFailed) {
      try {
        const result = await require('./match-notification-push').main(cloud)
        console.log('[match-notification:live]', JSON.stringify(result))
        if (result.failed) notificationFailed = true
      } catch (err) {
        notificationFailed = true
        console.error('[match-notification:live]', err && err.message || 'failed')
      }
    }
    roundsSinceWrite += 1
    total += rows.length

    if (live || liveComps.length || cbaActive) {
      idle = 0
      comps = TARGETS.filter((c) => liveComps.indexOf(c.key) > -1)
      if (!comps.length) comps = TARGETS
    } else {
      idle += 1
      comps = TARGETS
    }

    if (once) break
    // 连续几轮都没有进行中的比赛（比如深夜）→ 没必要继续占着 Actions
    if (idle >= IDLE_EXIT_ROUNDS) {
      console.log(`[live-watch] 连续 ${idle} 轮没有进行中的比赛，提前退出`)
      break
    }
    if (Date.now() + everySec * 1000 > deadline) {
      console.log(`[live-watch] 到达 ${minutes} 分钟上限，退出（本轮共推 ${total} 场）`)
      break
    }
    // 周期从本轮开始计时；抓取耗时不再叠加到 60 秒等待上。
    await new Promise((r) => setTimeout(r, Math.max(0, everySec * 1000 - (Date.now() - t0))))
  }
  console.log(
    `[live-watch] 完成：${round} 轮，共 ${total} 场`
    + (idleWritesSkipped ? `，内容未变跳过 ${idleWritesSkipped} 次云端写入` : '')
  )
  if (writeFailed || notificationFailed || Object.values(sourceHealth).some(s => !s.ok)) process.exitCode = 2
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[live-watch] 未预期错误：', err && err.stack ? err.stack : err)
    process.exit(1)
  })
}

module.exports = { main, zhLiveStatus, kplStatusText, kplEffectiveStatus, scan, scanKpl, scanLol, scanTennis, espnDates, TARGETS, LOL_KEYS, preserveLastGoodLolRows }
