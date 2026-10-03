/**
 * 量化（临时）：射手榜里可见的球员名，汉化率是多少。
 * 「可见池」= 每个赛事的进球榜前 20 ∪ 助攻榜前 20（页面实际会渲染的行）。
 * 用法：node tools/.measure-zh.js
 */
const path = require('path')
const ROOT = path.join(__dirname, '..')

const sc = require(path.join(ROOT, 'data/scorers.js'))
const tables = sc.tables || {}
const TOP = 20

let all = 0
let allZh = 0
const perComp = []
let pool = 0
let poolZh = 0
const untranslated = []

Object.keys(tables).forEach((k) => {
  const ps = (tables[k] || {}).players || []
  all += ps.length
  allZh += ps.filter((p) => p.z).length
  const byG = ps.slice().filter((p) => p.g > 0).sort((a, b) => b.g - a.g).slice(0, TOP)
  const byA = ps.slice().filter((p) => p.a > 0).sort((a, b) => b.a - a.a).slice(0, TOP)
  const seen = {}
  const vis = byG.concat(byA).filter((p) => (seen[p.i] ? false : (seen[p.i] = 1)))
  const zh = vis.filter((p) => p.z).length
  pool += vis.length
  poolZh += zh
  perComp.push(`${k} ${zh}/${vis.length}`)
  vis.filter((p) => !p.z).forEach((p) => untranslated.push(`${k}\t${p.s}\t${p.tz || ''}`))
})

console.log(`生成时间：${sc.generatedAt || '(无)'}`)
console.log(`全量：${allZh}/${all} = ${Math.round((allZh / all) * 100)}%`)
console.log(`可见池（每赛事 进球前 ${TOP} ∪ 助攻前 ${TOP}）：${poolZh}/${pool} = ${Math.round((poolZh / pool) * 100)}%`)
console.log(`分赛事：${perComp.join('  ')}`)
console.log(`\n未汉化 ${untranslated.length} 人（前 40）：`)
untranslated.slice(0, 40).forEach((l) => console.log('  ' + l))
