/** LOL 系列赛 MVP 投票：每名已登录用户每场一票，可改投。 */
const { cloud, isReady, getSession, unavailableMessage } = require('./cloud')

function fail(message, code) {
  return { data: null, error: { message, code: code || 'unknown' } }
}

async function session() {
  if (!isReady()) return { value: null, error: fail(unavailableMessage(), 'sdk-missing') }
  try {
    const result = await getSession()
    if (result.error) return { value: null, error: fail('登录状态读取失败，请重试', 'session') }
    return { value: result.data, error: null }
  } catch (error) {
    return { value: null, error: fail(error && error.message || '登录状态读取失败，请重试', 'session') }
  }
}

async function summary(matchId) {
  if (!isReady()) return fail(unavailableMessage(), 'sdk-missing')
  try {
    const { data, error } = await cloud.database.rpc('get_lol_mvp_vote_summary', { p_match_id: matchId })
    if (error) return fail(error.message || '读取投票结果失败', error.code || 'db')
    return { data: Array.isArray(data) ? data : [], error: null }
  } catch (error) {
    return fail(error && error.message || '读取投票结果失败', 'network')
  }
}

function detailBucket(start) {
  const time = Date.parse(start)
  if (!Number.isFinite(time)) return ''
  return `d-${new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '')}`
}

async function vote(matchId, start, playerId) {
  const gate = await session()
  if (gate.error) return gate.error
  if (!gate.value) return fail('请先登录后再投票', 'unauthenticated')
  const bucketId = detailBucket(start)
  if (!bucketId) return fail('比赛日期无效，暂时不能投票', 'invalid-match')
  try {
    const { data, error } = await cloud.database.rpc('cast_lol_mvp_vote', {
      p_match_id: matchId,
      p_player_id: playerId,
      p_day_bucket: bucketId,
    })
    if (error) return fail(error.message || '投票失败，请重试', error.code || 'db')
    return { data, error: null }
  } catch (error) {
    return fail(error && error.message || '投票失败，请重试', 'network')
  }
}

module.exports = { summary, vote, detailBucket }
