/**
 * 云端快照新鲜度自检
 * ============================================================
 * 用途：只读地确认云端 schedule_cache(id='latest') 的数据有多新，
 *       用来验收 GitHub Actions 定时同步是否真的生效。
 *
 * 用法： node tools/check-cloud.js
 *
 * 退出码：0 = 数据新鲜（未超阈值）；2 = 数据陈旧；1 = 读取失败。
 */

const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk')
const publicConfig = require('../utils/cloud-config')
const { isOutage } = require('./cloud-outage')

/** 陈旧阈值（分钟），与 utils/data.js 的 STALE_MS 保持一致。
 *  对齐真实刷新粒度（GitHub 定时实测约 2.5~3 小时一次），
 *  避免在本机单独跑这个校验时，仅仅因为还没轮到下一班就误报「陈旧」。 */
const STALE_MINUTES = 180

async function main() {
  const cloud = createWorkBuddyCloud({
    endpoint: publicConfig.endpoint,
    publishableKey: publicConfig.publishableKey,
  })

  const { data, error } = await cloud.database
    .from('schedule_cache')
    .select('id, generated_at')
    .eq('id', 'latest')

  if (error) {
    // 🔴 环境级故障（隔离 / 停服）时退出码 0：这是环境问题不是同步问题，
    //    重试也没用，不该让每 15 分钟一班的工作流持续飘红、天天几百封失败邮件。
    if (isOutage(error)) {
      console.log('[check-cloud] ⛔ 云环境当前整体不可用，跳过新鲜度校验（环境问题，不算失败）')
      console.log('   ' + JSON.stringify(error).slice(0, 200))
      return
    }
    console.error('[check-cloud] 读取云端失败：', JSON.stringify(error))
    process.exit(1)
  }

  const row = (data || [])[0]
  if (!row) {
    console.error('[check-cloud] 云端没有 latest 行，同步从未成功过。')
    process.exit(1)
  }

  // 积分榜是附加数据，只报告、不改变退出码 —— 它写失败不该让定时同步判红
  await reportStandings(cloud)

  const gen = new Date(row.generated_at)
  const minutes = Math.round((Date.now() - gen.getTime()) / 60000)
  const localTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(gen)

  console.log('[check-cloud] 云端 generated_at =', row.generated_at)
  console.log('[check-cloud] 北京时间 =', localTime)
  console.log('[check-cloud] 距今 =', minutes, '分钟')
  console.log(
    minutes <= STALE_MINUTES
      ? `[check-cloud] ✅ 数据新鲜（阈值 ${STALE_MINUTES} 分钟）`
      : `[check-cloud] ⚠️ 数据陈旧，超过阈值 ${STALE_MINUTES} 分钟`
  )

  process.exit(minutes <= STALE_MINUTES ? 0 : 2)
}

/**
 * 积分榜新鲜度：只打印，不参与退出码。
 * 需要一行可见的状态，否则 standings_cache 写失败会一直静默（cloud-sync 那边只告警）。
 */
async function reportStandings(cloud) {
  try {
    const { data, error } = await cloud.database
      .from('standings_cache')
      .select('data, generated_at')
      .eq('id', 'latest')
      .maybeSingle()
    if (error || !data || !data.data || !data.data.tables) {
      console.log('[check-cloud] ⚠ 云端没有积分榜数据（附加功能，不影响比分）')
      return
    }
    const tables = data.data.tables || {}
    const mins = Math.round((Date.now() - new Date(data.generated_at).getTime()) / 60000)
    const flag = mins <= STALE_MINUTES ? '✅' : '⚠️'
    console.log(`[check-cloud] ${flag} 积分榜 ${Object.keys(tables).length} 个赛事，距今 ${mins} 分钟`)
  } catch (err) {
    console.log('[check-cloud] ⚠ 积分榜校验异常（不影响主链路）：', (err && err.message) || err)
  }
}

main().catch((err) => {
  console.error('[check-cloud] 异常：', (err && err.message) || err)
  process.exit(1)
})
