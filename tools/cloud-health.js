/** One read before collectors; business steps stop on unavailable cloud, final step reports failure. */
const fs = require('node:fs')
const { isOutage } = require('./cloud-outage')

async function probe(cloud) {
  try {
    const result = await cloud.database.from('schedule_cache').select('id').eq('id', 'latest').limit(1)
    if (result.error) return { available: false, reason: isOutage(result.error) ? 'environment-isolated' : 'database-read-failed' }
    return { available: true, reason: 'database-readable' }
  } catch (error) {
    return { available: false, reason: isOutage(error) ? 'environment-isolated' : 'database-read-failed' }
  }
}
if (require.main === module) {
  const cloud = require('@tencent-ai/workbuddy-cloud-sdk').createWorkBuddyCloud(require('../utils/cloud-config'))
  probe(cloud).then(result => {
    console.log('[cloud-health]', JSON.stringify(result))
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `available=${result.available}\nreason=${result.reason}\n`)
    else if (!result.available) process.exitCode = 3
  }).catch(() => { process.exitCode = 1 })
}
module.exports = { probe }
