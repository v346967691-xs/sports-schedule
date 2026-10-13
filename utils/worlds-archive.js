/** Worlds2026 云端归档规则；只延长本届赛事，不扩大赛程包或其他赛事详情。 */
const START_DAY = '20261015'
const FINAL_DAY = '20261115'
// 决赛北京时间 11 月 15 日，赛后 30 天包含 12 月 15 日全天。
const ARCHIVE_UNTIL = Date.parse('2026-12-16T00:00:00+08:00')
const DAY_MS = 86400000

function dayStamp(ms) {
  const d = new Date(ms + 8 * 3600000)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}
function isWorlds2026(match) {
  if (!match || match.comp !== 'worlds') return false
  const at = Date.parse(match.start || '')
  if (!Number.isFinite(at)) return false
  const day = dayStamp(at)
  return day >= START_DAY && day <= FINAL_DAY
}
const archiveActive = (now = Date.now()) => now < ARCHIVE_UNTIL

/** 保留页面需要的比赛元数据，不存原始响应或其他赛事详情。 */
function matchMetadata(m) {
  const out = {}
  ;['id', 'comp', 'start', 'date', 'time', 'status', 'statusText', 'stage', 'venue', 'broadcast', 'bo', 'home', 'away', 'historical'].forEach(k => {
    if (m[k] !== undefined) out[k] = m[k]
  })
  return JSON.parse(JSON.stringify(out))
}
function archivedEntry(detail, now = Date.now()) {
  return !!(archiveActive(now) && detail && isWorlds2026(detail.match) && detail.id === detail.match.id && detail.comp === 'worlds')
}
function prunePayload(payload, day, now = Date.now()) {
  const old = day < dayStamp(now - 7 * DAY_MS)
  const out = {}
  Object.keys(payload || {}).forEach(id => {
    const d = payload[id]
    if (d && (!old || archivedEntry(d, now))) out[id] = d
  })
  return out
}
// 只读本届有界天桶；禁止全表归档读取。
function archiveDays(now = Date.now()) {
  if (!archiveActive(now)) return []
  const out = []
  for (let at = Date.parse('2026-10-15T00:00:00+08:00'); dayStamp(at) <= FINAL_DAY; at += DAY_MS) out.push(dayStamp(at))
  return out
}
module.exports = { START_DAY, FINAL_DAY, ARCHIVE_UNTIL, DAY_MS, dayStamp, isWorlds2026, archiveActive, matchMetadata, archivedEntry, prunePayload, archiveDays }
