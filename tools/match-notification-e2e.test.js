/**
 * 通知链路端到端测试（领取 → 组装 → 发送 → 状态回写）
 * ============================================================
 * 全程使用 stub（假云端 + 假微信接口），**不联网、不发送任何真实消息**。
 * 覆盖的是真正容易出错的地方：字段类型不合规、模板字段漏填 / 填错、过期判断、
 * 凭据缺失时的降级、以及回写状态用的乐观锁。
 *
 * 🔴 模板 content 用的是**后台截图的真实字段**（tools/match-notification-known-templates.js），
 *    比赛数据用的是**云端行的真实形状**（队名只有 `zh`）。用页面层的 `zhName`
 *    造数据会让「生产环境其实取不到中文队名」这类问题被测试放过。
 */
const assert = require('node:assert/strict')
const test = require('node:test')
const worker = require('./match-notification-push')
const config = require('../utils/match-notification-config')
const core = require('../utils/match-notification-core')
const known = require('./match-notification-known-templates')

const KICKOFF = config.templates.kickoff
const RESULT = config.templates.result

function templateSet(kickoffContent, resultContent) {
  return [
    { priTmplId: KICKOFF, title: known.kickoff.title, content: kickoffContent },
    { priTmplId: RESULT, title: known.result.title, content: resultContent },
  ]
}

/** 与小程序后台完全一致的两个模板 */
const PRODUCTION_TEMPLATES = templateSet(known.kickoff.content, known.result.content)

const ENV = {
  NOTIFY_TOKEN: 'a'.repeat(64),
  WECHAT_APP_ID: 'wxstubappid',
  WECHAT_APP_SECRET: 'stub-app-secret',
  WECHAT_MINIPROGRAM_STATE: 'trial',
}

function jsonResponse(body) { return { ok: true, json: async () => body } }

function makeCloud(claimRows) {
  const writes = []
  return {
    writes,
    cloud: {
      database: {
        async rpc(name, args) {
          writes.push({ type: 'rpc', name, args })
          if (name === 'claim_due_match_notifications') return { data: claimRows, error: null }
          if (name === 'finish_match_notification') {
            writes.push({ type: 'update', filter: {
              claimed_at: args.p_claimed_at,
              values: { status: args.p_status, last_error: args.p_error, sent_at: args.p_status === 'sent' ? 'server-time' : null },
            } })
            return { data: 1, error: null }
          }
          throw new Error('unexpected RPC')
        },
        from(table) {
          const filter = {}
          const builder = {
            update(values) { filter.values = values; return builder },
            eq(column, value) { filter[column] = value; return builder },
            async select() {
              writes.push({ type: 'update', table, filter })
              return { data: [{ owner_id: filter.owner_id || 'row' }], error: null }
            },
          }
          return builder
        },
      },
    },
  }
}

function makeFetch(templates, sendResult = { errcode: 0, errmsg: 'ok' }) {
  const calls = []
  return {
    calls,
    impl: async (input, init = {}) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.includes('/cgi-bin/token')) return jsonResponse({ access_token: 'STUB_TOKEN', expires_in: 7200 })
      if (url.includes('/wxaapi/newtmpl/gettemplate')) return jsonResponse({ errcode: 0, data: templates })
      if (url.includes('/message/subscribe/send')) return jsonResponse(sendResult)
      throw new Error(`unexpected fetch ${url}`)
    },
  }
}

/** 云端 match_notification_subscriptions 里 claim 出来的行 —— match_data 是 schedule_cache 的原样元素 */
function row(overrides = {}) {
  return Object.assign({
    owner_id: 'wx:test-openid',
    match_id: 'epl-999',
    kind: 'pre60',
    attempts: 0,
    claimed_at: '2026-10-20T03:00:00.000Z',
    match_data: {
      id: 'epl-999', comp: 'epl', status: 'upcoming',
      start: '2026-10-20T04:00:00Z', date: '2026-10-20', time: '12:00',
      stage: '英超', bo: null, statusText: '',
      home: { id: '359', zh: '阿森纳', abbr: 'ARS', name: 'Arsenal', score: 0 },
      away: { id: '382', zh: '曼城', abbr: 'MCI', name: 'Manchester City', score: 0 },
    },
  }, overrides)
}

const BEFORE_KICKOFF = Date.parse('2026-10-20T03:00:00Z')

test('worker uses its own token for claim and completion RPCs without service-role credentials or table access', async () => {
  const workerToken = 'a'.repeat(64)
  const calls = []
  const cloud = { database: {
    async rpc(name, args) {
      calls.push({ name, args })
      assert.equal(args.p_token, workerToken)
      return { data: name === 'claim_due_match_notifications' ? [row()] : 1, error: null }
    },
    from() { throw new Error('notification table must stay private') },
  } }
  global.fetch = makeFetch(PRODUCTION_TEMPLATES).impl
  const result = await worker.main(cloud, { ...ENV, WB_SERVICE_ROLE_KEY: undefined, NOTIFY_TOKEN: workerToken }, BEFORE_KICKOFF)
  assert.equal(result.sent, 1)
  assert.deepEqual(calls.map(c => c.name), ['claim_due_match_notifications', 'finish_match_notification'])
  assert.equal(calls[1].args.p_claimed_at, row().claimed_at)
  assert.equal(calls[1].args.p_status, 'sent')
})

test('missing worker credentials fail explicitly before any cloud access', async () => {
  const { cloud, writes } = makeCloud([])
  await assert.rejects(() => worker.main(cloud, {}), /NOTIFY_TOKEN/)
  assert.equal(writes.length, 0)
})

test('check-only validates real credentials and templates without claiming or sending', async () => {
  const rpcs = []
  const cloud = { database: { async rpc(name, args) {
    rpcs.push(name)
    assert.equal(args.p_token, ENV.NOTIFY_TOKEN)
    assert.equal(name, 'check_match_notification_worker')
    return { data: true, error: null }
  } } }
  const { impl, calls } = makeFetch(PRODUCTION_TEMPLATES)
  global.fetch = impl
  const result = await worker.main(cloud, ENV, BEFORE_KICKOFF, { checkOnly: true })
  assert.deepEqual(result, { checked: true, templates: 2, sent: 0 })
  assert.deepEqual(rpcs, ['check_match_notification_worker'])
  assert.equal(calls.some(c => c.url.includes('/message/subscribe/send')), false)
})

test('a declined or exhausted subscription becomes failed immediately instead of retrying the same authorization', async () => {
  const { cloud, writes } = makeCloud([row()])
  global.fetch = makeFetch(PRODUCTION_TEMPLATES, { errcode: 43101, errmsg: 'user refuse to accept the msg' }).impl
  const result = await worker.main(cloud, ENV, BEFORE_KICKOFF)
  assert.equal(result.failed, 1)
  assert.equal(writes.find(w => w.type === 'update').filter.values.status, 'failed')
})

test('successful delivery followed by a completion error is never immediately reset to pending', async () => {
  const calls = []
  const cloud = { database: { async rpc(name, args) {
    calls.push({ name, args })
    return name === 'claim_due_match_notifications' ? { data: [row()], error: null } : { data: 0, error: null }
  } } }
  global.fetch = makeFetch(PRODUCTION_TEMPLATES).impl
  await assert.rejects(() => worker.main(cloud, ENV, BEFORE_KICKOFF), /claim changed/)
  assert.equal(calls.filter(c => c.name === 'finish_match_notification').length, 1)
  assert.equal(calls[1].args.p_status, 'sent')
})

test('claim → send → mark：kickoff 模板五个字段全部填对，体验版用 trial', async () => {
  const { cloud, writes } = makeCloud([row()])
  const { impl, calls } = makeFetch(PRODUCTION_TEMPLATES)
  global.fetch = impl

  const out = await worker.main(cloud, ENV, BEFORE_KICKOFF)
  assert.deepEqual(out, { processed: 1, sent: 1, expired: 0, failed: 0 })

  const body = JSON.parse(calls.find((c) => c.url.includes('/message/subscribe/send')).init.body)
  assert.equal(body.touser, 'test-openid')          // owner_id 的 wx: 前缀被剥掉
  assert.equal(body.template_id, KICKOFF)           // pre60 与 pre15 共用 kickoff
  assert.equal(body.miniprogram_state, 'trial')     // 体验版阶段必须用 trial
  assert.equal(body.page, 'pages/detail/detail?id=epl-999')
  // 逐字段断死：thing6（比赛对阵）排在 thing4（赛制）之前，靠位置兜底就会串位
  assert.deepEqual(body.data, {
    thing1: { value: '英超' },
    thing2: { value: '2026年10月20日 12:00' },
    thing3: { value: '足球' },
    thing6: { value: '阿森纳 vs 曼城' },
    thing4: { value: '单场' },
  })

  const mark = writes.find((w) => w.type === 'update')
  assert.equal(mark.filter.values.status, 'sent')
  assert.ok(mark.filter.values.sent_at)
  // 乐观锁：回写时必须带上领取时的 claimed_at，避免并发覆盖
  assert.equal(mark.filter.claimed_at, '2026-10-20T03:00:00.000Z')
})

test('claim → send → mark：result 模板五个字段全部填对', async () => {
  const { cloud, writes } = makeCloud([row({
    kind: 'result', match_id: 'nba-999',
    match_data: {
      id: 'nba-999', comp: 'nba', status: 'finished',
      start: '2026-10-20T02:00:00Z', date: '2026-10-20', time: '10:00',
      stage: 'NBA · 季前赛', bo: null, statusText: '已结束',
      home: { id: '13', zh: '洛杉矶湖人', abbr: 'LAL', name: 'Los Angeles Lakers', score: 112 },
      away: { id: '9', zh: '金州勇士', abbr: 'GSW', name: 'Golden State Warriors', score: 108 },
    },
  })])
  const { impl, calls } = makeFetch(PRODUCTION_TEMPLATES)
  global.fetch = impl

  const out = await worker.main(cloud, ENV, BEFORE_KICKOFF)
  assert.equal(out.sent, 1)

  const body = JSON.parse(calls.find((c) => c.url.includes('/message/subscribe/send')).init.body)
  assert.equal(body.template_id, RESULT)
  assert.deepEqual(body.data, {
    thing1: { value: 'NBA' },
    time10: { value: '2026年10月20日 10:00' },
    thing9: { value: '湖人 vs 勇士' },
    character_string6: { value: '112:108' },
    thing11: { value: '湖人112-108击败勇士' },
  })
  assert.equal(writes.find((w) => w.type === 'update').filter.values.status, 'sent')
})

test('字段类型无法满足时拒绝发送，并留下可读的 last_error', async () => {
  // 真实场景：LPL/LoL 的队名没有中文（KC / C9），而模板把「胜方」接在了
  // 只收 5 个纯汉字的 phrase 字段上 → 取不出合规内容，必须拦下来不发。
  const { cloud, writes } = makeCloud([row({
    kind: 'result', match_id: 'worlds-999',
    match_data: {
      id: 'worlds-999', comp: 'worlds', status: 'finished',
      start: '2026-10-20T02:00:00Z', stage: '全球总决赛 · 入围赛', bo: '3', statusText: '已结束',
      home: { id: '1', zh: '', abbr: 'KC', name: 'KC', score: 2 },
      away: { id: '2', zh: '', abbr: 'C9', name: 'C9', score: 1 },
    },
  })])
  const { impl, calls } = makeFetch(templateSet(known.kickoff.content, '赛事名称：{{thing1.DATA}}\n胜方：{{phrase9.DATA}}'))
  global.fetch = impl

  const out = await worker.main(cloud, ENV, BEFORE_KICKOFF)
  assert.equal(out.failed, 1)
  assert.equal(calls.some((c) => c.url.includes('/message/subscribe/send')), false)
  const mark = writes.find((w) => w.type === 'update')
  assert.match(String(mark.filter.values.last_error), /phrase9/)
  assert.equal(mark.filter.values.status, 'pending') // 首次失败仍可重试
})

test('result message uses a complete daily-brief summary instead of status or stage, within 20 characters', () => {
  for (const [comp, hs, as, bo, home, away, expected] of [
    ['ucl', 1, 4, null, '加拉塔萨雷', '巴塞罗那', '巴塞罗那4-1大胜加拉塔萨雷'],
    ['worlds', 3, 2, '5', 'AL', 'T1', 'AL打满五局力克T1'],
    ['kpl', 4, 0, '7', 'AG', 'KSG', 'AG4-0零封KSG'],
    ['nba', 112, 110, null, '湖人', '勇士', '湖人112-110险胜勇士'],
  ]) {
    const r = row({ kind: 'result' })
    const m = { ...r.match_data, comp, bo, status: 'finished', statusText: '已结束',
      stage: '阶段信息', home: { zh: home, score: hs }, away: { zh: away, score: as } }
    const message = worker.createMessage(r, m, PRODUCTION_TEMPLATES[1], 'trial')
    assert.equal(message.data.thing11.value, expected)
    assert.ok(Array.from(message.data.thing11.value).length <= 20)
    assert.equal(message.data.character_string6.value, `${hs}:${as}`)
  }
})

test('已过期的提醒记为 expired，不会发出消息', async () => {
  const { cloud, writes } = makeCloud([row({ claimed_at: '2026-10-20T03:50:00.000Z' })])
  const { impl, calls } = makeFetch(PRODUCTION_TEMPLATES)
  global.fetch = impl

  const out = await worker.main(cloud, ENV, Date.parse('2026-10-20T03:50:00Z')) // 已过 start-15min
  assert.equal(out.expired, 1)
  assert.equal(out.sent, 0)
  assert.equal(calls.some((c) => c.url.includes('/message/subscribe/send')), false)
  assert.equal(writes.find((w) => w.type === 'update').filter.values.status, 'expired')
})

test('缺少 Secrets 时明确失败，不读云端也不误报成功', async () => {
  const { cloud, writes } = makeCloud([row()])
  const { impl, calls } = makeFetch(PRODUCTION_TEMPLATES)
  global.fetch = impl

  await assert.rejects(() => worker.main(cloud, {}, Date.now()), /Missing notification configuration/)
  assert.equal(writes.length, 0)
  assert.equal(calls.length, 0)
})

test('小程序后台缺少任一模板时明确报错，而不是静默少发', async () => {
  const { cloud } = makeCloud([row()])
  const { impl } = makeFetch([PRODUCTION_TEMPLATES[0]]) // 只有 kickoff
  global.fetch = impl

  await assert.rejects(
    () => worker.main(cloud, ENV, BEFORE_KICKOFF),
    /absent/,
  )
})

test('模板里出现的每个字段都会被填值（含标签识别不出来的那些）', () => {
  const data = core.templateData(row().match_data, '{{thing1.DATA}}\n比赛时间：{{thing2.DATA}}', 'pre60')
  assert.deepEqual(Object.keys(data).sort(), ['thing1', 'thing2'])
  assert.equal(data.thing1.value, '英超')            // 没标签 → 位置兜底取赛事名
  assert.equal(data.thing2.value, '2026年10月20日 12:00')
})
