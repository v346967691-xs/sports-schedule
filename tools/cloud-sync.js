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

/**
 * `match_detail` 的独立节流（分钟）。它按「天」分桶，一次推送要写 11 行，
 * 是单次全量推送里请求数最大的一块（16 班/天 × 11 = 176 次/天，占全量写入的 78%）。
 * 而详情（时间轴 / 近况 / 交锋 / 技术统计）本身变化就慢，3 小时刷一次足够。
 * ⚠️ 用的是主节流闸已经拿到的 ageMin，**不额外发一次请求**。
 */
const DETAIL_MIN_INTERVAL_MIN = Number(process.env.SYNC_DETAIL_INTERVAL_MIN || 180)

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

  // ⚠️ 详情独立节流：--force（ageMin 为 null）时照常推。
  const detailDue = verdict.ageMin == null || verdict.ageMin >= DETAIL_MIN_INTERVAL_MIN
  if (details && details.buckets && details.buckets.length && !detailDue) {
    log(`⏭ match_detail 距上次推送 ${verdict.ageMin} 分钟 < ${DETAIL_MIN_INTERVAL_MIN}，本班跳过（省 11 次写入）`)
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
