#!/usr/bin/env node
/**
 * 比赛详情抓取：一次 ESPN summary 请求，抽出四个模块
 *
 *   ① 事件时间轴  keyEvents    —— 进球 / 点球 / 红黄牌 / 换人，带分钟与文字描述
 *   ② 双方近况    lastFiveGames —— 两队各自最近 5 场（主客、比分、胜负）
 *   ③ 历史交锋    seasonseries  —— 近 5 次交手与总战绩
 *   ④ 技术统计    boxscore     —— 控球率 / 射门 / 射正 / 角球 / 犯规 / 传球成功率
 *
 * ⚠️ 三个硬约束（改这个文件前先读）：
 *   1. **小程序不能直连 ESPN**，必须由本脚本预抓、抽取字段后落云表；
 *      绝不能把原文存下来 —— 单场 390KB，上千场会直接把云表和流量打爆。
 *   2. **必须增量抓**。已结束的比赛抓一次就够（事件不会变），只有进行中的
 *      场次需要每班重抓（比分在变）。全量抓的话一天 1~2GB 流量，会被限流。
 *      已抓过的名单从云端 match_detail 现读，不落本地文件（Actions 每次是
 *      干净 checkout，本地文件留不住）。
 *   3. 与积分榜同级别：失败只告警，绝不让赛程主链路跟着失败。
 */
const fs = require('fs')
const path = require('path')
const https = require('https')

const zhNames = require('./zh-names')
const publicConfig = require('../utils/cloud-config')

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports'
/** 只有 ESPN 源的赛事有 summary 端点；LoL / CBA / KPL 没有 */
const SLUG = {
  ucl: 'uefa.champions',
  epl: 'eng.1',
  liga: 'esp.1',
  seriea: 'ita.1',
  bundesliga: 'ger.1',
  ligue1: 'fra.1',
  nations: 'uefa.nations',
  uel: 'uefa.europa',
  csl: 'chn.1',
  nba: 'nba',
}
const BASKETBALL = { nba: true }

/**
 * 抽取结果的 schema 版本。
 * ⚠️ 改了任何 pick* 的抽取逻辑都要 +1：云端存的是「抽完的成品」，
 *    已结束的比赛只抓一次、之后永不刷新，光改代码老数据不会变。
 *    needsFetch 见到版本号不同会强制重抓一次，老数据自动淘汰。
 */
const SCHEMA = 3

const FINISHED_MS = 48 * 3600 * 1000 // 已结束：只补最近 48 小时
const UPCOMING_MS = 7 * 24 * 3600 * 1000 // 赛前预览：未来 7 天内开赛的也抓
const UPCOMING_REFRESH_MS = 12 * 3600 * 1000 // 未开赛的近况变化慢，12 小时刷一次就够
const KEEP_DAYS = 7 // 云端保留天数（与 RLS 的 DELETE 策略一致）

/* ---------------------------- 事件：过滤与汉化 ---------------------------- */

/**
 * ESPN 的 keyEvents 里有大量噪音：一场比赛约 1/4 是 "Start Delay" / "End Delay"，
 * 还有 Kickoff / Halftime / Start 2nd Half / End Regular Time 这类结构性节点。
 * 只留真正的关键事件：进球（含点球、乌龙）、红黄牌、换人、点球罚失。
 */
function keepEvent(k) {
  const t = String((k && k.type && k.type.text) || '')
  if (!t) return false
  if (/delay/i.test(t)) return false
  if (/kickoff|halftime|half time|start 2nd half|end regular|full.?time|end of|period/i.test(t)) return false
  if (k.scoringPlay) return true
  return /goal|card|substitution|penalty/i.test(t)
}

const EVENT_ZH = [
  [/missed penalty|penalty (missed|saved)|saved penalty/i, '点球罚失'],
  [/own goal/i, '乌龙球'],
  [/penalty/i, '点球'],
  [/header/i, '头球'],
  [/volley/i, '凌空'],
  [/free kick/i, '任意球'],
  [/^goal/i, '进球'],
  [/second yellow/i, '两黄变红'],
  [/red card/i, '红牌'],
  [/yellow card/i, '黄牌'],
  [/substitution/i, '换人'],
]

function zhEvent(t) {
  const s = String(t || '')
  for (const [re, zh] of EVENT_ZH) if (re.test(s)) return zh
  return null
}

/**
 * ESPN 的事件描述是英文整句（"Kenny Kindle (Liechtenstein) is shown the yellow card"），
 * 塞进中文界面很难看，而且一条几十字节、上千条会撑大 payload。
 * 这里只抽最关键的那一小段：换人抽「谁换下谁」，其余抽「球员名」。
 */
function briefOf(text, type) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  const sub = raw.match(/^Substitution,[^.]*\.\s*(.+?)\s+replaces\s+(.+?)\.?$/i)
  // 换人常带 "because of an injury" 尾巴，截掉
  if (sub) {
    const inn = sub[1].trim()
    const out = sub[2].trim().replace(/\s+because of an injury$/i, '')
    return `${inn} 换下 ${out}`
  }
  const who = raw.match(/([A-Z][\p{L}\p{M}'’\-\. ]{1,28}?)\s*\([^)]{2,40}\)/u)
  if (who) return who[1].trim()
  return raw.length > 40 ? `${raw.slice(0, 38)}…` : raw
}

/* ------------------------------ 技术统计 ------------------------------ */

/** 只挑球迷真正会看的几项，并且顺序固定（主队在前） */
const STAT_ROWS = [
  ['possessionPct', '控球率', (v) => `${Number(v).toFixed(1)}%`],
  ['totalShots', '射门'],
  ['shotsOnTarget', '射正'],
  ['wonCorners', '角球'],
  ['foulsCommitted', '犯规'],
  ['yellowCards', '黄牌'],
  ['redCards', '红牌'],
  ['offsides', '越位'],
  ['passPct', '传球成功率', (v) => `${Math.round(Number(v) * 100)}%`],
]

/* ------------------------------- 抓取 ------------------------------- */

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
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
      })
      .on('error', reject)
  })
}

async function mapLimit(items, limit, worker) {
  const out = []
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i
        i += 1
        out[idx] = await worker(items[idx], idx)
      }
    })
  )
  return out
}

/* --------------------------- 抽取：单场比赛 --------------------------- */

/**
 * 队名索引：lastFiveGames 只给了对手的 id，没有名字，直接查会出空字符串。
 * 从本地快照里把所有出现过的队（id → 中文名/英文名）建一张表兜底。
 */
let TEAM_IDX = {}
function buildTeamIndex(list) {
  const idx = {}
  ;(list || []).forEach((m) => {
    ;['home', 'away'].forEach((side) => {
      const t = m[side]
      if (!t || !t.id) return
      const id = String(t.id)
      if (!idx[id]) idx[id] = zhNames.espnZh(id) || t.zh || t.name || ''
    })
  })
  TEAM_IDX = idx
}

function teamZh(id, fallback) {
  return (
    zhNames.espnZh(String(id)) ||
    TEAM_IDX[String(id)] ||
    zhNames.nameZh(fallback) ||
    fallback ||
    ''
  )
}

function pickEvents(j, homeId) {
  const list = Array.isArray(j.keyEvents) ? j.keyEvents : []
  return list
    .filter(keepEvent)
    .map((k) => {
      const raw = String((k.type && k.type.text) || '')
      return {
        m: String((k.clock && k.clock.displayValue) || ''),
        t: zhEvent(raw) || raw,
        s: briefOf(k.text, zhEvent(raw)),
        side: k.team ? (String(k.team.id) === String(homeId) ? 'home' : 'away') : '',
        goal: !!k.scoringPlay,
      }
    })
    .filter((e) => e.t)
}

function pickForm(j) {
  const out = {}
  ;(Array.isArray(j.lastFiveGames) ? j.lastFiveGames : []).forEach((g) => {
    const tid = String(g.team && g.team.id)
    const list = (g.events || []).slice(0, 5).map((e) => {
      const isHome = String(e.homeTeamId) === tid
      // ⚠️ 对手名不在 homeTeamId/awayTeamId 里，而在 opponent 对象里（有 id + displayName）
      const opp = e.opponent || {}
      const sc = String(e.score || '')
      return {
        at: isHome ? '主' : '客',
        opp: teamZh(opp.id, opp.displayName),
        sc,
        r: String(e.gameResult || ''),
      }
    })
    out[tid] = list
  })
  return out
}

/** 交锋记录只认已结束的：ESPN 会把「已排定未开赛」的比赛也算进 seasonseries（比分 0-0） */
function isPlayed(e) {
  return !!(e && e.statusType && e.statusType.state === 'post')
}

function pickH2H(j) {
  const ss = (Array.isArray(j.seasonseries) ? j.seasonseries : [])[0]
  if (!ss) return null
  return {
    // ESPN 的 summary 是英文整句（"AZE leads series 2-0-1"），直接用会中英混排。
    // 战绩改成自己从交手列表里数，标题也改成「近 N 次交手」——所见即所列，不会前后矛盾。
    // ⚠️ seasonseries 里混着「本赛程已排定但还没打」的未来比赛（比分 0-0），
    //    赛季初尤其多，直接显示会被当成数据错误 —— 只保留 state==='post' 的。
    list: (ss.events || []).filter(isPlayed).slice(0, 5).map((e) => {
      const cs = e.competitors || []
      const h = cs.find((c) => c.homeAway === 'home') || cs[0] || {}
      const a = cs.find((c) => c.homeAway === 'away') || cs[1] || {}
      return {
        d: String(e.date || '').slice(0, 10),
        ho: teamZh(h.team && h.team.id, h.team && h.team.displayName),
        ao: teamZh(a.team && a.team.id, a.team && a.team.displayName),
        hs: String(h.score == null ? '' : h.score),
        as: String(a.score == null ? '' : a.score),
      }
    }),
  }
}

function pickStats(j, homeId) {
  const teams = (j.boxscore && j.boxscore.teams) || []
  const stat = (t, key) => {
    const s = ((t && t.statistics) || []).find((x) => x.name === key)
    return s ? s.displayValue : null
  }
  const home = teams.find((t) => t.team && String(t.team.id) === String(homeId)) || teams[0]
  const away = teams.find((t) => t.team && String(t.team.id) !== String(homeId)) || teams[1]
  if (!home || !away) return []
  const rows = []
  STAT_ROWS.forEach(([key, label, fmt]) => {
    const hv = stat(home, key)
    const av = stat(away, key)
    if (hv == null || av == null || hv === '' || av === '') return
    rows.push({ k: label, h: fmt ? fmt(hv) : String(hv), a: fmt ? fmt(av) : String(av) })
  })
  return rows
}

/**
 * 定位 ESPN 端点用的联赛 slug。
 * 单一来源赛事（五大联赛/欧冠/中超/NBA）直接查 SLUG 表；
 * 多来源赛事（中国国字号）没有固定 slug，由 sync.js 在抓取时写进比赛对象。
 */
function resolveSlug(m) {
  return m.slug || SLUG[m.comp] || null
}

async function fetchDetail(m) {
  const slug = resolveSlug(m)
  if (!slug) return null
  const sport = BASKETBALL[m.comp] ? 'basketball' : 'soccer'
  const eid = String(m.id).split('-').pop()
  const j = await getJSON(`${ESPN}/${sport}/${slug}/summary?event=${eid}`)
  const homeId = m.home && m.home.id
  const awayId = m.away && m.away.id
  const form = pickForm(j)
  const h2h = pickH2H(j)
  if (h2h) {
    const hz = teamZh(homeId, m.home && m.home.name)
    const az = teamZh(awayId, m.away && m.away.name)
    let hw = 0
    let aw = 0
    let d = 0
    h2h.list.forEach((e) => {
      const hs = Number(e.hs)
      const as = Number(e.as)
      if (!Number.isFinite(hs) || !Number.isFinite(as)) return
      if (hs === as) { d += 1; return }
      const homeWon = hs > as
      const ourSide = e.ho === hz ? 'h' : (e.ho === az ? 'a' : '')
      if (ourSide === 'h') { if (homeWon) hw += 1; else aw += 1 }
      else if (ourSide === 'a') { if (homeWon) aw += 1; else hw += 1 }
    })
    const parts = []
    if (hw) parts.push(`${hz} ${hw} 胜`)
    if (aw) parts.push(`${az} ${aw} 胜`)
    if (d) parts.push(`${d} 平`)
    h2h.total = h2h.list.length
    h2h.summary = parts.length ? `近 ${h2h.list.length} 次交手 ${parts.join(' · ')}` : ''
  }
  return {
    id: m.id,
    comp: m.comp,
    fin: m.status === 'finished',
    v: SCHEMA, // 抽取逻辑版本，变了就重抓一次
    ts: Date.now(), // 抓取时刻：未开赛的场次据此判断要不要刷新
    events: pickEvents(j, homeId),
    form: { home: form[String(homeId)] || [], away: form[String(awayId)] || [] },
    h2h,
    stats: pickStats(j, homeId),
  }
}

/* --------------------------- 云端已抓名单 --------------------------- */

/**
 * 从云端读回已经抓过的比赛，避免重复下载。
 * 只读，失败就当作「全部没抓过」——最坏情况是多抓一轮，不会出错。
 */
async function loadCaptured() {
  const captured = {}
  const buckets = {}
  try {
    const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk')
    const cloud = createWorkBuddyCloud({
      endpoint: publicConfig.endpoint,
      publishableKey: publicConfig.publishableKey,
    })
    const { data } = await cloud.database.from('match_detail').select('id, day, payload')
    ;(data || []).forEach((row) => {
      buckets[row.id] = { day: row.day, payload: row.payload || {} }
      Object.keys(row.payload || {}).forEach((k) => {
        if (row.payload[k]) captured[k] = row.payload[k]
      })
    })
  } catch (err) {
    console.warn('[match-detail] ⚠ 读云端已抓名单失败，本次按全量抓：', (err && err.message) || err)
  }
  return { captured, buckets }
}

/* ------------------------------- 主流程 ------------------------------- */

function dayKey(iso) {
  // 统一按北京时间归档，与小程序展示口径一致
  const d = new Date(new Date(iso).getTime() + 8 * 3600 * 1000)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

/**
 * 判断这场要不要重新抓 —— 全量重抓的话一天 1~2GB 流量会被 ESPN 限流
 *   进行中：每班重抓（比分在变）
 *   已结束：抓一次就够（事件不会变）
 *   未开赛：12 小时一次（近况/交锋变化慢，而且赛前 ESPN 也没更多东西可给）
 */
function needsFetch(m, captured) {
  if (m.status === 'live' || m.status === 'inprogress') return true
  const prev = captured[m.id]
  if (!prev) return true
  // 老版本抽出来的数据（比如早期没过滤未开赛交锋）强制重抓一次
  if (prev.v !== SCHEMA) return true
  if (m.status === 'finished') return false
  return Date.now() - (prev.ts || 0) > UPCOMING_REFRESH_MS
}

async function main() {
  const matches = require('../data/matches.js')
  const list = Array.isArray(matches) ? matches : matches.matches || []
  const now = Date.now()

  const targets = list.filter((m) => {
    // ⚠️ 必须走 resolveSlug（含比赛自带的 slug），只查 SLUG 表会把中国国字号漏掉
    if (!resolveSlug(m)) return false
    const t = new Date(m.start).getTime()
    if (Number.isNaN(t)) return false
    if (m.status === 'finished') return now - t < FINISHED_MS + 6 * 3600 * 1000
    if (m.status === 'live' || m.status === 'inprogress') return true
    // 赛前预览：ESPN 对未开赛的比赛照样给 lastFiveGames / seasonseries，
    // 只是没有事件和统计 —— 页面已有 hasTimeline / hasStats 判断会自动隐藏那两块
    return m.status === 'upcoming' && t - now < UPCOMING_MS
  })

  buildTeamIndex(list)
  const { captured, buckets } = await loadCaptured()
  const todo = targets.filter((m) => needsFetch(m, captured))
  console.log(`[match-detail] 目标 ${targets.length} 场，其中待抓 ${todo.length} 场（进行中每班重抓）`)

  let ok = 0
  const failed = []
  await mapLimit(todo, 4, async (m) => {
    try {
      const d = await fetchDetail(m)
      if (!d) return
      const key = `d-${dayKey(m.start)}`
      if (!buckets[key]) buckets[key] = { day: dayKey(m.start), payload: {} }
      buckets[key].payload[m.id] = d
      ok += 1
    } catch (err) {
      failed.push(`${m.id}: ${(err && err.message) || err}`)
    }
  })

  // 清理过期桶：本地不删云端行，交给 cloud-sync 在推送后处理
  const cutoff = (() => {
    const d = new Date(now - KEEP_DAYS * 24 * 3600 * 1000 + 8 * 3600 * 1000)
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
  })()

  const touched = []
  Object.keys(buckets).forEach((id) => {
    const day = String(id).slice(2)
    if (day < cutoff) return // 过期桶整行丢掉，不再推送（云端的旧行由 cloud-sync 清理）
    const payload = buckets[id].payload || {}
    if (!Object.keys(payload).length) return
    touched.push({ id, day, payload })
  })

  const out = {
    generatedAt: new Date().toISOString(),
    buckets: touched,
    stats: { targets: targets.length, fetched: ok, failed: failed.length, buckets: touched.length },
  }
  const file = path.join(__dirname, '..', 'data', 'match-details.js')
  fs.writeFileSync(
    file,
    `// 自动生成，请勿手改：由 tools/match-detail.js 写入\nmodule.exports = ${JSON.stringify(out)}\n`,
    'utf8'
  )
  const size = Math.round(fs.statSync(file).size / 1024)
  console.log(`[match-detail] 抓取成功 ${ok} 场，失败 ${failed.length} 场，${touched.length} 个日桶 / ${size}KB`)
  if (failed.length) console.warn('[match-detail] 失败场次：', failed.slice(0, 6).join(' | '))
  if (!ok) {
    console.warn('[match-detail] ⚠ 本轮没有抓到任何详情，不覆盖已有数据')
    process.exit(3)
  }
}

// ⚠️ 只在直接执行时跑 main —— smoke.js 会 require 本文件来测纯函数，
//    不守卫的话一 require 就整轮抓取（与 sync.js 同样的坑）
if (require.main === module) {
  main().catch((err) => {
    console.error('[match-detail] 未预期错误：', err && err.stack ? err.stack : err)
    process.exit(1)
  })
}

module.exports = { SCHEMA, keepEvent, zhEvent, briefOf, dayKey, pickEvents, pickForm, pickH2H, pickStats, resolveSlug, needsFetch, isPlayed }
