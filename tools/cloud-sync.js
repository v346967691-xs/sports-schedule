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
 *   2) 读取刚生成的快照
 *   3) 用 Node 云 SDK（以 publishableKey 的 anon 身份）upsert 进 schedule_cache(id='latest')
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
async function pushSnapshot(cloud, snapshot) {
  let problem = ''
  for (let i = 1; i <= RETRY_ATTEMPTS; i += 1) {
    let result = null
    try {
      result = await cloud.database.from('schedule_cache').upsert(snapshot).select('id, generated_at')
    } catch (err) {
      problem = `请求异常：${(err && err.message) || err}`
    }
    if (result) {
      if (result.error) {
        problem = `云端返回错误：${JSON.stringify(result.error)}`
      } else if (!Array.isArray(result.data) || result.data.length === 0) {
        // RLS 拦截：schedule_cache 的写入策略只允许 id='latest'
        return { ok: false, code: 4, problem: '云端写入被拦截（返回 0 行），请检查 schedule_cache 的写入策略' }
      } else {
        return { ok: true, code: 0, row: result.data[0] }
      }
    }
    if (i < RETRY_ATTEMPTS) {
      const wait = RETRY_BASE_MS * i
      log(`推送云端第 ${i} 次未成功（${problem}），${wait}ms 后重试…`)
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

  // 2) 读取刚生成的快照（注意：本进程尚未 require 过，拿到的是新文件）
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

  // 3) 推送到云端
  const cloud = createWorkBuddyCloud({
    endpoint: publicConfig.endpoint,
    publishableKey: publicConfig.publishableKey,
  })

  const snapshot = {
    id: 'latest',
    data: matches,
    meta,
    generated_at: new Date().toISOString(),
  }

  log('推送云端 schedule_cache(id=latest) …')
  const pushed = await pushSnapshot(cloud, snapshot)
  if (!pushed.ok) {
    console.error('[cloud-sync] 推送云端失败：', pushed.problem)
    process.exit(pushed.code)
  }
  log(`已写入云端：id=${pushed.row.id}，generated_at=${pushed.row.generated_at}，共 ${matches.length} 场`)
}

main().catch((err) => {
  console.error('[cloud-sync] 未预期错误：', err && err.stack ? err.stack : err)
  process.exit(1)
})
