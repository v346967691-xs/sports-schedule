/**
 * 进行中比赛的实时比分（live 快通道）
 * ============================================================
 * 用途：只抓「正在打的比赛」的比分/状态，推到云表 `live_scores`（约 10KB），
 *       供小程序在 `schedule_cache` 之上打补丁 —— 让比分延迟从 ~9 分钟降到 ~1 分钟。
 *
 * 用法： node tools/live-watch.js [--once] [--minutes=11] [--every=60] [--dry] [--only=epl,nba]
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
 *    一次 Actions 运行 ≈ 2 分钟（主同步）+ 11 分钟（本循环），几乎连续覆盖，
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
 */
const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk')
const publicConfig = require('../utils/cloud-config')

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports'
const COMPETITIONS = require('../data/meta.js').competitions
// 复用 sync.js 的赛事表（它才有 `sport` 字段；data/meta.js 只有 `cat`）
const SYNC_COMPS = require('./sync.js').COMPETITIONS

const DAY = 86400000
const DISCOVER_EVERY = 5 // 每 5 轮做一次全量发现（防止漏掉刚开赛的联赛）
const IDLE_EXIT_ROUNDS = 3 // 连续 N 轮没有 live 比赛就退出（省 Actions 分钟数）
// 内容一直没变时，至少每隔 N 轮还是要写一次（=60s×5≈5 分钟一次心跳）。
// 目的：客户端要能区分「比分确实没变」和「同步挂了」这两种情况。
const HEARTBEAT_ROUNDS = 5

function arg(name, def) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : def
}
const onlyArg = arg('only', '')
const minutes = Number(arg('minutes', 11))
const everySec = Number(arg('every', 60))
const once = process.argv.includes('--once')
const dry = process.argv.includes('--dry')

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

async function getJSON(url) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 12000)
      const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      if (attempt === 1) return null
      await new Promise((r) => setTimeout(r, 400))
    }
  }
  return null
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
 * 赛事 → {key, sport, league}。只处理 ESPN 来源（LoL / KPL / CBA 走各自的抓取器）。
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

  for (const c of comps) {
    let hit = 0
    for (const d of dates) {
      const j = await getJSON(`${ESPN}/${c.sport}/${c.league}/scoreboard?dates=${d}`)
      const evs = (j && j.events) || []
      for (const ev of evs) {
        const st = ev.status && ev.status.type && ev.status.type.state
        const comp = (ev.competitions && ev.competitions[0]) || null
        // 只保留时间窗内的赛事做候选（不论它现在是未开始/进行中/已结束）
        if (comp && near(comp.date || ev.date)) found[c.key] = 1
        if (st !== 'in' && st !== 'post') continue
        if (!comp) continue
        const cs = comp.competitors || []
        const h = cs.find((x) => x.homeAway === 'home') || cs[0]
        const a = cs.find((x) => x.homeAway === 'away') || cs[1]
        if (!h || !a) continue
        const row = {
          id: `${c.key}-${ev.id}`,
          st: st === 'in' ? 'live' : 'finished',
          stt: zhLiveStatus(c.sport, st, ev.status && ev.status.type && ev.status.type.shortDetail),
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
  }
  return { rows, liveComps: Object.keys(found).filter((k) => found[k] === 1) }
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
  if (!Number.isFinite(q) || q <= 0) return '已结束'
  const mm = ev.Minutes == null ? '' : String(ev.Minutes).padStart(2, '0')
  const ss = ev.Seconds == null ? '' : String(ev.Seconds).padStart(2, '0')
  return mm && ss ? `第${q}节 ${mm}:${ss}` : `第${q}节`
}

async function scanCba() {
  const j = await getJSON(`${CBA}/home/home_schedules`)
  const arr = Object.values((j && j.data) || {})
  const now = Date.now()
  const num = (v) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null)
  const rows = []
  arr.forEach((ev) => {
    if (Number(ev.Status) === 1) return // 未开始
    const start = Date.parse(`${ev.dates}T${ev.time || '00:00'}:00+08:00`)
    // 只保留时间窗内的（2 小时前 ~ 3 小时后），别把几个月前的老比赛也推上去
    if (Number.isFinite(start) && (start < now - 2 * 3600000 || start > now + 3 * 3600000)) return
    const q = num(ev.Quarter)
    const hs = num(ev.HomeTeamScore)
    const as = num(ev.VisitingTeamScore)
    rows.push({
      id: `cba-${ev.ScheduleID}`,
      st: q != null ? 'live' : 'finished',
      stt: cbaStatusText(ev),
      hs: hs || 0,
      as: as || 0,
    })
  })
  return rows
}

async function push(cloud, rows) {
  const nowIso = new Date().toISOString()
  const row = {
    id: 'latest',
    data: { v: 1, rows, generatedAt: nowIso },
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
  console.log(`[live-watch] 候选赛事 ${TARGETS.length} 个，间隔 ${everySec}s${once ? '（单次）' : `，最长 ${minutes} 分钟`}`)

  const deadline = Date.now() + minutes * 60 * 1000
  let round = 0
  let idle = 0
  let comps = TARGETS
  let total = 0
  let cbaActive = false // CBA 上一轮有没有扫到比赛（有就继续扫，省得每轮都白打）
  // 写入去重的状态（详见下面 while 里的「内容去重 + 心跳保活」）
  let lastSig = null
  let roundsSinceWrite = 0
  let idleWritesSkipped = 0

  // eslint-disable-next-line no-constant-condition
  while (true) {
    round += 1
    // 每 DISCOVER_EVERY 轮全量发现一次，防止漏掉「刚开赛、上一轮还是 upcoming」的联赛
    const useAll = round === 1 || round % DISCOVER_EVERY === 1
    const t0 = Date.now()
    const { rows, liveComps } = await scan(useAll ? TARGETS : comps)
    // CBA 不在 TARGETS 里（它不走 ESPN），单独一路 —— 只要上一轮扫到过就继续扫，
    // 否则只在全量轮扫（那就变成 5 分钟粒度了，失去意义）
    const cbaOn = cbaActive || useAll
    if (cbaOn) {
      const cbaRows = await scanCba()
      if (cbaRows.length) {
        rows.push(...cbaRows)
        liveComps.push('cba')
      }
      cbaActive = cbaRows.length > 0
    }
    const live = rows.filter((r) => r.st === 'live').length
    console.log(
      `[live-watch] 第 ${round} 轮 ${useAll ? '全量' : `收敛(${comps.length})`}：${rows.length} 场（进行中 ${live}），耗时 ${Date.now() - t0}ms`
    )
    if (rows.length) {
      // 🔴 内容去重 + 心跳保活（2026-10-05 云端额度事故后加）
      //    原本每一轮都无条件 upsert 一次，但**绝大多数轮次比分根本没变** ——
      //    那些写入既没有信息量，又实打实消耗云端资源点（若按请求数计费，这条路
      //    原本独占全部写入请求的 73%）。
      //    规则：内容变了立刻写（60 秒粒度、新鲜度零损失）；一直没变则每
      //    HEARTBEAT_ROUNDS 轮补一次，让客户端知道这条管道还活着，而不是同步挂了。
      const sig = JSON.stringify(rows)
      if (sig === lastSig && roundsSinceWrite < HEARTBEAT_ROUNDS) {
        idleWritesSkipped += 1
      } else {
        await push(cloud, rows)
        lastSig = sig
        roundsSinceWrite = 0
      }
    }
    roundsSinceWrite += 1
    total += rows.length

    if (live) {
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
    await new Promise((r) => setTimeout(r, everySec * 1000))
  }
  console.log(
    `[live-watch] 完成：${round} 轮，共 ${total} 场`
    + (idleWritesSkipped ? `，内容未变跳过 ${idleWritesSkipped} 次云端写入` : '')
  )
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[live-watch] 未预期错误：', err && err.stack ? err.stack : err)
    process.exit(1)
  })
}

module.exports = { zhLiveStatus, scan, espnDates, TARGETS }
