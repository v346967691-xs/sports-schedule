/**
 * 一次性复核工具（不属于产品代码，已收进 tools/（受 smoke 的 tools/ 语法门看护））
 * ------------------------------------------------------------
 * **姓氏一致性检测** —— 张冠李戴的自动筛查。
 *
 * 原理：同一个英文姓氏的所有球员，中文译名的姓氏部分应当一致
 *   （García 全都译「加西亚」、Williams 全都译「威廉斯」）。
 *   如果某个人的译名尾部与同姓其他人不同 —— 他多半被套到另一个人名下了。
 *   例：Andreas Christensen 被自动给成「克里斯托弗·海梅罗特」，与别的 Christensen 对不上 → 标红。
 *
 * 用法： node .workbuddy/reports/check-surname.js [最少样本数]
 */
const path = require('path')
const ROOT = path.join(__dirname, '..')
const fs = require('fs')

const MIN_GROUP = Number(process.argv[2]) || 2 // 组内至少几人才比

const { createWorkBuddyCloud } = require(path.join(ROOT, 'node_modules/@tencent-ai/workbuddy-cloud-sdk'))
const publicConfig = require(path.join(ROOT, 'utils/cloud-config.js'))
const auto = require(path.join(ROOT, 'tools/player-zh.js')).AUTO_PLAYER_ZH || {}
const manual = require(path.join(ROOT, 'tools/zh-names.js')).PLAYER_ZH || {}

const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/['’`]/g, '').toLowerCase().trim()
/** 取英文全名的姓氏段（去虚词，如 de/van/der/dos/são） */
const SKIP = new Set(['de', 'del', 'la', 'le', 'van', 'von', 'der', 'den', 'dos', 'da', 'di', 'du', 'bin', 'al'])
function surnameOf(name) {
  const p = fold(name).split(/[\s.\-]+/).filter(Boolean).filter((w) => !SKIP.has(w))
  return p.length ? p[p.length - 1] : ''
}

async function loadPlayers() {
  // 先从本地快照里凑英文名（data/scorers.js 有 en 字段），不够的再去云表名单补
  const map = {}
  try {
    const sc = require(path.join(ROOT, 'data/scorers.js'))
    const tables = (sc && (sc.tables || sc.data)) || {}
    Object.values(tables).forEach((rows) => {
      (rows || []).forEach((r) => { if (r && r.id && r.en) map[String(r.id)] = r.en })
    })
  } catch (e) { /* 忽略 */ }
  const cloud = createWorkBuddyCloud({
    endpoint: publicConfig.endpoint,
    publishableKey: publicConfig.publishableKey,
  })
  const { data, error } = await cloud.database.from('team_roster').select('payload').limit(2000)
  if (!error && data) {
    data.forEach((row) => (((row.payload || {}).players) || []).forEach((p) => {
      if (p.i && p.n && !map[String(p.i)]) map[String(p.i)] = p.n
    }))
  }
  return map
}

async function main() {
  const enNames = await loadPlayers()
  const all = {}
  Object.keys(manual).forEach((id) => { all[id] = { zh: manual[id], src: '手工', en: enNames[id] || '' } })
  Object.keys(auto).forEach((id) => { if (!all[id]) all[id] = { zh: auto[id], src: '自动', en: enNames[id] || '' } })

  const groups = {}
  Object.keys(all).forEach((id) => {
    const en = all[id].en
    if (!en) return
    const s = surnameOf(en)
    if (!s) return
    ;(groups[s] = groups[s] || []).push({ id, ...all[id] })
  })

  // 组内取译名尾部的众数：中文译名通常是「名·姓」，尾部 2-4 字就是姓
  let checked = 0
  const suspects = []
  Object.keys(groups).forEach((s) => {
    const g = groups[s]
    if (g.length < MIN_GROUP) return
    const tails = {}
    g.forEach((m) => {
      const core = String(m.zh).replace(/^.*[·・]/, '') // 去掉「xxx·」的名部分
      ;[2, 3, 4].forEach((n) => {
        if (core.length >= n) {
          const t = core.slice(-n)
          tails[t] = (tails[t] || 0) + 1
        }
      })
    })
    const top = Object.entries(tails).sort((a, b) => b[1] - a[1])[0]
    if (!top) return
    g.forEach((m) => {
      checked += 1
      const core = String(m.zh).replace(/^.*[·・]/, '')
      const hit = [2, 3, 4].some((n) => core.length >= n && core.slice(-n) === top[0])
      if (!hit) suspects.push({ sur: s, id: m.id, zh: m.zh, en: m.en, src: m.src, groupSize: g.length })
    })
  })

  console.log(`字典 ${Object.keys(all).length} 条，参与姓氏一致性比较 ${checked} 条（$-{English 姓氏} 分组，每组 ≥${MIN_GROUP} 人）`)
  console.log(`可疑 ${suspects.length} 条：\n`)
  suspects.sort((a, b) => b.groupSize - a.groupSize).forEach((x) => {
    console.log(`  [${x.sur}] ${x.zh}  ←  ${x.en}   id=${x.id}  (${x.src}，同姓 ${x.groupSize} 人)`)
  })
}

if (require.main === module) {
  main().catch((e) => console.error(e && e.stack ? e.stack : e))
}
