/** Per-match WeChat notification consent records, linked to the user's favorite. */
const { cloud, isReady, getSession, unavailableMessage } = require('./cloud')

function fail(message, code) {
  return { data: null, error: { message, code: code || 'unknown' } }
}

async function rpc(name, args, fallback) {
  if (!isReady()) return fail(unavailableMessage(), 'sdk-missing')
  try {
    const session = await getSession()
    if (session.error) return fail('登录状态读取失败，请重试', 'session')
    if (!session.data) return fail('请先登录后再设置比赛通知', 'unauthenticated')
    const result = await cloud.database.rpc(name, args)
    if (result.error) return fail(result.error.message || fallback, result.error.code || 'db')
    return { data: result.data, error: null }
  } catch (error) {
    return fail(error && error.message || fallback, 'network')
  }
}

function states(matchId) {
  return rpc('get_match_notification_states', { p_match_id: String(matchId || '') }, '读取比赛通知状态失败')
}

function subscribe(matchId, kinds) {
  const active = (Array.isArray(kinds) ? kinds : []).filter(kind => ['pre60', 'result'].includes(kind))
  if (!active.length) return Promise.resolve(fail('15分钟提醒已停用，请选择有效通知', 'retired'))
  return rpc('subscribe_match_notifications', {
    p_match_id: String(matchId || ''),
    p_kinds: active,
  }, '保存比赛通知授权失败')
}

function cancel(matchId) {
  return rpc('cancel_match_notification_subscriptions', { p_match_id: String(matchId || '') }, '取消比赛通知失败')
}

module.exports = { states, subscribe, cancel }
