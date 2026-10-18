/** Offline forecast from two official balance snapshots of the SAME application and cycle. */
function forecast(input) {
  const { limit, start, end, samples } = input
  const begin = Date.parse(start), finish = Date.parse(end)
  if (!Number.isFinite(limit) || !(limit > 0) || !(finish > begin) || !Array.isArray(samples) || samples.length < 2) throw Error('Need cycle boundaries, limit and at least two official balance samples')
  if (samples.some(row => !row || row.used === null || row.used === '' || row.used === undefined)) throw Error('Official used points must be provided')
  const rows = samples.map(row => ({ at: Date.parse(row.at), used: Number(row.used) })).sort((a,b) => a.at-b.at)
  if (rows.some(row => !Number.isFinite(row.at) || row.at < begin || row.at >= finish || !Number.isFinite(row.used) || row.used < 0 || row.used > limit)) throw Error('Samples must belong to this cycle and quota')
  if (rows.some((row,i) => i && (row.at <= rows[i-1].at || row.used < rows[i-1].used))) throw Error('Duplicate time, reset or adjustment detected; split the observation period')
  const first=rows[0], last=rows.at(-1), days=(last.at-first.at)/86400000
  const pointsPerDay=(last.used-first.used)/days, daysLeft=(finish-last.at)/86400000
  const projected=last.used+pointsPerDay*daysLeft, target=limit*0.8
  return { diagnosticOnly: false, basis: 'user-supplied official billing samples', observationDays: days,
    pointsPerDay, remaining: limit-last.used, projectedCyclePoints: projected, target,
    dailyBudgetToTarget: Math.max(0,(target-last.used)/daysLeft),
    daysUntilExhaustion: pointsPerDay > 0 ? (limit-last.used)/pointsPerDay : null,
    status: projected > limit ? 'projected-over-quota' : projected > target ? 'reserve-at-risk' : 'within-target',
    representativeWeek: days >= 7 }
}
if (require.main === module) {
  try { console.log(JSON.stringify(forecast(JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'))), null, 2)) }
  catch(error) { console.error('[quota-budget]', error.message); process.exitCode=1 }
}
module.exports={forecast}
