/**
 * 云端赛程缓存同步脚本
 * ============================================================
 * 用途：把最新赛程快照推送到云表 schedule_cache，让小程序「每次打开即读云端」，
 *       无需重新发布就能看到最新比分。配合每小时自动化调用即可自动保持新鲜。
 *
 * 用法： node tools/cloud-sync.js [daysBack] [daysForward]
 *   默认回看 14 天、前瞻 45 天（与 sync.js 一致）。
 *
 * 流程：
 *   1) 复用 tools/sync.js 抓取数据源、刷新本地 data/matches.js、data/meta.js
 *      （本地数据同时作为联网失败时的兜底）
 *   2) 复用 tools/standings.js 抓取积分榜、刷新本地 data/standings.js
 *      附加数据：失败只告警，不让主链路跟着失败（与 daily_brief 一个约定）
 *   3) 读取刚生成的快照
 *   4) 用 Node 云 SDK（以 publishableKey 的 anon 身份）upsert 进
 *      schedule_cache(id='latest') 与 standings_cache(id='latest')
 *
 * 退出码：任何一步失败都以非零退出，便于自动化捕获告警。
 */

const { execFileSync } = require('child_process')
const path = require('path')
const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk')
const publicConfig = require('../utils/cloud-config')

const DAYS_BACK = Number(process.argv[2] || 14)
const DAYS_FORWARD = Number(process.argv[3] || 45)

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

async function main() {
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
  let details = null
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'match-detail.js')], { stdio: 'inherit' })
    delete require.cache[require.resolve('../data/match-details.js')]
    details = require('../data/match-details.js')
  } catch (err) {
    console.warn('[cloud-sync] ⚠ 比赛详情抓取失败，本次跳过推送：', (err && err.message) || err)
  }

  // 3) 读取刚生成的快照（注意：本进程尚未 require 过，拿到的是新文件）
  //    用新进程跑 sync，避免 sync.js 底部的 main() 在 require 时被执行两次
  delete require.cache[require.resolve('../data/matches.js')]
  delete require.cache[require.resolve('../data/meta.js')]
  const matches = require('../data/matches.js')
  const meta = require('../data/meta.js')
  log(`本地快照：${matches.length} 场，bundle 生成时间 ${meta.generatedAt || '(空)'}`)

  if (!Array.isArray(matches) || matches.length === 0) {
    console.error('[cloud-sync] 本地快照为空，拒绝推送（避免把云端也清空），请检查数据源。')
    process.exit(2)
  }

  // 4) 推送到云端
  const cloud = createWorkBuddyCloud({
    endpoint: publicConfig.endpoint,
    publishableKey: publicConfig.publishableKey,
  })

  log('推送云端 schedule_cache(id=latest) …')
  const pushed = await pushRow(cloud, 'schedule_cache', {
    id: 'latest',
    data: matches,
    meta,
    generated_at: new Date().toISOString(),
  })
  if (!pushed.ok) {
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

  if (details && details.buckets && details.buckets.length) {
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

main().catch((err) => {
  console.error('[cloud-sync] 未预期错误：', err && err.stack ? err.stack : err)
  process.exit(1)
})
