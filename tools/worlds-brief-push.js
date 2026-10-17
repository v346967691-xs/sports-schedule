/** 同步后生成 S 赛晨报：09:00 首发，14:00 刷新同一期；每个时段只成功写入一次，失败留待后续班次重试。 */
const model = require('../utils/worlds-report')
const worlds = require('../utils/worlds')
const archive = require('../utils/worlds-archive')
function mergeMatches(snapshot, archived, live, snapshotAt) {
  const byId = {}
  ;(archived || []).forEach(m => { byId[m.id] = m })
  ;(snapshot || []).forEach(m => { byId[m.id] = JSON.parse(JSON.stringify(m)) })
  if (live && Date.parse(live.generatedAt) >= Date.parse(snapshotAt || '1970-01-01')) {
    ;(live.rows || []).forEach(p => {
      const m = byId[p.id]
      if (!m || m.comp !== 'worlds') return
      if (p.st) m.status = p.st
      if (p.stt) m.statusText = p.stt
      if (Number.isFinite(p.hs)) m.home.score = p.hs
      if (Number.isFinite(p.as)) m.away.score = p.as
    })
  }
  return Object.keys(byId).map(id => byId[id])
}
function signature(report) {
  if (!report) return ''
  const value = Object.assign({}, report)
  delete value.updatedAt
  return JSON.stringify(value)
}
async function main(cloud, now = Date.now(), dryRun = false, refreshScores = null) {
  const date = worlds.beijingDay(now)
  if (date < worlds.FROM || date > worlds.TO || now < Date.parse(date + `T${String(model.PUBLISH_HOUR).padStart(2, '0')}:00:00+08:00`)) return { skipped: 'not-due' }
  const hour = model.editionHour(date, now)
  const previous = await cloud.database.from('daily_brief').select('payload').eq('id', `worlds-morning-${date}`).maybeSingle()
  if (previous.error) throw new Error('晨报未生成：已发布期次读取失败')
  if (previous.data && previous.data.payload && previous.data.payload.editionHour >= hour) return { skipped: 'unchanged' }
  const snapshot = await cloud.database.from('schedule_cache').select('data,generated_at').eq('id', 'latest').maybeSingle()
  if (snapshot.error || !snapshot.data || !Array.isArray(snapshot.data.data) || !snapshot.data.data.length) throw new Error('晨报未生成：云端赛程不可用')
  const [buckets, live] = await Promise.all([
    cloud.database.from('match_detail').select('payload').gte('day', archive.START_DAY).lte('day', archive.dayStamp(now)),
    cloud.database.from('live_scores').select('data').eq('id', 'latest').maybeSingle(),
  ])
  if (buckets.error || live.error) throw new Error('晨报未生成：归档、实时比分或已发布期次读取失败')
  const archived = []
  ;(buckets.data || []).forEach(b => Object.values(b.payload || {}).forEach(d => { if (archive.archivedEntry(d, now)) archived.push(d.match) }))
  let matches = mergeMatches(snapshot.data.data, archived, live.data && live.data.data, snapshot.data.generated_at)
  // 出报时直接复查官方局分，不用 90 分钟快照节流作为出报条件。
  if (refreshScores) {
    const rows = await refreshScores()
    matches = mergeMatches(matches, [], { generatedAt: new Date(now).toISOString(), rows }, snapshot.data.generated_at)
  }
  const report = model.build(matches, date, now)
  if (signature(report) === signature(previous.data && previous.data.payload)) return { skipped: 'unchanged' }
  if (dryRun) return { report, dryRun: true }
  const result = await cloud.database.from('daily_brief').upsert({
    id: report.id, kind: 'morning', date, pub_at: report.pubAt, mode: 'report', payload: report, generated_at: report.updatedAt,
  }, { onConflict: 'id' }).select('id')
  if (result.error || !Array.isArray(result.data) || !result.data.length) throw new Error('S 赛晨报推送未确认成功：' + JSON.stringify(result.error || {}))
  return { published: report.id }
}
if (require.main === module) {
  const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk')
  main(createWorkBuddyCloud(require('../utils/cloud-config')), Date.now(), process.argv.includes('--dry-run'),
    async () => (await require('./live-watch').scanLol()).filter(row => row.id.startsWith('worlds-')))
    .then(result => console.log('[worlds-brief]', JSON.stringify(result)))
    .catch(error => { console.error('[worlds-brief]', error.message); process.exitCode = 1 })
}
module.exports = { mergeMatches, signature, main }
