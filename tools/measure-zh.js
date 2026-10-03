/**
 * 量化：两处「球员中文名」的实际汉化率（整份字典的体检表）。
 *
 *  ① 射手榜 / 助攻榜（`data/scorers.js`）
 *     「可见池」= 每个赛事的进球榜前 20 ∪ 助攻榜前 20（页面实际会渲染的行）。
 *     全量口径 = 该赛事所有上榜球员。
 *  ② 首发阵容（`data/match-details.js`）
 *     阵容是**内联姓名**、不含 athlete id，只能按「名字里有没有汉字」判定；
 *     同时给「行数口径」（页面渲染的每一行）与「去重口径」（不同的人）。
 *
 * 用法：node tools/measure-zh.js
 */
const fs = require('fs')
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

/* --------------------------- ② 首发阵容汉化率 --------------------------- */
// 阵容姓名是内联的，没有 athlete id 可查，只能按「含不含汉字」判。
// 纯拉丁名一律算未汉化 —— 中英混排是预期内的正常状态（见 match-detail.js 的注释）。

const HAS_CJK = /[\u4e00-\u9fff]/
const mdPath = path.join(ROOT, 'data/match-details.js')

if (!fs.existsSync(mdPath)) {
  console.log('\n[阵容] 没有 data/match-details.js，跳过')
  process.exit(0)
}

const md = require(mdPath)
const rows = [] // 页面渲染的每一行
const uniq = new Map() // 名字 → 出场次数
let luMatches = 0
let luStarter = 0
let luStarterZh = 0

;(md.buckets || []).forEach((b) => {
  Object.keys(b.payload || {}).forEach((id) => {
    const d = b.payload[id]
    if (!d || !d.lineups) return
    luMatches += 1
    ;['home', 'away'].forEach((side) => {
      ;((d.lineups && d.lineups[side]) || []).forEach((r) => {
        const n = String((r && r.n) || '')
        if (!n) return
        rows.push(n)
        uniq.set(n, (uniq.get(n) || 0) + 1)
        if (r.st) {
          luStarter += 1
          if (HAS_CJK.test(n)) luStarterZh += 1
        }
      })
    })
  })
})

const zhOf = (list) => list.filter((n) => HAS_CJK.test(n)).length
const uniqNames = [...uniq.keys()]
const uniqZh = uniqNames.filter((n) => HAS_CJK.test(n)).length
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0)

console.log(`\n[阵容] ${luMatches} 场有首发阵容 / ${rows.length} 行名单`)
console.log(`  行数口径：${zhOf(rows)}/${rows.length} = ${pct(zhOf(rows), rows.length)}%`)
console.log(`  去重口径：${uniqZh}/${uniqNames.length} = ${pct(uniqZh, uniqNames.length)}%`)
console.log(`  仅首发：  ${luStarterZh}/${luStarter} = ${pct(luStarterZh, luStarter)}%`)

const luMiss = uniqNames
  .filter((n) => !HAS_CJK.test(n))
  .sort((a, b) => uniq.get(b) - uniq.get(a) || a.localeCompare(b))
console.log(`\n[阵容] 未汉化 ${luMiss.length} 个名字（按出场次数排，前 30）：`)
luMiss.slice(0, 30).forEach((n) => console.log(`  ${uniq.get(n)}×\t${n}`))
