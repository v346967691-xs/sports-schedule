const { cloud, isReady } = require('./cloud')
const model = require('./worlds-report')
async function fetch(date) {
  if (!model.validDate(date) || !isReady()) return null
  try {
    const r = await cloud.database.from('daily_brief').select('payload').eq('id', `worlds-morning-${date}`).maybeSingle()
    return !r.error && r.data && r.data.payload && r.data.payload.version === 1 ? r.data.payload : null
  } catch (error) { return null }
}
async function editions() {
  if (!isReady()) return []
  try {
    const r = await cloud.database.from('daily_brief').select('date').like('id', 'worlds-morning-%').order('pub_at', { ascending: false }).limit(45)
    return !r.error && Array.isArray(r.data) ? r.data.map(row => row.date) : []
  } catch (error) { return [] }
}
module.exports = { fetch, editions }
