/**
 * 云环境整体不可用的识别与降级
 * ============================================================
 * 背景（2026-10-05 事故）：免费版云额度耗尽后，CloudBase 的 PG 实例被**隔离**，
 * 此后**所有**云表读写一律返回 503 / DATABASE_RESOURCE_ISOLATED。
 *
 * 这不是数据错误，也不是脚本 bug —— 重试没有任何意义，而且定时任务是每 15 分钟一班：
 *   · 每班都失败 → 工作流持续飘红 → **一天收 96 封 GitHub 失败邮件**，27 天就是 2600 封；
 *   · 每班还要先跑 2 分钟的完整 ESPN 抓取再失败 → 白烧 Actions 分钟数（约 190 分钟/天）。
 *
 * 所以这里做的是**早退**：探测到「环境级不可用」就立刻收工，退出码 0（不是失败）。
 *   ① 不制造邮件噪音；② 不白烧 Actions 分钟；③ 恢复后下一班会自动照常干活。
 *
 * 🔴 退出码必须是 0 且日志必须写清楚「这是环境问题，不是代码问题」——
 *    否则下次排查的人会以为同步逻辑坏了，往错误方向查。
 */

/** 环境级故障的错误码。新增一种就往这里加，别在业务代码里散着写。 */
const OUTAGE_CODES = [
  'DATABASE_RESOURCE_ISOLATED', // PG 实例被隔离（欠费 / 额度耗尽 / 停服）
  'res_stopped', // 同一件事在另一层接口的叫法
  'RESOURCE_ISOLATED',
  'ENVIRONMENT_NOT_FOUND',
]

/**
 * 从云 SDK 返回的错误对象里认出「环境级不可用」。
 * 错误可能是 { code } / { message } / 字符串，容错处理。
 */
function isOutage(err) {
  if (!err) return false
  if (typeof err === 'string') return OUTAGE_CODES.some((c) => err.indexOf(c) !== -1)
  const hay = [err.code, err.message, err.error && err.error.code, err.error && err.error.message]
    .filter(Boolean)
    .join(' ')
  if (!hay) return false
  // res_stopped 这种太短、容易误伤普通文本，只在 message 里按词匹配
  return OUTAGE_CODES.some((c) => hay.indexOf(c) !== -1)
}

/**
 * 做一次极轻量的探测（只读一个字段），判断环境是否整体不可用。
 * @param cloud 已初始化的云客户端
 * @returns {outage:boolean, detail:string}
 */
async function detectOutage(cloud) {
  try {
    const res = await cloud.database
      .from('schedule_cache')
      .select('id')
      .eq('id', 'latest')
      .limit(1)
    if (res && res.error && isOutage(res.error)) {
      return { outage: true, detail: JSON.stringify(res.error).slice(0, 200) }
    }
    return { outage: false, detail: '' }
  } catch (err) {
    if (isOutage(err)) return { outage: true, detail: String((err && err.message) || err).slice(0, 200) }
    return { outage: false, detail: '' }
  }
}

module.exports = { isOutage, detectOutage, OUTAGE_CODES }
