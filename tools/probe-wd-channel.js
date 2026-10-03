/**
 * 一次性探测（不改任何状态）：对比两条 Wikidata 检索通道，看「查过但没结果」的球员能不能捞回来。
 *
 *  A = 现通道 `action=wbsearchentities`（按英文全名模糊搜，返回 top10，再逐条过闸门）
 *  B = 候选新通道 `action=query&list=search` + `haswbstatement:P106=Q937857`
 *      （把「必须是足球运动员」这个闸门条件交给**服务端**，直接只返回足员的实体）
 *
 * 用法：node tools/.probe-wd-channel.js
 */
const https = require('https')

const WD_API = 'https://www.wikidata.org/w/api.php'
const UA = 'sports-schedule-miniprogram/1.0 (player name dictionary; contact: repo owner)'

const SAMPLES = [
  { id: '240900', full: 'Li Yang', note: '中超' },
  { id: '156780', full: 'Wei Zhen', note: '中超' },
  { id: '322952', full: 'Yan Bingliang', note: '中超' },
  { id: '291046', full: 'Chen Pu', note: '中超' },
  { id: '238738', full: 'Jin Cheng', note: '中超' },
  { id: '375514', full: 'M. Sierra', note: '塞维利亚' },
  { id: '268720', full: 'L. Mafouta', note: '勒芒（预期无中文条目）' }
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getJSON(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => {
        try { resolve(JSON.parse(b)) } catch (e) { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(15000, () => { req.destroy(); resolve(null) })
  })
}

async function channelA(name) {
  const url = `${WD_API}?action=wbsearchentities&search=${encodeURIComponent(name)}` +
    '&language=en&uselang=en&type=item&limit=10&format=json'
  const j = await getJSON(url)
  if (!j) return null
  return (j.search || []).map((c) => `${c.id}${c.description ? ' (' + c.description + ')' : ''}`)
}

async function channelB(name) {
  const q = `"${name}" haswbstatement:P106=Q937857`
  const url = `${WD_API}?action=query&list=search&srsearch=${encodeURIComponent(q)}` +
    '&srnamespace=0&srlimit=10&format=json'
  const j = await getJSON(url)
  if (!j) return null
  return ((j.query && j.query.search) || []).map((c) => `${c.title}`)
}

async function main() {
  for (let i = 0; i < SAMPLES.length; i += 1) {
    const s = SAMPLES[i]
    const a = await channelA(s.full)
    await sleep(6500)
    const b = await channelB(s.full)
    await sleep(6500)
    console.log(`\n── ${s.full}  [${s.note}]  id=${s.id}`)
    console.log(`  A wbsearchentities(${a === null ? '请求失败' : a.length + ' 条'}): ${(a || []).slice(0, 5).join(' | ')}`)
    console.log(`  B 足员过滤搜索(${b === null ? '请求失败' : b.length + ' 条'}): ${(b || []).slice(0, 5).join(' | ')}`)
  }
}

main()
