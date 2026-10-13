/**
 * 订阅消息模板核查（只在需要时手动跑，不进小程序包）
 * ============================================================
 * 用途：核实两个模板的**真实字段**（文案 / key / 类型），并用样例比赛数据试算一遍
 *       `templateData()`，直接告诉你哪个字段会填成什么值、有没有填不出来的。
 *       避免「只看模板 ID 存在」就以为配置正确。
 *
 * 两种模式：
 *   1) 有凭据（权威）：
 *        WECHAT_APP_ID=xxx WECHAT_APP_SECRET=yyy node tools/check-notification-templates.js
 *      → 调 `wxaapi/newtmpl/gettemplate` 拉真实 content。
 *   2) 无凭据（离线快照）：
 *        node tools/check-notification-templates.js
 *      → 用 tools/match-notification-known-templates.js 里按后台截图记录的字段快照。
 *        ⚠️ 快照会随后台改动过期，只用来自查「映射对不对」，不能替代第 1 种。
 *      `--offline` 可强制走快照（即使配了凭据）。
 *
 * 🔴 凭据只从环境变量读，**绝不写入任何文件**；脚本不发送任何消息（只读接口）。
 */
const config = require('../utils/cloud-config')
const notificationConfig = require('../utils/match-notification-config')
const core = require('../utils/match-notification-core')
const competitions = require('../data/meta').competitions
const known = require('./match-notification-known-templates')

const WEIXIN = 'https://api.weixin.qq.com'

/** 微信对各类型字段的长度/格式上限（超了会被 errcode 47003 整条拒收） */
const LIMITS = {
  thing: 20, phrase: 5, letter: 32, symbol: 5, character_string: 32,
  number: 32, amount: 10, name: 10, phone_number: 17, car_number: 8,
}

async function jsonRequest(url, init) {
  const response = await fetch(url, init)
  const body = await response.json()
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return body
}

async function accessToken(appId, appSecret) {
  const url = new URL(`${WEIXIN}/cgi-bin/token`)
  url.searchParams.set('grant_type', 'client_credential')
  url.searchParams.set('appid', appId)
  url.searchParams.set('secret', appSecret)
  const result = await jsonRequest(url, { method: 'GET' })
  if (!result.access_token) throw new Error(`取 access_token 失败：errcode=${result.errcode} ${result.errmsg || ''}`)
  return result.access_token
}

/** 兼容旧调用点：从 content 里列出全部字段 */
function declaredFields(content) {
  return core.parseTemplateFields(content).fields
}

/**
 * 样例比赛数据 —— **刻意用云端 schedule_cache 的真实形状**：
 * 队名字段是 `zh`（不是页面层才补的 `zhName`），赛事名/大类由 worker 注入，
 * 若这里写成页面形状，就会把「生产环境其实取不到中文队名」这类问题藏起来。
 */
const SAMPLE = {
  upcoming: {
    id: 'epl-999', comp: 'epl', status: 'upcoming',
    start: '2026-10-20T04:00:00Z', date: '2026-10-20', time: '12:00',
    stage: '英超', bo: null, statusText: '',
    home: { id: '359', zh: '阿森纳', abbr: 'ARS', name: 'Arsenal', score: 0 },
    away: { id: '382', zh: '曼城', abbr: 'MCI', name: 'Manchester City', score: 0 },
  },
  finished: {
    id: 'nba-999', comp: 'nba', status: 'finished',
    start: '2026-10-20T02:00:00Z', date: '2026-10-20', time: '10:00',
    stage: 'NBA · 季前赛', bo: null, statusText: '已结束',
    home: { id: '13', zh: '洛杉矶湖人', abbr: 'LAL', name: 'Los Angeles Lakers', score: 112 },
    away: { id: '9', zh: '金州勇士', abbr: 'GSW', name: 'Golden State Warriors', score: 108 },
  },
}

/** 与 tools/match-notification-push.js 的 createMessage 保持同一套注入 */
function withComp(match) {
  const comp = competitions.find(item => item.key === match.comp) || {}
  return Object.assign({}, match, {
    compName: comp.name || comp.full || match.comp,
    compCat: comp.cat,
  })
}

function tryFill(match, content, kind) {
  try {
    return { ok: true, data: core.templateData(withComp(match), content, kind) }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

async function resolveTemplates(offline) {
  const appId = process.env.WECHAT_APP_ID
  const appSecret = process.env.WECHAT_APP_SECRET
  if (process.argv.includes('--online') && (!appId || !appSecret || offline)) {
    throw new Error('--online requires WECHAT_APP_ID and WECHAT_APP_SECRET; offline fallback is disabled')
  }
  if (offline || !appId || !appSecret) {
    console.log('[check-templates] 模式：离线快照（未提供 WECHAT_APP_ID / WECHAT_APP_SECRET）')
    console.log('            ⚠️ 快照按后台截图复原，后台改过模板就会过期；有凭据时请重跑以走接口。')
    return {
      source: 'snapshot',
      kickoff: { priTmplId: known.kickoff.id, title: known.kickoff.title, content: known.kickoff.content },
      result: { priTmplId: known.result.id, title: known.result.title, content: known.result.content },
    }
  }
  console.log('[check-templates] 模式：微信接口（权威）')
  const token = await accessToken(appId, appSecret)
  const url = new URL(`${WEIXIN}/wxaapi/newtmpl/gettemplate`)
  url.searchParams.set('access_token', token)
  const list = await jsonRequest(url, { method: 'GET' })
  if (Number(list.errcode || 0) !== 0 || !Array.isArray(list.data)) {
    throw new Error(`拉取模板列表失败：${JSON.stringify(list).slice(0, 200)}`)
  }
  console.log(`[check-templates] 该小程序当前共有 ${list.data.length} 个订阅消息模板`)
  const pick = (id, label) => {
    const hit = list.data.find((item) => item.priTmplId === id)
    if (!hit) throw new Error(`模板 ${label} 不在本小程序账号下：${id}`)
    return hit
  }
  return {
    source: 'api',
    kickoff: pick(notificationConfig.templates.kickoff, 'kickoff'),
    result: pick(notificationConfig.templates.result, 'result'),
  }
}

function report(name, template, sample, kind, expectedId) {
  console.log(`\n===== ${name} =====`)
  let problems = 0
  if (template.priTmplId !== expectedId) {
    problems += 1
    console.log(`  ❌ 模板 ID 与代码里配置的不一致：接口=${template.priTmplId} 代码=${expectedId}`)
  } else {
    console.log(`  ✅ 模板 ID 与 utils/match-notification-config.js 一致`)
  }
  console.log(`  标题：${template.title || '(无)'}`)
  console.log('  ---- 模板原文 ----')
  console.log('  ' + String(template.content || '').split('\n').join('\n  '))

  const parsed = core.parseTemplateFields(template.content)
  console.log('  ---- 字段清单（key / 类型 / 标签 / 映射来源） ----')
  parsed.fields.forEach((field, index) => {
    const labelled = Boolean(parsed.labelByKey[field.key])
    console.log(`    ${field.key.padEnd(20)} ${field.type.padEnd(17)} ${(field.label || '(无标签)').padEnd(8)} ${labelled ? '标签精确映射' : `⚠️ 位置兜底（第 ${index + 1} 个）`}`)
  })
  const unlabelled = parsed.fields.filter((f) => !f.label)
  if (unlabelled.length) {
    console.log(`  ⚠️ 有 ${unlabelled.length} 个字段没有解析出标签，只能按位置取值 —— 后台调整字段顺序就会填错。`)
  }

  const filled = tryFill(sample, template.content, kind)
  if (!filled.ok) {
    problems += 1
    console.log('  ❌ 用样例数据试算失败：', filled.error)
    console.log('     → 这条通知在线上会因字段不合规而发不出去，需要调整映射或模板字段。')
    return problems
  }
  console.log('  ---- 样例数据试算结果 ----')
  let unfilled = 0
  parsed.fields.forEach((field) => {
    const cell = filled.data[field.key]
    if (!cell) {
      unfilled += 1
      console.log(`    ❌ ${field.key} 未被填值`)
      return
    }
    const limit = LIMITS[field.type]
    const length = Array.from(String(cell.value)).length
    const capped = limit && length >= limit
    console.log(`    ${capped ? '⚠️' : '✅'} ${field.key.padEnd(20)} = ${JSON.stringify(cell.value)}`)
    if (capped) {
      console.log(`       ↑ ${field.type} 类型上限 ${limit} 字符，已经顶到上限，内容可能被截断`)
    }
  })
  if (unfilled) problems += 1
  return problems
}

async function main() {
  const offline = process.argv.includes('--offline')
  console.log('[check-templates] endpoint =', config.endpoint ? '(已配置)' : '(缺失)')
  console.log('[check-templates] 期望模板：kickoff =', notificationConfig.templates.kickoff)
  console.log('[check-templates] 期望模板：result  =', notificationConfig.templates.result)

  let problems = 0
  const templates = await resolveTemplates(offline)
  problems += report('kickoff（赛前 60 / 15 分钟共用，模板编号 6637）',
    templates.kickoff, SAMPLE.upcoming, 'kickoff', notificationConfig.templates.kickoff)
  problems += report('result（赛果，模板编号 72357）',
    templates.result, SAMPLE.finished, 'result', notificationConfig.templates.result)

  console.log(`\n[check-templates] 完成（来源：${templates.source}），问题项 ${problems} 个`)
  process.exit(problems ? 2 : 0)
}

main().catch((error) => {
  console.error('[check-templates] 异常：', (error && error.message) || error)
  process.exit(1)
})

module.exports = { declaredFields }
