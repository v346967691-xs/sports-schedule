/**
 * 云端赛程缓存同步脚本
 * ============================================================
 * 用途：把最新赛程快照推送到云表 schedule_cache，让小程序「每次打开即读云端」，
 *       无需重新发布就能看到最新比分。配合每小时自动化调用即可自动保持新鲜。
 *
 * 用法： node tools/cloud-sync.js [daysBack] [daysForward]
 *   默认回看 14 天、前瞻 21 天。
 *
 * ⚠️ 前瞻窗口 2026-10-05 从 45 天压到 21 天：891KB → 379KB（-57%），实测得数见 decision log。
 *    45 天那份里有一半以上用户根本看不到（首页只展示未来 7 天），白占云端落库额度。
 *    要临时看更远的赛程：`node tools/cloud-sync.js 14 45 --force`。
 *
 * 🔴 还有一道**节流闸**（MIN_INTERVAL_MIN）：距上次推送不足该间隔就整班跳过。
 *    被触发 96 次/天不代表要写 96 次 —— 详见 gate() 的注释。
 *
 * 流程：
 *   1) 复用 tools/sync.js 抓取数据源、刷新本地 data/matches.js、data/meta.js
 *      （本地数据同时作为联网失败时的兜底）
 *   2) 复用 tools/standings.js 抓取积分榜、刷新本地 data/standings.js
 *      附加数据：失败只告警，不让主链路跟着失败（与 daily_brief 一个约定）
 *   2c) 复用 tools/scorers.js 抓取射手榜/助攻榜、刷新本地 data/scorers.js
 *      同样是附加数据，失败只告警
 *   3) 读取刚生成的快照
 *   4) 用 Node 云 SDK（以 publishableKey 的 anon 身份）upsert 进
 *      schedule_cache(id='latest')、standings_cache(id='latest') 与 scorers_cache(id='latest')
 *
 * 退出码：任何一步失败都以非零退出，便于自动化捕获告警。
 */

const { execFileSync } = require('child_process')
const path = require('path')
const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk')
const publicConfig = require('../utils/cloud-config')
const { decodeSnapshot } = require('../utils/snapshot')

// ⚠️ 位置参数必须先滤掉 `--xxx` 开关：否则 `node cloud-sync.js --force` 会把
//    '--force' 当成第 1 个位置参数，Number('--force') = NaN，子进程拿到
//    `sync.js NaN 21` 直接崩（2026-10-05 我自己踩的）。
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const DAYS_BACK = Number(ARGS[0]) || 14
const DAYS_FORWARD = Number(ARGS[1]) || 21
const FORCE = process.argv.includes('--force')

/* 瞬时故障重试：抓取数据源、推送云端都可能撞上网络抖动。
   整点任务一失败就要再等一小时，这里先做有限次退避重试再放弃。 */
const RETRY_ATTEMPTS = 3
const RETRY_BASE_MS = 2000

function log(...args) {
  console.log('[cloud-sync]', ...args)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 有限次重试：fn 抛错就退避重来，最后一次仍失败才把错误抛出去 */
async function withRetry(label, fn) {
  let lastErr
  for (let i = 1; i <= RETRY_ATTEMPTS; i += 1) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < RETRY_ATTEMPTS) {
        const wait = RETRY_BASE_MS * i
        log(`${label} 第 ${i} 次失败，${wait}ms 后重试… ${(err && err.message) || err}`)
        await sleep(wait)
      } else {
        log(`${label} 连续 ${RETRY_ATTEMPTS} 次失败，放弃。`)
      }
    }
  }
  throw lastErr
}

/**
 * 推送快照到云端，带有限重试。
 * 网络异常 / 云端返回 error 都重试；「返回 0 行」是 RLS 策略问题，重试也没用，直接判失败。
 */
async function pushRow(cloud, table, row) {
  let problem = ''
  for (let i = 1; i <= RETRY_ATTEMPTS; i += 1) {
    let result = null
    try {
      result = await cloud.database.from(table).upsert(row).select('id, generated_at')
    } catch (err) {
      problem = `请求异常：${(err && err.message) || err}`
    }
    if (result) {
      if (result.error) {
        problem = `云端返回错误：${JSON.stringify(result.error)}`
      } else if (!Array.isArray(result.data) || result.data.length === 0) {
        // RLS 拦截：这两张表的写入策略都只允许 id='latest'
        return { ok: false, code: 4, problem: `云端写入被拦截（返回 0 行），请检查 ${table} 的写入策略` }
      } else {
        return { ok: true, code: 0, row: result.data[0] }
      }
    }
    if (i < RETRY_ATTEMPTS) {
      const wait = RETRY_BASE_MS * i
      log(`推送 ${table} 第 ${i} 次未成功（${problem}），${wait}ms 后重试…`)
      await sleep(wait)
    }
  }
  return { ok: false, code: 3, problem }
}

/**
 * 🔴🔴 节流闸 —— 云端额度耗尽事故后的头道防线（2026-10-05）
 *
 * 事故经过：cron-job.org 每 15 分钟 POST 一次 `workflow_dispatch` = **96 次/天**，
 * 而每一班都**无条件全量 upsert**：schedule_cache 891KB + standings 129KB
 * + scorers 108KB + match_detail 170KB ≈ **1.3MB/次** → 125MB/天 ≈ **3.7GB/月落库**。
 * 免费版每月只有 5000 资源点，**5 天就烧穿**，数据库随即被隔离（且只保留 15 天即销毁）。
 *
 * 根因不是「功能变多」也不是「数据累积」（稳态总量才 ~1.3MB），而是
 * **写入频次 × 单次体积**。这道闸直接从频次这一侧砍：
 *   96 次/天 → 16 次/天（-83%），再叠加窗口瘦身 -57%，合计降到原来的约 **9%**。
 *
 * ⚠️ 判断依据是**云端那一行的 generated_at**，不是本地文件 —— 多机触发也幂等。
 * ⚠️ 实时比分**完全不受影响**：live-watch 写的是独立的 `live_scores` 小表（约 2KB），
 *    挂在 workflow 后面的 step 里，本脚本跳不跳它都照跑，60 秒粒度不变。
 * ⚠️ 读 `generated_at` 只读一个小字段，比写 1.3MB 便宜两个数量级。
 */
const MIN_INTERVAL_MIN = Number(process.env.SYNC_MIN_INTERVAL_MIN || 90)
const { isOutage } = require('./cloud-outage')
// 快通道要用它的 dayKey / hasContent。⚠️ 本文件有 require.main 守卫，require 不会触发抓取
const MD = require('./match-detail.js')

/**
 * `match_detail` 的节流（分钟）。它按「天」分桶，一次推送要写 13 行，
 * 是单次全量推送里请求数最大的一块（详情写入占全量写入的 78%）。
 *
 * 🔴 2026-10-07 从 180 降到 **90**（用户拍板）：
 *    180 分钟意味着「刚打完的比赛，详情可能要等 3 小时才出现在用户眼前」——
 *    详情恰恰是**赛后**才有人看的东西，延迟 3 小时基本等于这个功能不实时。
 *    代价测算：8 次/天 → 16 次/天，落库 +74MB/月；而烧穿线是 3.7GB/月
 *    （`a4121e7` 之前的量），增量约占额度 **2%**，标准版 25000 点/月装得下。
 *    → 90 分钟 = 与主快照同步刷新，赛后详情最多延迟 1.5 小时。
 *
 * 🔴🔴 判据必须读 match_detail **自己的** updated_at（`detailAgeMin()`），
 *    不能用主闸的 `verdict.ageMin`（那是 schedule_cache 的年龄，上限只有 ~105 分钟，
 *    拿去比 180 恒不成立 → 详情在自动班次下一次都没推过）。详见 detailAgeMin 注释。
 * ⚠️ 探测器只在主闸已放行的班次调用（≈480 次请求/月），不是每 15 分钟一次。
 */
const DETAIL_MIN_INTERVAL_MIN = Number(process.env.SYNC_DETAIL_INTERVAL_MIN || 90)

/**
 * @returns {{skip:boolean, ageMin:number|null, reason:string}}
 *          skip=true 表示这次整班跳过全量推送（正常跳过，**不是错误**）。
 */
async function gate(cloud) {
  if (FORCE) return { skip: false, outage: false, ageMin: null, reason: '--force 已指定' }
  if (MIN_INTERVAL_MIN <= 0) return { skip: false, outage: false, ageMin: null, reason: '节流已关闭' }

  // 🔴 这一次读同时干两件事：识别「环境整体不可用」+ 取上次推送时间做节流。
  //    拆成两次读的话，每班多一次请求 × 96 班/天 = 每月多烧约 2900 次请求。
  let rows = null
  let error = null
  try {
    const res = await cloud.database
      .from('schedule_cache')
      .select('id, generated_at')
      .eq('id', 'latest')
    error = res && res.error
    rows = res && res.data
  } catch (err) {
    error = err
  }
  if (error && isOutage(error)) {
    return { skip: false, outage: true, ageMin: null, reason: '云环境整体不可用', detail: JSON.stringify(error).slice(0, 200) }
  }
  if (error) {
    // 非环境级故障 → fail-open：读不到就当必须推，比节流误跳过更安全
    return { skip: false, outage: false, ageMin: null, reason: `读云端失败（放弃节流）：${JSON.stringify(error).slice(0, 80)}` }
  }

  const at = Array.isArray(rows) && rows[0] && rows[0].generated_at
    ? new Date(rows[0].generated_at).getTime()
    : null
  // 读不到就当作必须推（比节流误跳过更安全）
  if (!at) return { skip: false, outage: false, ageMin: null, reason: '云端尚无历史行，按必须推送处理' }

  const ageMin = Math.round((Date.now() - at) / 60000)
  if (ageMin < MIN_INTERVAL_MIN) {
    return { skip: true, outage: false, ageMin, reason: `距上次推送仅 ${ageMin} 分钟（阈值 ${MIN_INTERVAL_MIN}）` }
  }
  return { skip: false, outage: false, ageMin, reason: `距上次推送 ${ageMin} 分钟，已过阈值 ${MIN_INTERVAL_MIN}` }
}

/**
 * `match_detail` 距上次推送多少分钟（读不到返回 null = 当作必须推）。
 *
 * 🔴🔴 2026-10-07 事故（用户报「今天湖人对勇士、TES 对 KSG 的赛后数据不全」）：
 *     原来这里是直接拿主闸的 `verdict.ageMin` 去比 `DETAIL_MIN_INTERVAL_MIN`(180)，
 *     但 `verdict.ageMin` 是 **schedule_cache** 的年龄，不是 match_detail 的：
 *       · 主闸只在 ageMin >= MIN_INTERVAL_MIN(90) 时放行；
 *       · 放行的那一班**立刻**把 schedule_cache 重写 → ageMin 归零重新累积；
 *       · 15 分钟一班，累积上限只有 ~105 分钟 → **永远够不到 180**。
 *     → `detailDue` 恒为 false → **详情在自动班次下一次都没推过**，
 *       只有 `--force`（ageMin=null）时才上云端 —— 这正是云端 match_detail 的
 *       updated_at 停在 10:00（那次是手动 --force）而其余 4 张表 18:01 正常刷新的原因。
 *     用户侧的后果：10:00 开赛的勇士vs湖人只存到开场那一下的壳，
 *       14:00 开赛的 KPL 三场压根没进桶。
 *     → 改成读 match_detail 自己的 updated_at。
 *
 * ⚠️ 只在「主闸已放行」的班次调用（约 16 次/天），不是每 15 分钟一次
 *    → 约 480 次请求/月，不是每班都读的那种 2880 次/月。
 * ⚠️ 不用 `.order()`：代码里从没用过这个 API，语法没把握；
 *    直接把 15 个日桶的 updated_at 拉回来本地取最大值，同样是一次请求。
 */
async function detailAgeMin(cloud) {
  try {
    const res = await cloud.database.from('match_detail').select('updated_at')
    const rows = (res && res.data) || []
    let newest = 0
    rows.forEach((r) => {
      const t = Date.parse((r && r.updated_at) || '')
      if (Number.isFinite(t) && t > newest) newest = t
    })
    if (!newest) return null
    return Math.round((Date.now() - newest) / 60000)
  } catch (err) {
    // 读不到就当必须推 —— fail-open，比节流误跳过更安全
    return null
  }
}

/**
 * 详情快通道：主闸跳过的班次，也别让「刚完赛的详情」干等 90 分钟。
 *
 * 🔴 为什么要有它（2026-10-07）：主闸 skip 时整班 return，`sync.js` / `match-detail.js`
 *    都不跑，详情要等到下一次主闸放行（实测 97 分钟后）才更新。而详情恰恰是**赛后**
 *    才有人看的东西 —— 用户刚看完比赛，点进去是空的，体验最差的时刻就是这一段。
 *
 * 快通道只做三件轻量事，然后才决定是否动重活：
 *   1) 读 `live_scores`（~4KB，60 秒粒度的最新状态）—— 1 次请求；
 *   2) 读「今天 + 昨天」两个日桶（~116KB），挑出**已完赛但仍是空壳**的场次 —— 1 次请求；
 *   3) 一个都没有就立刻返回（凌晨 / 无比赛时段零开销）；
 *      有才把最新状态喂给 `match-detail.js`（--status-json）补抓，并只推这两个桶。
 *
 * ⚠️ 必须喂最新状态：否则 match-detail 用的还是 97 分钟前的 `data/matches.js`，
 *    刚完赛的比赛在里头是 live/upcoming → needsFetch 走错分支 → 白跑一趟。
 * ⚠️ `live_scores` 只有 ESPN 赛事（KPL 不在里面）。KPL 走主闸那班，本通道覆盖不到。
 */
async function detailFastLane(cloud) {
  let tmp = null
  try {
    const lr = await cloud.database.from('live_scores').select('data')
    const rows = ((lr && lr.data && lr.data[0] && lr.data[0].data) || {}).rows || []
    if (!Array.isArray(rows) || !rows.length) return

    const live = {}
    rows.forEach((r) => {
      if (!r || !r.id || r.st !== 'finished') return
      live[r.id] = { status: 'finished', hs: r.hs, as: r.as }
    })
    // ⚠️ KPL 不在 live_scores 里（那张表只有 ESPN 赛事），单独问一次官方赛程补上。
    //    否则快通道对 KPL 等于不存在，它的赛后详情还是只能等主闸那 97 分钟。
    const kpl = await MD.fetchKplStatus()
    const kplN = Object.keys(kpl).length
    if (kplN) log(`详情快通道：KPL 官方赛程 ${kplN} 场已结束`)
    Object.keys(kpl).forEach((id) => { live[id] = kpl[id] })
    if (!Object.keys(live).length) return

    const now = Date.now()
    const ids = ['d-' + MD.dayKey(new Date(now).toISOString()), 'd-' + MD.dayKey(new Date(now - 86400000).toISOString())]
    // ⚠️ 不用 `.in()`：本仓库从没用过这个 API，没把握；两次 eq 各拉一个日桶，总共还是 ~116KB
    let buckets = []
    for (const id of ids) {
      const r = await cloud.database.from('match_detail').select('id, payload').eq('id', id)
      if (r && Array.isArray(r.data)) buckets = buckets.concat(r.data)
    }
    const payload = {}
    buckets.forEach((b) => {
      if (b && b.payload) Object.keys(b.payload).forEach((k) => { payload[k] = b.payload[k] })
    })

    // ⚠️ 只认「今天 / 昨天开赛」的场次。原因有二，都是实测踩的：
    //   · 上面只读了这两个日桶，更早的场次 `payload[id]` 必然是 undefined → 会被误判成空壳
    //     （实测 KPL 一次返回整赛季，W1/W2 那批 10-02、10-03 的老场全被当成了壳）；
    //   · 空壳补抓本来就有 48h / 24h 窗口，更早的场次交给主闸那一班更合适。
    const todayKey = MD.dayKey(new Date(now).toISOString())
    const ydayKey = MD.dayKey(new Date(now - 86400000).toISOString())
    const inRange = (start) => {
      const dk = MD.dayKey(start)
      return dk === todayKey || dk === ydayKey
    }

    // ⚠️ `match-detail.js` 的 targets 来自 `data/matches.js`，不在快照窗口里的比赛
    //    它压根不会抓。而 live_scores 实测会残留一些这样的老场次（10 场 chn-*），
    //    不剔除的话每班都会白跑一趟补抓 + 推两个桶。
    const local = require('../utils/snapshot').decodeSnapshot(require('../data/matches.js'))
    const known = new Map()
    ;(Array.isArray(local) ? local : (local && local.matches) || []).forEach((m) => known.set(m.id, m.start))

    /**
     * 这份详情还算「空壳」吗？
     * ⚠️ 不能只看 `fin`：实测 KPL 的 W6D2 已经抓全 4 局、只差 `fin` 还是 false，
     *    判成壳就会白补抓一次。反过来，**局数不足**也是壳（3:0 却只存了 1 局）。
     */
    const isShell = (d, id, o) => {
      if (!d) return true
      if (!MD.hasContent(d)) return true
      if (String(id).indexOf('kpl-') === 0) {
        const want = Number(o && o.hs || 0) + Number(o && o.as || 0)
        const have = d.kpl && Array.isArray(d.kpl.list) ? d.kpl.list.length : 0
        if (want > 0 && have < want) return true
      }
      return false
    }

    const need = {}
    Object.keys(live).forEach((id) => {
      const start = known.get(id)
      if (!start || !inRange(start)) return
      // ⚠️ 国际友谊赛、中北美国家联赛这类**故意不抓详情**的赛事永远不会出现在桶里，
      //    别把它们当成「空壳」—— 否则每班都会白白触发一次补抓。
      if (!MD.detailCapable(String(id).split('-')[0])) return
      if (!isShell(payload[id], id, live[id])) return
      need[id] = live[id]
    })
    const n = Object.keys(need).length
    if (!n) return

    log(`详情快通道：${n} 场已完赛仍是空壳，立即补抓 → ${Object.keys(need).slice(0, 5).join(', ')}${n > 5 ? ' …' : ''}`)
    tmp = path.join(__dirname, '..', '.detail-status.json')
    require('fs').writeFileSync(tmp, JSON.stringify(need))
    try {
      // ⚠️ --fast 一起传：常规 2 小时补抓间隔会让快通道「报了壳却一场都不抓」
      execFileSync(process.execPath, [path.join(__dirname, 'match-detail.js'), '--fast', '--status-json=' + tmp], { stdio: 'inherit' })
    } catch (err) {
      log(`详情快通道：补抓未产出（${(err && err.status) || (err && err.message) || ''}）`)
      return
    }
    try {
      delete require.cache[require.resolve('../data/match-details.js')]
    } catch (err) { /* 没缓存就直接 require */ }
    const details = require('../data/match-details.js')
    // ⚠️ 没真抓到场次就不推（gap 节流挡住了）→ 省掉一整轮 13 桶写入
    if (!details || !details.stats || !details.stats.fetched) return
    const push = (details.buckets || []).filter((b) => ids.indexOf(b.id) > -1 && b.payload && Object.keys(b.payload).length)
    if (!push.length) return
    log(`详情快通道：推送 ${push.length} 个日桶…`)
    const nowIso = new Date().toISOString()
    let done = 0
    for (const b of push) {
      const r = await pushRow(cloud, 'match_detail', {
        id: b.id, day: b.day, payload: b.payload, updated_at: nowIso, generated_at: nowIso,
      })
      if (r.ok) done += 1
    }
    log(`详情快通道：已写入 ${done}/${push.length} 个日桶（本轮抓取 ${details.stats.fetched} 场）`)
  } catch (err) {
    log(`详情快通道跳过（不影响主流程）：${(err && err.message) || err}`)
  } finally {
    if (tmp) {
      try { require('fs').unlinkSync(tmp) } catch (e) { /* 清理失败无所谓 */ }
    }
  }
}

/**
 * 往 GitHub Actions 的 step output 里写一个开关，供后续 step 判断是否值得一并执行。
 * 本地跑（没有 GITHUB_OUTPUT）时静默跳过 —— 这个文件只做增量通知，不影响主流程。
 */
function ghOut(key, value) {
  const file = process.env.GITHUB_OUTPUT
  if (!file) return
  try {
    require('fs').appendFileSync(file, `${key}=${value}\n`)
  } catch (err) {
    log(`（写 step output 失败，忽略）：${(err && err.message) || err}`)
  }
}

async function main() {
  // ⚠️ 云客户端在这里就建好 —— 节流闸要读云端，必须在抓取之前，省下的是 CPU 和配额两层成本。
  const cloud = createWorkBuddyCloud({
    endpoint: publicConfig.endpoint,
    publishableKey: publicConfig.publishableKey,
  })

  // 0) 一次极轻量的云端探测，同时完成两件事：
  //    ① 环境级故障（隔离 / 停服）→ **立刻收工**，退出码 0。
  //       否则每 15 分钟一班都要先跑满 2 分钟抓取再失败，既白烧 Actions 分钟数，
  //       又会让 GitHub 一天给你发 96 封失败邮件。详见 tools/cloud-outage.js。
  //    ② 正常 → 用同一个返回值做节流判断（顺带省下一次请求）。
  const verdict = await gate(cloud)
  if (verdict.outage) {
    log('⛔ 云环境当前整体不可用（隔离 / 停服），本班不重试、不算失败。')
    log(`   原因：${verdict.detail}`)
    log('   这是环境问题不是代码问题：恢复后下一班会自动照常同步，无需改代码、无需发版。')
    ghOut('pushed', 'false')
    return
  }
  log(`节流闸：${verdict.reason}`)
  if (verdict.skip) {
    log('⏭  本机跳过本班全量推送（约 0.8MB 落库已省下）；实时比分不受影响，仍在 60 秒粒度上跑')
    ghOut('pushed', 'false')
    // 🔴 全量跳过 ≠ 详情也跟着等：刚完赛的比赛详情走快通道补上（详见 detailFastLane 注释）
    await detailFastLane(cloud)
    return
  }
  ghOut('pushed', 'true')

  // 1) 刷新本地数据（reuse 全部抓取/归一化逻辑）
  log(`刷新本地赛程数据（回看 ${DAYS_BACK} 天，前瞻 ${DAYS_FORWARD} 天）…`)
  await withRetry('抓取数据源', () => {
    execFileSync(
      process.execPath,
      [path.join(__dirname, 'sync.js'), String(DAYS_BACK), String(DAYS_FORWARD)],
      { stdio: 'inherit' }
    )
  })

  // 2) 抓取积分榜（附加数据：失败只告警，不让赛程主链路跟着失败）
  let standings = null
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'standings.js')], { stdio: 'inherit' })
    delete require.cache[require.resolve('../data/standings.js')]
    standings = require('../data/standings.js')
  } catch (err) {
    console.warn('[cloud-sync] ⚠ 积分榜抓取失败，本次跳过推送：', (err && err.message) || err)
  }

  // 2b) 抓取比赛详情（事件时间轴 / 双方近况 / 历史交锋 / 技术统计）
  //     同样属于附加数据：失败只告警，不让赛程主链路跟着失败
  //
  // ⚠️ **子进程以 exit 3 退出不算失败** —— 那是「本轮没有需要抓的场次」的正常信号
  //    （`match-detail.js` 的增量规则：已结束的只抓一次、未开赛 12h 一次）。
  //    **刚跑过 `--force` 之后必然如此**：所有场次都已抓过。
  //    这时 `data/match-details.js` 里仍是上一轮的成果，**照样要推上去**。
  //    🔴 踩过的坑（2026-10-03）：把 exec 的异常当成"详情不可用"，结果
  //       先 `--force` 再 `cloud-sync` 时，详情整整一班没上云端，本地却一切正常。
  let details = null
  let execNote = ''
  // 🔴 `--force` 必须往下传。`match-detail.js` 的增量规则是「已结束的只抓一次」，
  //    而**球员中文名是抓的时候烘焙进 payload 的**（payload 只存解析后的名字字符串，
  //    不存 athlete id，事后无法回填）→ 字典更新后不 force 重抓，详情页会一直显示英文。
  //    2026-10-05 踩到：写完 271 条 NBA 中文名、跑了 `cloud-sync --force`，
  //    库里在单场详情页里仍然是 "Curry"。
  //    ⚠️ Actions 里从不带 --force，所以这条只影响手动执行，不会增加定时任务的请求量。
  const detailArgs = [path.join(__dirname, 'match-detail.js')]
  if (FORCE) detailArgs.push('--force')
  try {
    execFileSync(process.execPath, detailArgs, { stdio: 'inherit' })
  } catch (err) {
    execNote = (err && err.message) || String(err)
  }
  try {
    delete require.cache[require.resolve('../data/match-details.js')]
    details = require('../data/match-details.js')
    if (execNote) log(`详情增量抓取无新增（${execNote}），改用现有 data/match-details.js 推送`)
  } catch (err) {
    details = null
    console.warn('[cloud-sync] ⚠ 详情数据文件不可用，本次跳过推送：', (err && err.message) || err)
  }

  // 2c) 抓取射手榜 / 助攻榜。
  //     ⚠️ 只跑 ESPN 那一段（10 个请求），**不跑** tools/player-names.js ——
  //        球员中文名靠 Wikidata 逐个核验，要跑好几分钟，塞进 15 分钟一班的定时任务
  //        既慢又不值当。中文名在 player-names.js 生成时烘焙进 data/scorers.js，
  //        未收录的新球员回落英文短名（预期行为）。
  let scorers = null
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'scorers.js')], { stdio: 'inherit' })
    delete require.cache[require.resolve('../data/scorers.js')]
    scorers = require('../data/scorers.js')
  } catch (err) {
    console.warn('[cloud-sync] ⚠ 射手榜抓取失败，本次跳过推送：', (err && err.message) || err)
  }

  // 3) 读取刚生成的快照（注意：本进程尚未 require 过，拿到的是新文件）
  //    用新进程跑 sync，避免 sync.js 底部的 main() 在 require 时被执行两次
  //
  //    ⚠️ 这里推的是 **解码后的扁平数组**，不是紧凑格式 —— 这是有意为之：
  //       线上已发布的老版本小程序直接读 `main.data.data` 当数组用，
  //       推紧凑对象会让老版本拿到 undefined.length 而整块读取失败。
  //       紧凑格式只用于**代码包**（包体积才是稀缺资源），云端不差这几百 KB。
  //       等新版本铺开（老版本自然淘汰）后再考虑换，届时 utils/data.js 无需改动。
  delete require.cache[require.resolve('../data/matches.js')]
  delete require.cache[require.resolve('../data/meta.js')]
  const matches = decodeSnapshot(require('../data/matches.js'))
  const meta = require('../data/meta.js')
  log(`本地快照：${matches.length} 场，bundle 生成时间 ${meta.generatedAt || '(空)'}`)

  if (!Array.isArray(matches) || matches.length === 0) {
    console.error('[cloud-sync] 本地快照为空，拒绝推送（避免把云端也清空），请检查数据源。')
    process.exit(2)
  }

  // 4) 推送到云端（cloud 实例已在节流闸那一步建好，这里复用）
  log('推送云端 schedule_cache(id=latest) …')
  const pushed = await pushRow(cloud, 'schedule_cache', {
    id: 'latest',
    data: matches,
    meta,
    generated_at: new Date().toISOString(),
  })
  if (!pushed.ok) {
    // 探测阶段还好、推送时才撞上隔离，也按「环境问题」处理，不飘红。
    if (isOutage(pushed.problem)) {
      log('⛔ 推送时撞上云环境不可用，本班不重试、不算失败。')
      ghOut('pushed', 'false')
      return
    }
    console.error('[cloud-sync] 推送云端失败：', pushed.problem)
    process.exit(pushed.code)
  }
  log(`已写入云端：id=${pushed.row.id}，generated_at=${pushed.row.generated_at}，共 ${matches.length} 场`)

  if (standings && standings.tables && Object.keys(standings.tables).length) {
    log('推送云端 standings_cache(id=latest) …')
    const ps = await pushRow(cloud, 'standings_cache', {
      id: 'latest',
      data: standings,
      generated_at: new Date().toISOString(),
    })
    if (!ps.ok) {
      // 积分榜是增强数据，写不进去不该让整个同步任务失败
      console.warn('[cloud-sync] ⚠ 积分榜推送云端失败：', ps.problem)
    } else {
      log(`已写入云端 standings_cache：${Object.keys(standings.tables).length} 个赛事`)
    }
  } else {
    console.warn('[cloud-sync] ⚠ 本次没有可用的积分榜数据，跳过推送')
  }

  if (scorers && scorers.tables && Object.keys(scorers.tables).length) {
    log('推送云端 scorers_cache(id=latest) …')
    const psc = await pushRow(cloud, 'scorers_cache', {
      id: 'latest',
      data: scorers,
      generated_at: new Date().toISOString(),
    })
    if (!psc.ok) {
      // 射手榜同样是增强数据，写不进去不该让整个同步任务失败
      console.warn('[cloud-sync] ⚠ 射手榜推送云端失败：', psc.problem)
    } else {
      log(`已写入云端 scorers_cache：${Object.keys(scorers.tables).length} 个赛事`)
    }
  } else {
    console.warn('[cloud-sync] ⚠ 本次没有可用的射手榜数据，跳过推送')
  }

  // 2d) KPL 选手数据榜（9 张官方榜 → data/kpl-rank.js → 云表 kpl_rank）
  //        ⚠️ `kpl-rank.js` 自带 12 小时新鲜度闸门，绝大多数班次会直接打印一行
  //        「跳过抓取」就返回，不会给上游发请求（省额度）。
  //     ⚠️ exit 3 = 「上游没返回任何榜单」，沿用 match-detail 的约定：不算失败，
  //        保持原文件不动 —— 这里照常用现有 data/kpl-rank.js 推送。
  let kplRank = null
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'kpl-rank.js')], { stdio: 'inherit' })
  } catch (err) {
    log(`KPL 选手榜抓取跳过/无新增（${(err && err.status) || ''}），改用现有 data/kpl-rank.js 推送`)
  }
  try {
    delete require.cache[require.resolve('../data/kpl-rank.js')]
    kplRank = require('../data/kpl-rank.js')
  } catch (err) {
    kplRank = null
    console.warn('[cloud-sync] ⚠ KPL 选手榜数据文件不可用，本次跳过推送：', (err && err.message) || err)
  }

  if (kplRank && Array.isArray(kplRank.boards) && kplRank.boards.length) {
    log('推送云端 kpl_rank(id=latest) …')
    const pkr = await pushRow(cloud, 'kpl_rank', {
      id: 'latest',
      data: kplRank,
      generated_at: new Date().toISOString(),
    })
    if (!pkr.ok) console.warn('[cloud-sync] ⚠ KPL 选手榜推送云端失败：', pkr.problem)
    else log(`已写入云端 kpl_rank：${kplRank.boards.length} 张榜`)
  } else {
    console.warn('[cloud-sync] ⚠ 本次没有可用的 KPL 选手榜，跳过推送')
  }

  // ⚠️ 详情独立节流：**必须读 match_detail 自己的时间**，不能用主闸的 verdict.ageMin
  //    （理由见 detailAgeMin 的注释 —— 用主闸的年龄会导致它永远推不上去）。
  //    --force 时不读、照常推。
  const dAgeMin = FORCE ? null : await detailAgeMin(cloud)
  const detailDue = dAgeMin == null || dAgeMin >= DETAIL_MIN_INTERVAL_MIN
  if (details && details.buckets && details.buckets.length && !detailDue) {
    log(`⏭ match_detail 距上次推送 ${dAgeMin} 分钟 < ${DETAIL_MIN_INTERVAL_MIN}，本班跳过（省 ${details.buckets.length} 次写入）`)
  }
  if (details && details.buckets && details.buckets.length && detailDue) {
    log(`推送云端 match_detail（${details.buckets.length} 个日桶）…`)
    let done = 0
    const nowIso = new Date().toISOString()
    for (const b of details.buckets) {
      const r = await pushRow(cloud, 'match_detail', {
        id: b.id,
        day: b.day,
        payload: b.payload,
        generated_at: nowIso,
        updated_at: nowIso,
      })
      if (r.ok) done += 1
      else console.warn(`[cloud-sync] ⚠ 详情桶 ${b.id} 推送失败：`, r.problem)
    }
    log(`已写入云端 match_detail：${done}/${details.buckets.length} 个日桶`)

    // 清理过期桶（RLS 只允许删 7 天前的，写在这里才删得动）
    try {
      const cutoff = dayStamp(Date.now() - 7 * 24 * 3600 * 1000)
      await cloud.database.from('match_detail').delete().lt('day', cutoff)
      log(`已清理 match_detail 早于 ${cutoff} 的日桶`)
    } catch (err) {
      console.warn('[cloud-sync] ⚠ 清理过期详情桶失败：', (err && err.message) || err)
    }
  } else {
    console.warn('[cloud-sync] ⚠ 本次没有可用的比赛详情，跳过推送')
  }
}

/** 北京时间（UTC+8）下的 YYYYMMDD */
function dayStamp(ms) {
  const d = new Date(ms + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}

// 🔴 为什么加这道 require.main 守卫：2026-10-05 给节流闸写单测时要 require 本文件，
//    而它原本在模块顶层直接跑 main() —— 一 require 就真的发起一轮云端同步。
module.exports = { gate, MIN_INTERVAL_MIN, DAYS_BACK, DAYS_FORWARD }

if (require.main === module) {
  main().catch((err) => {
    console.error('[cloud-sync] 未预期错误：', err && err.stack ? err.stack : err)
    process.exit(1)
  })
}
