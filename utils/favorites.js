/**
 * 「关注比赛」数据访问
 *
 * 云端表 public.favorites：owner_id TEXT DEFAULT auth.uid() + owner 级 RLS，
 * 前端从不发送 owner_id，由数据库自己写入并做隔离。
 */

const { cloud, isReady, getSession, unavailableMessage } = require('./cloud')

const TABLE = 'favorites'

function fail(message, kind) {
  return { data: null, error: { message, kind: kind || 'unknown' } }
}

/** 用户数据门槛：没有会话就不读写 */
async function sessionOrNull() {
  if (!isReady()) { return { session: null, error: fail(unavailableMessage(), 'sdk-missing') } }
  const { data: session, error } = await getSession()
  if (error || !session) return { session: null, error: null }
  return { session, error: null }
}

async function list() {
  const gate = await sessionOrNull()
  if (gate.error) return gate.error
  if (!gate.session) return { data: null, error: null }

  const { data, error } = await cloud.database
    .from(TABLE)
    .select('id, match_id, comp, stage, home, away, date, time, created_at')
    .order('created_at', { ascending: false })
  if (error) return { data: null, error: normalizeDbError(error, '读取关注列表失败') }

  // RLS 只返回自己的行，这里拿到的就是当前用户的关注
  return { data: data || [], error: null }
}

async function favoritesByMatch() {
  const res = await list()
  if (res.error || !res.data) return { data: null, error: res.error }
  const map = {}
  res.data.forEach((row) => { map[row.match_id] = row })
  return { data: map, error: null }
}

async function add(match) {
  const gate = await sessionOrNull()
  if (gate.error) return gate.error
  if (!gate.session) return fail('请先登录后再关注比赛', 'unauthenticated')

  const { data, error } = await cloud.database
    .from(TABLE)
    .insert({
      match_id: match.id,
      comp: match.comp,
      stage: match.stage || '',
      home: match.home.zhName || match.home.zh || match.home.abbr,
      away: match.away.zhName || match.away.zh || match.away.abbr,
      date: match.date,
      time: match.time,
    })
    .select()
  if (error) return fail(normalizeDbError(error).message, 'db')
  if (!Array.isArray(data) || data.length === 0) return fail('保存失败，请重试', 'rls')
  return { data: data[0], error: null }
}

async function remove(matchId) {
  const gate = await sessionOrNull()
  if (gate.error) return gate.error
  if (!gate.session) return fail('请先登录', 'unauthenticated')

  const { data, error } = await cloud.database
    .from(TABLE)
    .delete()
    .eq('match_id', matchId)
    .select()
  if (error) return fail(normalizeDbError(error).message, 'db')
  if (!Array.isArray(data) || data.length === 0) return fail('没有找到这条关注记录', 'rls')
  return { data: true, error: null }
}

function normalizeDbError(error, fallback) {
  let message = fallback || error.message || '云服务请求失败'
  if (error.code === '23505') message = '这场比赛已经关注过了'
  if (error.code === '42501') message = '没有权限执行该操作，请重新登录后再试'
  if (error.code === '42P01') message = '数据表尚未创建，请联系开发者'
  return { message, kind: 'db', code: error.code }
}

module.exports = { list, favoritesByMatch, add, remove }
