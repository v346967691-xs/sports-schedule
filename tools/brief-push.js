/**
 * 日报推送脚本
 * ============================================================
 * 用途：生成最近若干天的日报（早报 06:00 / 晚报 21:00 双轨），upsert 进云表 daily_brief，
 *       小程序打开「日报」页即从云端读取，无需重新发布小程序。
 *
 * 用法： node tools/brief-push.js [回溯天数，默认 2]
 *
 * 设计要点：
 *   1) 幂等 —— 每次运行都重算最近 N 天的全部期次。
 *      即使某一班 GitHub 定时没投递（实测会漏），下一班也会把缺的期补上。
 *   2) 依赖本地快照 data/matches.js，所以必须先跑过 cloud-sync 刷新数据，
 *      否则生成的是陈旧内容。workflow 里两个脚本前后串联。
 *   3) 不推图片 —— 分享图方案未定，日报页面暂不展示配图。
 *   4) 未到出报时刻的期次不落库 —— 本脚本幂等重算最近两天，若不拦这一道，
 *      下午 3 点跑的时候就会把「当天 21:00 的晚报」写进云表，而那一刻晚窗口
 *      （06:00–18:00 开赛）的比赛还没打完，落的是残稿，客户端还会提前展示出来。
 *      ⚠️ 已经写进去的未来行删不掉：daily_brief 的 DELETE 策略只允许删 90 天前的，
 *      所以只能在源头拦住。历史遗留的未来行需人工用管理员角色清理。
 *
 * 退出码：0 成功；1 失败（任一期推送报错就整体失败，便于自动化告警）。
 */

const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk')
const publicConfig = require('../utils/cloud-config')
const B = require('./brief-build.js')
const W = require('./brief-window.js')   // isDue：出报时刻未到的期次不落库

const DAYS_BACK = Number(process.argv[2] || 2)

const RETRY_ATTEMPTS = 3
const RETRY_BASE_MS = 2000

function log(...args) { console.log('[brief-push]', ...args) }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function withRetry(label, fn) {
  let lastErr
  for (let i = 1; i <= RETRY_ATTEMPTS; i += 1) {
    try { return await fn() } catch (err) {
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

/** 当前北京日期 YYYY-MM-DD */
function todayBJ() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
}

function shiftDay(dateStr, delta) {
  return new Date(Date.parse(dateStr + 'T00:00:00Z') + delta * 86400000).toISOString().slice(0, 10)
}

async function main() {
  const cloud = createWorkBuddyCloud({
    endpoint: publicConfig.endpoint,
    publishableKey: publicConfig.publishableKey,
  })

  const today = todayBJ()
  const dates = []
  for (let i = DAYS_BACK - 1; i >= 0; i -= 1) dates.push(shiftDay(today, -i))

  log('北京日期 ' + today + '，生成 ' + dates.join(' / ') + ' 的日报')

  const rows = []
  const pending = []      // 出报时刻还没到，跳过的期次
  let report = 0; let preview = 0; let empty = 0

  const nowMs = Date.now()

  dates.forEach((ds) => {
    ['morning', 'evening'].forEach((kind) => {
      const o = B.build(ds, kind)
      if (o.mode === 'empty') { empty += 1; return }
      // 出报时刻未到 → 跳过，等到了点由后续那一班自然地补上来
      if (!W.isDue(o.pubAt, nowMs)) { pending.push(o.id); return }
      if (o.mode === 'report') report += 1; else preview += 1
      rows.push({
        id: o.id,
        kind: o.kind,
        date: o.date,
        pub_at: o.pubAt,
        mode: o.mode,
        payload: o,
        generated_at: o.generatedAt,
      })
    })
  })

  log('战报 ' + report + ' 期，前瞻 ' + preview + ' 期，无素材 ' + empty + ' 期'
    + (pending.length ? '，未到出报时刻跳过 ' + pending.length + ' 期（' + pending.join(', ') + '）' : ''))

  if (!rows.length) {
    log('没有任何可推送的日报，跳过。')
    return
  }

  const { data, error } = await withRetry('推送 daily_brief', () =>
    cloud.database
      .from('daily_brief')
      .upsert(rows, { onConflict: 'id' })
      .select('id'))

  if (error) {
    console.error('[brief-push] 推送失败：', JSON.stringify(error))
    process.exit(1)
  }

  log('已推送 ' + ((data && data.length) || rows.length) + ' 期：'
    + rows.map((r) => r.id).join(', '))

  // 顺带清掉过期数据（RLS 只允许删 90 天前的，删不掉也不会报错）
  const { error: delErr } = await cloud.database
    .from('daily_brief')
    .delete()
    .lt('generated_at', new Date(Date.now() - 90 * 86400000).toISOString())
  if (delErr) log('清理旧数据跳过（' + JSON.stringify(delErr).slice(0, 120) + '）')
  else log('已清理 90 天前的旧日报')
}

main().catch((err) => {
  console.error('[brief-push] 异常：', err && err.stack ? err.stack : err)
  process.exit(1)
})
