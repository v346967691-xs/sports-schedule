/**
 * 一键回填「补录比赛」的比分
 * ============================================================
 * 背景：ESPN 不收录亚运会足球，中国 U23 亚运队的比赛只能靠 tools/manual-matches.js
 *       人工补录，而补录的比赛**没有自动比分源**（实测：thesportsdb 免费层已空、
 *       维基 API 限流且更新不及时、ESPN 218 个联赛里没有 Asian Games）。
 *       所以赛后需要人工回填比分。
 *
 * 这个脚本把「改文件 + 推云端」合成一条命令，避免手改 JS 数组时改错行。
 *
 * 用法：
 *   node tools/manual-score.js <比赛id> <主队进球> <客队进球>
 *   node tools/manual-score.js man-chn-u23-ag-2026-sf 1 2
 *
 * 参数：
 *   --dry    只打印将要改成的样子，不写文件（用于自检）
 *   --push   改完自动跑 tools/cloud-sync.js 推送云端（默认不推，先让你看一眼）
 *   --live   标记为「进行中」而不是「已结束」（比分会先落到当前值）
 *
 * ⚠️ 补录比分只影响 data/matches.js + 云端 schedule_cache，属于**数据层**，
 *    小程序不用重新发版。
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const FILE = path.join(__dirname, 'manual-matches.js')

const argv = process.argv.slice(2)
const flags = argv.filter((a) => a.startsWith('--'))
const args = argv.filter((a) => !a.startsWith('--'))

const dry = flags.includes('--dry')
const push = flags.includes('--push')
const live = flags.includes('--live')

// 列出当前所有补录比赛，方便拿到 id
if (flags.includes('--list')) {
  const rows = require('./manual-matches.js')
  if (!rows.length) {
    console.log('补录表是空的。')
    process.exit(0)
  }
  rows.forEach((m) => {
    const sc = m.home.score === null ? '—' : `${m.home.score}-${m.away.score}`
    console.log(`${m.id}  ${m.date} ${m.time}  ${m.home.zh} vs ${m.away.zh}  [${m.status}] ${sc}`)
  })
  process.exit(0)
}

if (args.length !== 3) {
  console.error('用法： node tools/manual-score.js <比赛id> <主队进球> <客队进球> [--dry] [--push] [--live]')
  console.error('示例： node tools/manual-score.js man-chn-u23-ag-2026-sf 1 2 --push')
  process.exit(1)
}

const [id, rawHome, rawAway] = args
const hs = Number(rawHome)
const as = Number(rawAway)
if (!Number.isInteger(hs) || !Number.isInteger(as) || hs < 0 || as < 0) {
  console.error(`比分必须是非负整数，收到：${rawHome} - ${rawAway}`)
  process.exit(1)
}

const src = fs.readFileSync(FILE, 'utf8')

// 定位该 id 所在的条目块：从 "id: '<id>'" 起，到下一个 "id: '" 或数组结尾 "]" 为止
const anchor = `id: '${id}'`
const start = src.indexOf(anchor)
if (start < 0) {
  console.error(`在 tools/manual-matches.js 里找不到 ${anchor}`)
  console.error('先用这条命令看看当前有哪些补录比赛： node tools/manual-score.js --list')
  process.exit(1)
}
// 块边界：下一个条目开头的 "{" 或数组结尾的 "]"，都按行首匹配，
// 避免被条目内部的 broadcast: [] 之类的 "]" 提前截断
const rest = src.slice(start + anchor.length)
const edge = rest.match(/\n\s*\{|\n\s*\]/)
const end = edge ? start + anchor.length + edge.index : src.length

const block = src.slice(start, end)
let next = block

const status = live ? 'live' : 'finished'
const statusText = live ? '进行中' : '已结束'

// 1) 状态
const statusRe = /status:\s*'[a-z]+'/
if (!statusRe.test(next)) { console.error('块内找不到 status 字段，已放弃'); process.exit(1) }
next = next.replace(statusRe, `status: '${status}'`)

// 2) 状态文案
const textRe = /statusText:\s*'[^']*'/
if (textRe.test(next)) next = next.replace(textRe, `statusText: '${statusText}'`)

// 3) 比分：块内第一个 score 是主队，第二个是客队
const scoreRe = /score:\s*(null|-?\d+)/g
const found = next.match(scoreRe)
if (!found || found.length < 2) {
  console.error(`块内只找到 ${found ? found.length : 0} 个 score 字段（需要 2 个：主队 + 客队），已放弃`)
  process.exit(1)
}
let i = 0
next = next.replace(scoreRe, () => {
  i += 1
  return `score: ${i === 1 ? hs : as}`
})

if (next === block) {
  console.error('没有任何字段被改动，已放弃（可能比分已经填过了）')
  process.exit(1)
}

console.log(`比赛 ${id}`)
console.log(`  状态  → ${status} / ${statusText}`)
console.log(`  比分  → ${hs} - ${as}`)

if (dry) {
  console.log('\n[--dry] 改动后的条目：\n')
  console.log(next.trim())
  process.exit(0)
}

fs.writeFileSync(FILE, src.slice(0, start) + next + src.slice(end), 'utf8')
console.log('\n已写入 tools/manual-matches.js')

// 让补录表并进快照（只刷受影响的赛事即可，这里刷全量最省心）
console.log('\n重跑同步 …')
execFileSync(process.execPath, [path.join(__dirname, 'sync.js'), '14', '45'], { cwd: ROOT, stdio: 'inherit' })

if (push) {
  console.log('\n推送云端 …')
  execFileSync(process.execPath, [path.join(__dirname, 'cloud-sync.js')], { cwd: ROOT, stdio: 'inherit' })
  console.log('\n✅ 完成：小程序下次打开即可看到赛果（不用重新发版）')
} else {
  console.log('\n提示：加 --push 可立即推到云端。也可以直接提交推送，等下一班 GitHub Actions（15 分钟内）。')
}
