/**
 * 球队阵容名单（含球员档案）
 * ============================================================
 * 用途：抓 ESPN 的 `/teams/{id}/roster`，推到云表 `team_roster`，
 *       供「球队详情页 → 球队名单」与「球员详情页」读取。
 *
 * 用法： node tools/team-roster.js [--only=epl,csl] [--force] [--dry]
 *
 * 设计要点：
 *   1) **不进代码包**。名单是「一支队 27 人」这种量级，270 支球队打进包要 500KB+，
 *      包体积红线扛不住。所以它和 `match_detail` 一样走云端，包体积增量为 0。
 *   2) **7 天刷新一次**。阵容不像比分那样一天一变，每班（15 分钟）全量重抓是纯浪费，
 *      而且会给上游几百次无意义请求。云端行自带 `updated_at`，够新就跳过。
 *   3) 中文名复用现成字典（`tools/zh-names.js` 的 `PLAYER_ZH` / `AUTO_PLAYER_ZH`），
 *      **不新建索引、不补种**（球员中文名已定「不再主动投入」）。
 *      取不到就留英文短名 —— 中英混排是预期状态。
 *   4) 只读 `data/matches.js` 里**真实出现过**的球队（走 `utils/data.js` 的 teamsOf），
 *      不去遍历 ESPN 的球队目录（那个端点只返回自己那一个联赛，本来也不全）。
 *
 * ⚠️ 端点里的 `fullName` / `displayName` 同样**只有英文**，中文名没有第二个来源。
 */
const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk')
const publicConfig = require('../utils/cloud-config')

// ⚠️ `utils/data.js` 会在 require 时初始化云 SDK，而 SDK 里摸了 `wx` —— 在 Node 里没有。
//    这里补一个最小垫片（与 tools/smoke.js 同一招），只求能 require，不参与断言。
if (typeof global.wx === 'undefined') {
  global.wx = {
    getStorageSync: () => null,
    setStorageSync: () => {},
    removeStorageSync: () => {},
    request: () => {},
    getAccountInfoSync: () => ({ miniProgram: { appId: 'tools' } }),
    login: ({ success }) => success && success({ code: 'mock' }),
  }
}
const dataMod = require('../utils/data.js')
const zhNames = require('./zh-names.js')
const md = require('./match-detail.js') // 只取 SLUG（赛事 → ESPN slug 的唯一来源）
const rosterView = require('../utils/roster.js') // ⚠️ 位置分组规则来源唯一，页面侧用的是同一份

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports'
const FRESH_DAYS = 7
const COMPETITIONS = require('../data/meta.js').competitions
const SLUG = md.SLUG

/** 位置 abbreviation → 中文（ESPN 给 G/D/M/F 四档） */
// 位置表在 utils/roster.js（与页面侧同一份），这里只是取个别名方便写
const POS_ZH = rosterView.POS_ZH
const POS_ORDER = rosterView.POS_ORDER

function arg(name, def) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : def
}
const only = arg('only', '')
const force = process.argv.includes('--force')
const dry = process.argv.includes('--dry')

async function getJSON(url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20000)
      const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      if (attempt === 2) return null
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)))
    }
  }
  return null
}

/**
 * 压成页面直接可用的行。
 * ⚠️ 字段名用单字母：虽然这份数据不进包，但**云端读下来要走网络**，
 *    270 支球队里每次只拉 1 支，字节数关系不大 —— 单字母主要是为了和
 *    data/scorers.js 的行结构保持一致，页面层不用写两套解析。
 */
function rowOf(a) {
  const id = String(a.id || '')
  if (!id) return null
  const pos = (a.position && a.position.abbreviation) || ''
  const city = a.citizenship || ''
  // ⚠️ birthPlace 是个**对象**（`{}` 或 `{displayText}`），不能直接 String() —— 会落 "[object Object]"
  const bpRaw = a.birthPlace
  const bp = typeof bpRaw === 'string' ? bpRaw : String((bpRaw && (bpRaw.displayText || bpRaw.city)) || '')
  // ⚠️ 上游只给英制（height=英寸 / weight=磅）。大陆读者看 "6' 2\"" 没有概念，落成公制。
  const inch = Number(a.height)
  const lb = Number(a.weight)
  return {
    i: id,
    n: String(a.displayName || a.fullName || a.shortName || ''),
    s: String(a.shortName || ''),
    z: zhNames.playerZh(id) || '',
    p: pos,
    pn: POS_ZH[pos] || (a.position && a.position.displayName) || '',
    j: a.jersey != null && Number.isFinite(Number(a.jersey)) ? String(a.jersey) : '',
    ag: Number.isFinite(Number(a.age)) ? Number(a.age) : 0,
    c: city,
    cz: zhNames.nameZh(city) || city,
    bp,
    h: Number.isFinite(inch) && inch > 0 ? `${Math.round(inch * 2.54)}cm` : '',
    w: Number.isFinite(lb) && lb > 0 ? `${Math.round(lb * 0.4536)}kg` : '',
    dob: String(a.dateOfBirth || '').slice(0, 10),
  }
}

/** 阵容按位置分组顺序排：门将 → 后卫 → 中场 → 前锋，同位置按球衣号 */
const POS_ORDER = { G: 0, D: 1, M: 2, F: 3 }
function sortPlayers(list) {
  return list.slice().sort((a, b) => {
    const d = (POS_ORDER[a.p] == null ? 9 : POS_ORDER[a.p]) - (POS_ORDER[b.p] == null ? 9 : POS_ORDER[b.p])
    if (d) return d
    const ja = parseInt(a.j, 10) || 99
    const jb = parseInt(b.j, 10) || 99
    return ja - jb
  })
}

async function main() {
  const comps = COMPETITIONS.filter((c) => {
    if (c.cat !== 'football') return false // NBA 的 roster 端点结构不同，暂不做
    if (!SLUG[c.key]) return false
    if (only && only.split(',').indexOf(c.key) === -1) return false
    return true
  })

  const cloud = createWorkBuddyCloud({
    endpoint: publicConfig.endpoint,
    publishableKey: publicConfig.publishableKey,
  })

  // 先把云端已有的行一次读出来（只取 id + updated_at），避免每队一次查询
  const { data: existing, error: existErr } = await cloud.database
    .from('team_roster')
    .select('id, updated_at')
    .limit(2000)
  if (existErr) console.warn('[team-roster] 读云端存量失败（按全量抓处理）：', JSON.stringify(existErr).slice(0, 160))
  const freshUntil = Date.now() - FRESH_DAYS * 86400000
  const fresh = {}
  ;(existing || []).forEach((r) => {
    if (!force && r.updated_at && Date.parse(r.updated_at) > freshUntil) fresh[r.id] = 1
  })
  console.log(`[team-roster] 云端已有 ${Object.keys(fresh).length} 支球队在 ${FRESH_DAYS} 天内刷过${force ? '（--force 强制重抓）' : ''}`)

  let ok = 0
  let skipped = 0
  let failed = 0
  const rows = []

  for (const comp of comps) {
    const teams = dataMod.teamsOf(comp.key)
    const slug = SLUG[comp.key]
    if (!teams.length) continue
    console.log(`[team-roster] ${comp.key.padEnd(11)} ${teams.length} 队 …`)

    for (const t of teams) {
      const id = `${comp.key}:${t.id}`
      if (fresh[id]) { skipped += 1; continue }
      const j = await getJSON(`${ESPN}/soccer/${slug}/teams/${t.id}/roster`)
      const players = sortPlayers(((j && j.athletes) || []).map(rowOf).filter(Boolean))
      if (!players.length) { failed += 1; continue }
      rows.push({
        id,
        comp: comp.key,
        team_id: String(t.id),
        payload: {
          v: 1,
          team: t.zh || t.name || '',
          // 🔴 **故意不带 coach**：上游 `j.coach` 是脏数据 —— 实测切尔西与皇马都返回
          //    "Jose Mourinho"、阿森纳返回 "Arsene Wenger"（2018 年就离任了）。
          //    错的教练名字比没有教练更糟（2026-10-04 核实），别再把它加回来。
          players,
          season: (j.season && (j.season.displayName || j.season.year)) || '',
        },
        generated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      ok += 1
      // 别把上游打挂
      await new Promise((r) => setTimeout(r, 220))
    }
  }

  console.log(`[team-roster] 抓到 ${ok} 支 / 跳过 ${skipped} 支 / 失败 ${failed} 支`)
  if (dry) {
    console.log('[team-roster] --dry：不写云端。样例：')
    if (rows[0]) console.log(JSON.stringify(rows[0]).slice(0, 500))
    return
  }
  if (!rows.length) { console.log('[team-roster] 没有需要更新的球队。'); return }

  // 分批 upsert（单次 payload 太大容易被网关拒）
  const BATCH = 40
  let pushed = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const part = rows.slice(i, i + BATCH)
    const { data, error } = await cloud.database
      .from('team_roster')
      .upsert(part, { onConflict: 'id' })
      .select('id')
    if (error) {
      console.error(`[team-roster] 第 ${i / BATCH + 1} 批推送失败：`, JSON.stringify(error).slice(0, 200))
      continue
    }
    pushed += (data && data.length) || part.length
  }
  console.log(`[team-roster] 已推送 ${pushed}/${rows.length} 支球队到云端 team_roster`)

  // 顺带清掉 60 天没更新的（换赛季后老队的名单会整个失效）
  const { error: delErr } = await cloud.database
    .from('team_roster')
    .delete()
    .lt('updated_at', new Date(Date.now() - 60 * 86400000).toISOString())
  if (delErr) console.log('[team-roster] 清理旧名单跳过（' + JSON.stringify(delErr).slice(0, 120) + '）')
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[team-roster] 未预期错误：', err && err.stack ? err.stack : err)
    process.exit(1)
  })
}

module.exports = { rowOf, sortPlayers }
