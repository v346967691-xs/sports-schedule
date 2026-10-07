/**
 * 包体积**精确测量**（不是磁盘占用）。
 *
 * 🔴 口径：必须按 `project.config.json` 的 `packOptions.ignore` 扣减后再算。
 *    直接 `du -sh .` 会把 `data/brief`(493KB) / `tools`(1.1MB) / `node_modules`
 *    / `.git` / `.github` / `.workbuddy` 全算进去，得出 2.084MB / 104% 的虚惊
 *    （2026-10-07 踩过）。
 *
 * 用法： node tools/packsize.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'))
const ignore = (cfg.packOptions && cfg.packOptions.ignore) || []

const ignoredDirs = new Set()
const ignoredFiles = new Set()
ignore.forEach((it) => {
  const v = String(it.value || '').replace(/^\.\//, '')
  if (it.type === 'folder') ignoredDirs.add(v)
  else if (it.type === 'file') ignoredFiles.add(v)
})

const alwaysSkip = new Set(['node_modules', '.git', '.github', '.workbuddy'])
const rows = []
let total = 0

function walk(dir, rel) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return
  }
  for (const e of entries) {
    const r = rel ? rel + '/' + e.name : e.name
    if (alwaysSkip.has(e.name) && e.isDirectory()) continue
    if (e.isDirectory()) {
      if (ignoredDirs.has(r)) continue
      walk(path.join(dir, e.name), r)
    } else {
      if (ignoredFiles.has(r)) continue
      if (ignoredDirs.has(r)) continue
      let st
      try {
        st = fs.statSync(path.join(dir, e.name))
      } catch (err) {
        continue
      }
      total += st.size
      rows.push({ p: r, s: st.size })
    }
  }
}

walk(ROOT, '')

rows.sort((a, b) => b.s - a.s)
const mb = (n) => (n / 1024 / 1024).toFixed(3) + 'MB'
const kb = (n) => Math.round(n / 1024) + 'KB'
const LIMIT = 2 * 1024 * 1024

console.log('=== 入包体积（已扣减 packOptions.ignore）===')
console.log('总计:', mb(total), '=', kb(total), '| 限额 2.000MB | 占比', ((total / LIMIT) * 100).toFixed(1) + '%', '| 余量', kb(LIMIT - total))
console.log('')
console.log('--- Top 20 文件 ---')
rows.slice(0, 20).forEach((r) => console.log(kb(r.s).padStart(8), r.p))
console.log('')
console.log('--- 按一级目录 ---')
const byDir = {}
rows.forEach((r) => {
  const d = r.p.indexOf('/') > -1 ? r.p.split('/')[0] : '(根目录)'
  byDir[d] = (byDir[d] || 0) + r.s
})
Object.keys(byDir)
  .sort((a, b) => byDir[b] - byDir[a])
  .forEach((d) => console.log(kb(byDir[d]).padStart(8), d))
