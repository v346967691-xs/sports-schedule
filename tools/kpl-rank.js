/**
 * KPL 选手数据榜（getPlayerRank，9 张官方榜）→ data/kpl-rank.js
 *
 * 用法：node tools/kpl-rank.js [--force]
 *   --force  无视 12 小时新鲜度，强制重抓
 *
 * 🔴 端点怪癖见 REFERENCE §十五：
 *   POST + JSON，必须带 User-Agent(Chrome) / Referer / Origin 三个头，否则 404。
 *   `seasonid` 传空串即可，返回的是当前赛季（实测 KPL2026S3）。
 *
 * ⚠️ 每条 player_name 形如「上海EDGM.风箫」=「队名.选手名」，**不要用第一个点去切**：
 *    队名本身带点（长沙TES.A → 「长沙TES.A书源」一切就错）。这里整串原样存，
 *    要分列展示的话得先有一份队名清单再去前缀匹配，现在不做。
 *
 * ⚠️ 这是纯数据层产物：不进小程序包（`data/` 只是生成物 + 落云端），
 *    页面层什么时候读什么时候再发版。
 */
const fs = require('fs')
const path = require('path')
const https = require('https')

const KPL = 'kplshop-op.timi-esports.qq.com'
const KPL_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Referer: 'https://kpl.qq.com/',
  Origin: 'https://kpl.qq.com',
  'Content-Type': 'application/json',
}

/** 新鲜度闸门：赛季累计数据变化很慢，12 小时抓一次足够（避免白花云额度） */
const FRESH_HOURS = 12

/**
 * getPlayerRank 返回的 9 个字段 → 展示名。
 * ⚠️ 命名口径（参考 utils/roster.js 的 KPL_POS：top=对抗路 / mid=中路 / adc=发育路 / sup=游走）：
 *    jug = jungle（野区，对应「打野」位置）；top_solo_kills = 对抗路单杀；
 *    adc_teamfight_damage = 发育路团战输出；sup_initiation = 游走先手次数。
 * ⚠️ 中文榜名的措辞还没跟用户最终确认 —— 页面层真正要展示时再核一轮。
 */
const BOARDS = [
  { key: 'mvp_list', name: 'MVP 次数' },
  { key: 'total_kills_list', name: '总击杀' },
  { key: 'total_assists_list', name: '总助攻' },
  { key: 'five_kill_list', name: '五杀' },
  { key: 'top_solo_kills_list', name: '对抗路单杀' },
  { key: 'jug_count_list', name: '野怪击杀' },
  { key: 'mid_lane_roam_count_list', name: '中路游走' },
  { key: 'adc_teamfight_damage_list', name: '发育路团战输出' },
  { key: 'sup_initiation_count_list', name: '游走先手' },
]

const OUT = path.join(__dirname, '..', 'data', 'kpl-rank.js')

function log(...a) { console.log('[kpl-rank]', ...a) }

function postJSON(pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {})
    const req = https.request(
      {
        hostname: KPL,
        path: '/kplow/' + pathname,
        method: 'POST',
        headers: Object.assign({ 'Content-Length': Buffer.byteLength(payload) }, KPL_HEADERS),
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        let d = ''
        res.on('data', (c) => { d += c })
        res.on('end', () => {
          try { resolve(JSON.parse(d)) } catch (e) { reject(e) }
        })
      }
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

/** 从选手头像 URL 里抠赛季（…/avatar/KPL2026S3/215868659.png），拿不到就留空 */
function seasonOf(avatar) {
  const m = String(avatar || '').match(/\/avatar\/([^/]+)\//)
  return m ? m[1] : ''
}

function pickRow(r) {
  const id = String(r.player_id || '')
  if (!id) return null
  return {
    rank: Number(r.rank) || 0,
    num: Number(r.num) || 0,
    name: String(r.player_name || ''),
    id,
    av: String(r.avatar || ''),
  }
}

async function main() {
  const force = process.argv.includes('--force')

  if (!force && fs.existsSync(OUT)) {
    let prev = null
    try {
      // eslint-disable-next-line global-require
      prev = require(OUT)
    } catch (e) { prev = null }
    const ageMs = prev && prev.generatedAt ? Date.now() - Date.parse(prev.generatedAt) : Infinity
    if (Number.isFinite(ageMs) && ageMs < FRESH_HOURS * 3600 * 1000) {
      log(`本地数据距今 ${Math.round(ageMs / 60000)} 分钟（<${FRESH_HOURS}h），跳过抓取`)
      return 0
    }
  }

  const json = await postJSON('getPlayerRank', { seasonid: '' })
  const data = (json && json.data) || {}

  const boards = []
  let season = ''
  BOARDS.forEach((b) => {
    const rows = (Array.isArray(data[b.key]) ? data[b.key] : [])
      .map(pickRow)
      .filter(Boolean)
    // ⚠️ 空榜（如五杀，赛季初 0 条）直接不产出 —— 页面层还没做，
    //    但按现有约定「拿不到就整块不显示」，别留一个空壳榜在表里。
    if (!rows.length) {
      log(`跳过空榜 ${b.key}`)
      return
    }
    rows.forEach((r) => { if (!season && r.av) season = seasonOf(r.av) })
    boards.push({ key: b.key, name: b.name, rows })
  })

  if (!boards.length) {
    log('⚠ 上游没返回任何可用榜单，保持原文件不动')
    return 3
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    season,
    boards,
  }
  const rows = boards.reduce((n, b) => n + b.rows.length, 0)
  fs.writeFileSync(
    OUT,
    '/* eslint-disable */\n' +
      `/* 自动生成，请勿手改 —— 由 tools/kpl-rank.js 写入（${new Date().toISOString()}） */\n` +
      'module.exports = ' + JSON.stringify(payload) + '\n',
    'utf8'
  )
  log(`已写入 ${path.relative(process.cwd(), OUT)}：${boards.length} 张榜 / ${rows} 条 / 赛季 ${season || '(未知)'} / ${JSON.stringify(payload).length} 字节`)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[kpl-rank] 抓取失败：', (err && err.message) || err)
    process.exit(1)
  })
