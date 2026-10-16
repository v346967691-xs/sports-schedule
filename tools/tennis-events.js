/** 整站归档生成器。独立执行时只更新网球分站归档，不改普通赛程或开赛时间。 */
const fs = require('fs')
const path = require('path')
const archive = require('../utils/tennis-event')
const OUT = path.join(__dirname, '../data/tennis-events.js')

function saveArchive(rows) {
  let previous = null
  try { delete require.cache[require.resolve(OUT)]; previous = require(OUT) } catch (err) { /* 首次生成 */ }
  const labeled = require('./broadcast-sources').mergeBroadcasts(rows, [], archive.archiveRows(previous))
  const payload = archive.buildArchive(labeled, previous)
  fs.writeFileSync(OUT, `/** 网球整站赛程，自动生成；赛后保留 30 天。 */\nmodule.exports = ${JSON.stringify(payload)}\n`)
  return payload
}

async function main() {
  const sync = require('./sync')
  const rows = []
  for (const comp of sync.COMPETITIONS.filter(comp => comp.source === 'tennis')) {
    rows.push(...await sync.fetchTennis(comp))
  }
  if (!rows.length) throw new Error('网球整站赛程为空，保留已有归档')
  const payload = saveArchive(rows)
  console.log(`网球分站归档：${payload.events.length} 站，${archive.archiveRows(payload).length} 场`)
}
if (require.main === module) main().catch(err => { console.error(err.message); process.exitCode = 1 })
module.exports = { saveArchive }
