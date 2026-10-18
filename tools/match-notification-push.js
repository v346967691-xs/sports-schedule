/** Claims and sends user-authorized pre-match and result notifications for every competition. */
const config = require('../utils/cloud-config')
const notificationConfig = require('../utils/match-notification-config')
const core = require('../utils/match-notification-core')

const MAX_ATTEMPTS = 3

function recipientOpenId(ownerId) {
  const value = String(ownerId || '')
  return value.startsWith('wx:') && value.length > 3 ? value.slice(3) : ''
}

async function jsonRequest(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) })
  const body = await response.json()
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return body
}

async function accessToken(appId, appSecret) {
  const url = new URL('https://api.weixin.qq.com/cgi-bin/token')
  url.searchParams.set('grant_type', 'client_credential')
  url.searchParams.set('appid', appId)
  url.searchParams.set('secret', appSecret)
  const result = await jsonRequest(url, { method: 'GET' })
  if (!result.access_token) throw new Error(`WeChat token error ${result.errcode || 'unknown'}`)
  return result.access_token
}

async function templates(token) {
  const url = new URL('https://api.weixin.qq.com/wxaapi/newtmpl/gettemplate')
  url.searchParams.set('access_token', token)
  const result = await jsonRequest(url, { method: 'GET' })
  if (Number(result.errcode || 0) !== 0 || !Array.isArray(result.data)) {
    throw new Error(`WeChat template lookup error ${result.errcode || 'unknown'}`)
  }
  const wanted = new Set(Object.values(notificationConfig.templates))
  const found = {}
  result.data.forEach((item) => { if (wanted.has(item.priTmplId)) found[item.priTmplId] = item })
  if (Array.from(wanted).some((id) => !found[id])) throw new Error('A configured subscription template is absent from the mini-program account')
  return found
}

async function send(token, message) {
  const url = new URL('https://api.weixin.qq.com/cgi-bin/message/subscribe/send')
  url.searchParams.set('access_token', token)
  const result = await jsonRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  })
  if (Number(result.errcode || 0) !== 0) {
    const error = new Error(`WeChat send error ${result.errcode}: ${result.errmsg || ''}`)
    error.code = Number(result.errcode)
    throw error
  }
  return result
}

function createMessage(row, match, template, state) {
  match = require('../utils/tennis-names').localizeMatch(match)
  const recipient = recipientOpenId(row.owner_id)
  if (!recipient) throw new Error('Unsupported account identifier')
  const comp = require('../data/meta').competitions.find(item => item.key === match.comp) || {}
  // 🔴 赛事名的显示口径走 `comp.name`（**不是 `comp.full`**）：full 最长 26 字符
  //    （「中国各级国家队（男足 / 女足 / 国奥 / 国青）」），会被 thing 的 20 字符上限
  //    截成半截话。name 最长 8 字符（U17女足世界杯），稳。
  //    compCat 用来填「赛事类别」（足球 / 篮球 / 电竞）。
  const contentMatch = Object.assign({}, match, {
    compName: comp.name || comp.full || match.comp,
    compCat: comp.cat,
  })
  const mappedData = core.templateData(contentMatch, template.content, row.kind === 'result' ? 'result' : row.kind,
    row.kind === 'result' ? { remark: require('./brief-write').summary(match) } : {})
  if (!Object.keys(mappedData).length) throw new Error('Subscription template has no readable data fields')
  return {
    touser: recipient,
    template_id: template.priTmplId,
    page: `pages/detail/detail?id=${encodeURIComponent(match.id)}`,
    data: mappedData,
    miniprogram_state: state,
    lang: 'zh_CN',
  }
}

function expired(match, kind, now = Date.now()) {
  if (!match || !match.comp) return true
  const start = Date.parse(match.start || '')
  if (!Number.isFinite(start)) return kind !== 'result'
  if (kind === 'pre60') return match.status !== 'upcoming' || now >= start - 15 * 60 * 1000
  if (kind === 'pre15') return !['upcoming', 'live'].includes(match.status) || now > start + 10 * 60 * 1000
  return false
}

async function claim(cloud, workerToken, now) {
  const result = await cloud.database.rpc('claim_due_match_notifications', { p_token: workerToken, p_now: new Date(now).toISOString() })
  if (result.error) throw new Error('Could not claim due match notifications')
  return Array.isArray(result.data) ? result.data : []
}

async function mark(cloud, workerToken, row, values) {
  const result = await cloud.database.rpc('finish_match_notification', {
    p_token: workerToken, p_owner_id: row.owner_id, p_match_id: row.match_id,
    p_kind: row.kind, p_status: values.status, p_claimed_at: row.claimed_at,
    p_error: values.last_error || null,
  })
  if (result.error) throw new Error('Could not update match notification state')
  if (Number(result.data) !== 1) throw new Error('Notification claim changed before completion')
  return true
}

async function processRow(cloud, workerToken, row, templateById, token, state, now) {
  const match = row.match_data
  if (expired(match, row.kind, now)) {
    await mark(cloud, workerToken, row, { status: 'expired' })
    return 'expired'
  }
  try {
    const templateId = notificationConfig.templateId(row.kind)
    await send(token, createMessage(row, match, templateById[templateId], state))
  } catch (error) {
    const terminal = [40003, 40037, 43101, 47003, 41030].includes(error.code)
    const status = terminal || Number(row.attempts || 0) >= MAX_ATTEMPTS ? 'failed' : 'pending'
    await mark(cloud, workerToken, row, { status, last_error: String(error && error.message || 'send failed').slice(0, 200) })
    return 'failed'
  }
  // 微信已发送成功时，回写错误不能被当成发送失败再次入队。
  await mark(cloud, workerToken, row, { status: 'sent', last_error: null })
  return 'sent'
}

async function main(cloud, env = process.env, now = Date.now(), options = {}) {
  if (!notificationConfig.isConfigured()) throw new Error('Notification templates are not configured')
  const missing = ['NOTIFY_TOKEN', 'WECHAT_APP_ID', 'WECHAT_APP_SECRET'].filter(key => !env[key])
  if (missing.length) throw new Error(`Missing notification configuration: ${missing.join(', ')}`)
  if (!/^[a-f0-9]{64}$/.test(env.NOTIFY_TOKEN)) throw new Error('NOTIFY_TOKEN must be a 64-character random hexadecimal token')
  if (options.checkOnly) {
    const result = await cloud.database.rpc('check_match_notification_worker', { p_token: env.NOTIFY_TOKEN })
    if (result.error || result.data !== true) throw new Error('Notification worker authentication check failed')
    const token = await accessToken(env.WECHAT_APP_ID, env.WECHAT_APP_SECRET)
    const found = await templates(token)
    return { checked: true, templates: Object.keys(found).length, sent: 0 }
  }
  // Runner-local negative cache only. No extra cloud SELECT, no cached recipients or tokens.
  // Bounded at 45s: the normal 60s loop still checks each round; failed/nonempty claims are never cached.
  const cacheFile = env.NOTIFICATION_EMPTY_CACHE
  const fs = require('node:fs')
  if (cacheFile && !options.force) {
    try {
      const stamp = Number(fs.readFileSync(cacheFile, 'utf8'))
      if (stamp > 0 && now >= stamp && now - stamp < 45000) return { processed: 0, sent: 0, emptyCache: true }
    } catch (_) { /* Missing or invalid state means claim normally. */ }
  }
  if (cacheFile) { try { fs.unlinkSync(cacheFile) } catch (_) { /* Optional local state. */ } }
  const rows = await claim(cloud, env.NOTIFY_TOKEN, now)
  if (!rows.length) {
    if (cacheFile) {
      try { fs.writeFileSync(cacheFile, String(now)) } catch (_) { /* Never block delivery on diagnostics. */ }
    }
    return { processed: 0, sent: 0 }
  }
  const token = await accessToken(env.WECHAT_APP_ID, env.WECHAT_APP_SECRET)
  const templateById = await templates(token)
  const state = ['developer', 'trial', 'formal'].includes(env.WECHAT_MINIPROGRAM_STATE) ? env.WECHAT_MINIPROGRAM_STATE : 'formal'
  const counts = { sent: 0, expired: 0, failed: 0 }
  for (const row of rows) {
    const result = await processRow(cloud, env.NOTIFY_TOKEN, row, templateById, token, state, now)
    if (Object.prototype.hasOwnProperty.call(counts, result)) counts[result] += 1
  }
  return Object.assign({ processed: rows.length }, counts)
}

if (require.main === module) {
  const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk')
  const cloud = createWorkBuddyCloud({ endpoint: config.endpoint, publishableKey: config.publishableKey })
  main(cloud, process.env, Date.now(), { checkOnly: process.argv.includes('--check') }).then((result) => {
    console.log('[match-notification]', JSON.stringify(result))
    if (result.failed) process.exitCode = 1
  }).catch((error) => {
    console.error('[match-notification]', error && error.message || 'failed')
    process.exitCode = 1
  })
}

module.exports = { recipientOpenId, createMessage, expired, claim, mark, processRow, main }
