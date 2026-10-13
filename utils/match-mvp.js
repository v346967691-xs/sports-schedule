/** NBA、足球与 KPL 的比赛 MVP 票选。候选人资格与不可改票均由云端校验。 */
const { cloud, isReady, getSession, unavailableMessage } = require('./cloud')
const { detailBucket } = require('./lol-mvp')
const fail = (message, code) => ({ data: null, error: { message, code: code || 'unknown' } })

async function summary(matchId) {
  if (!isReady()) return fail(unavailableMessage(), 'sdk-missing')
  try {
    const { data, error } = await cloud.database.rpc('get_match_mvp_vote_summary', { p_match_id: matchId })
    if (error) return fail(error.message || '读取投票结果失败', error.code || 'db')
    return { data: Array.isArray(data) ? data : [], error: null }
  } catch (error) { return fail(error.message || '读取投票结果失败', 'network') }
}

async function vote(matchId, start, playerId) {
  if (!isReady()) return fail(unavailableMessage(), 'sdk-missing')
  try {
    const session = await getSession()
    if (session.error) return fail('登录状态读取失败，请重试', 'session')
    if (!session.data) return fail('请先登录后再投票', 'unauthenticated')
    const bucket = detailBucket(start)
    if (!bucket) return fail('比赛日期无效，暂时不能投票', 'invalid-match')
    const { data, error } = await cloud.database.rpc('cast_match_mvp_vote', {
      p_match_id: matchId, p_player_id: playerId, p_day_bucket: bucket,
    })
    if (error) return fail(error.message || '投票失败，请重试', error.code || 'db')
    return { data, error: null }
  } catch (error) { return fail(error.message || '投票失败，请重试', 'network') }
}
module.exports = { summary, vote }
