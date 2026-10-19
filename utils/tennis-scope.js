/** 统一赛事覆盖范围；等级元数据仍保留，供旧缓存和冠名赛事识别。 */
let current
function weekly() {
  if (!current) {
    try { current = require('../data/tennis-rankings').weekly || {} } catch (_) { current = {} }
  }
  return current
}
function setCalendar(tour, rows) {
  const calendars = weekly()
  calendars[tour] = { ...(calendars[tour] || {}), tournaments: require('./tennis-levels').mergeCalendar(calendars[tour]?.tournaments, rows) }
}
function excluded(level) { return /^(?:(?:ATP|WTA)\s*)?250$/i.test(String(level || '').trim()) }
function allows(match, calendars = weekly()) {
  if (!match || !['atp', 'wta'].includes(match.comp)) return true
  const level = match.eventLevel || match.level || require('./tennis-rankings').eventLevel(
    calendars[match.comp]?.tournaments, match.comp, String(match.stage || match.name || '').split('·')[0].trim(),
    match.date || match.start || match.eventStart)
  return !excluded(level)
}
function eventAllowed(event, tour) {
  return allows({ comp: tour, stage: event.name, start: event.date, level: event.level })
}
module.exports = { allows, excluded, eventAllowed, setCalendar }
