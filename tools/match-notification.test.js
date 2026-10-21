const assert = require('node:assert/strict')
const test = require('node:test')
const core = require('../utils/match-notification-core')
const config = require('../utils/match-notification-config')
const worker = require('./match-notification-push')
const known = require('./match-notification-known-templates')

const now = Date.parse('2026-10-20T03:45:00Z')

/**
 * 生产形状的比赛对象 —— 与云端 `schedule_cache` 里那一行**逐字段对齐**：
 *   · 队名只有 `zh`（`zhName` 是页面层 utils/view.js 才补的字段，库里没有）
 *   · `compName` / `compCat` 由推送进程的 createMessage 注入
 * 🔴 早先的测试用 `zhName` 造数据，等于把「生产环境取不到中文队名」这件事藏起来了。
 */
function match(overrides = {}) {
  return Object.assign({
    id: 'worlds-123', comp: 'worlds', compName: '全球总决赛', compCat: 'esports',
    status: 'upcoming', start: '2026-10-20T04:00:00Z',
    stage: '全球总决赛 · 瑞士轮', bo: '5', statusText: '',
    home: { id: '1', zh: 'AL', abbr: 'AL', name: "Anyone's Legend" },
    away: { id: '2', zh: 'T1', abbr: 'T1', name: 'T1' },
  }, overrides)
}

test('all-match pre-kickoff reminders support 60-minute and 15-minute rounds', () => {
  assert.equal(core.isDue(match(), now, 'pre15'), true)
  assert.equal(core.isDue(match({ comp: 'epl' }), now, 'pre15'), true)
  assert.equal(core.isDue(match({ start: '2026-10-20T04:00:01Z' }), now, 'pre15'), false)
  assert.equal(core.isDue(match({ start: '2026-10-20T03:34:59Z', status: 'live' }), now, 'pre15'), false)
  assert.equal(core.isDue(match({ start: '2026-10-20T03:35:00Z', status: 'live' }), now, 'pre15'), true)
  assert.equal(core.isDue(match({ start: '2026-10-20T04:35:00Z' }), now, 'pre60'), true)
  assert.equal(core.isDue(match({ start: '2026-10-20T04:35:01Z' }), now, 'pre60'), true)
  assert.equal(core.isDue(match({ start: '2026-10-20T04:46:00Z' }), now, 'pre60'), false)
})

test('pre-match reminders ignore live 60-minute rounds, final matches and invalid times', () => {
  assert.equal(core.isDue(match({ status: 'finished' }), now, 'pre15'), false)
  assert.equal(core.isDue(match({ status: 'finished' }), now), false)
  assert.equal(core.isDue(match({ start: 'not-a-date' }), now), false)
  assert.equal(core.isDue(match({ start: '' }), now), false)
})

test('favorite consent requests only notifications that can still be sent', () => {
  assert.deepEqual(config.kindsFor(match(), now), ['pre15', 'result'])
  assert.deepEqual(config.kindsFor(match({ status: 'live' }), now), ['result'])
  assert.deepEqual(config.kindsFor(match({ start: '2026-10-20T03:40:00Z' }), now), ['result'])
  assert.deepEqual(config.kindsFor(match({ status: 'finished' }), now), [])
})

test('all-match result notifications are due only after a final score is available', () => {
  assert.equal(core.isDue(match({ status: 'finished', home: { score: 2 }, away: { score: 1 } }), now, 'result'), true)
  assert.equal(core.isDue(match({ comp: 'nba', status: 'finished', home: { score: 102 }, away: { score: 99 } }), now, 'result'), true)
  assert.equal(core.isDue(match({ status: 'live', home: { score: 2 }, away: { score: 1 } }), now, 'result'), false)
  assert.equal(core.isDue(match({ status: 'finished', home: {}, away: {} }), now, 'result'), false)
  assert.equal(core.isDue(match({ status: 'finished', home: { score: '' }, away: { score: '' } }), now, 'result'), false)
})

test('template payload discovers field keys from template content and limits thing text', () => {
  const data = core.templateData(match({ home: { zh: '超长队伍名称甲乙丙丁戊己庚辛壬癸' } }),
    '对阵：{{thing1.DATA}}\n开赛时间：{{time2.DATA}}', 'kickoff')
  assert.deepEqual(Object.keys(data).sort(), ['thing1', 'time2'])
  assert.equal(Array.from(data.thing1.value).length <= 20, true)
  assert.match(data.time2.value, /2026年10月20日 12:00/)
})

test('result template content maps score and winner labels to the final match result', () => {
  const data = core.templateData(match({
    status: 'finished', home: { zh: 'AL', score: 3 }, away: { zh: 'T1', score: 2 },
  }), '比赛结果：{{thing1.DATA}}\n胜方：{{thing2.DATA}}', 'result')
  assert.equal(data.thing1.value, 'AL 3:2 T1')
  assert.equal(data.thing2.value, 'AL')
})

test('result character_string contains the score only; Chinese team names stay in the teams field', () => {
  const m = match({ status: 'finished', home: { zh: '阿森纳', score: 2 }, away: { zh: '曼城', score: 1 } })
  const result = core.templateData(m, '参赛人员：{{thing9.DATA}}\n完赛结果：{{character_string6.DATA}}', 'result')
  assert.equal(result.character_string6.value, '2:1')
  assert.equal(result.thing9.value, '阿森纳 vs 曼城')
})

test('worker converts the cloud account id to a WeChat openid without logging or exposing the account id', () => {
  assert.equal(worker.recipientOpenId('wx:openid-value'), 'openid-value')
  assert.equal(worker.recipientOpenId('anonymous'), '')
})

test('field values are coerced to the WeChat type rules before sending', () => {
  // thing / character_string：按字符数截断
  assert.equal(Array.from(core.coerceByType('thing', 'x'.repeat(50))).length, 20)
  assert.equal(Array.from(core.coerceByType('character_string', 'y'.repeat(50))).length, 32)
  // number：只能数字，可带小数
  assert.equal(core.coerceByType('number', 'AL 3:2 T1'), '3')
  assert.equal(core.coerceByType('number', '12.5 分'), '12.5')
  assert.equal(core.coerceByType('number', '待定'), '')
  // amount：1 个币种符号 + 10 位以内数字
  assert.equal(core.coerceByType('amount', '票价 88 元'), '¥88')
  // phrase：5 个以内**纯汉字**，非汉字必须滤掉
  assert.equal(core.coerceByType('phrase', 'KC vs SK'), '')
  assert.equal(core.coerceByType('phrase', '比赛进行中'), '比赛进行中')
  assert.equal(core.coerceByType('phrase', '一二三四五六七'), '一二三四五')
  // letter / symbol / name
  assert.equal(core.coerceByType('letter', 'AL 3:2 T1'), 'ALT')
  assert.equal(core.coerceByType('symbol', 'AL 3:2 T1'), ':')
  assert.equal(core.coerceByType('name', '张三丰'), '张三丰')
  assert.equal(core.coerceByType('name', 'Faker'), 'Faker')
  // time 官方支持带年月日；date 归一化成 YYYY-MM-DD，认不出来时回退原值而不是给空串
  assert.equal(core.coerceByType('time', '2026年10月20日 12:00'), '2026年10月20日 12:00')
  assert.equal(core.coerceByType('time', '15:01'), '15:01')
  assert.equal(core.coerceByType('date', '2026年10月20日 12:00'), '2026-10-20')
  assert.equal(core.coerceByType('date', '坏日期'), '坏日期')
})

test('every {{key.DATA}} the template declares gets a value, even without a readable label', () => {
  const data = core.templateData(match(), '{{thing1.DATA}}\n开赛时间：{{time2.DATA}}', 'kickoff')
  assert.deepEqual(Object.keys(data).sort(), ['thing1', 'time2'])
  assert.ok(data.thing1.value)
  assert.ok(data.time2.value)
})

test('a field whose type cannot be satisfied raises instead of sending an invalid payload', () => {
  // 英文队名塞进 5 个纯汉字的 phrase 字段 → 必须拒绝，而不是原样发出去被微信 47003 拒收
  assert.throws(() => core.templateData(match(), '对阵：{{phrase1.DATA}}', 'kickoff'), /phrase1/)
  // 纯中文「待定」塞进 number 字段 → 取不出数字 → 拒绝
  assert.throws(() => core.templateData(match(), '胜方：{{number1.DATA}}', 'result'), /number1/)
})

test('pre60 and pre15 share one template, so the 60-minute round needs its own authorization', () => {
  assert.equal(config.templateId('pre60'), config.templateId('pre15'))
  assert.equal(config.templateId('pre60'), config.templateId('kickoff'))
  assert.notEqual(config.templateId('pre60'), config.templateId('result'))
  // 关注时只申请 15 分钟 + 赛果；pre60 必须由「加一轮」入口再授权一次，
  // 否则一次 kickoff 授权只够发一条，另一个必然拿不到额度。
  // 🔴 必须显式传 now：kindsFor 的默认参数是真实时钟，而 match() 的 start 写死为
  // 2026-10-20T04:00:00Z。一旦系统时间越过该点，这条会永久变红（实测 10-20 12:00
  // 北京起 CI 连续全红，step「验证数据链路回归」失败，后续同步步骤全被 skip）。
  assert.deepEqual(config.kindsFor(match(), now), ['pre15', 'result'])
})

/* ------------------------------------------------------------------ 真实模板
 * 下面两条断言按**用户在小程序后台截图的字段**逐字写死（见
 * tools/match-notification-known-templates.js）。改模板映射必须让这两条仍通过。
 * ------------------------------------------------------------------------ */

test('生产模板「比赛开始提醒」(6637)：五个字段各就各位，thing6 排在 thing4 之前也不串位', () => {
  const m = match({
    comp: 'epl', compName: '英超', compCat: 'football',
    stage: '英超', bo: null, statusText: '',
    home: { id: '359', zh: '阿森纳', abbr: 'ARS', name: 'Arsenal', score: 0 },
    away: { id: '382', zh: '曼城', abbr: 'MCI', name: 'Manchester City', score: 0 },
  })
  const data = core.templateData(m, known.kickoff.content, 'pre60')
  assert.deepEqual(Object.keys(data).sort(), ['thing1', 'thing2', 'thing3', 'thing4', 'thing6'])
  assert.equal(data.thing1.value, '英超')            // 比赛名称 ← 赛事名（曾被「比赛」二字错配成对阵）
  assert.equal(data.thing2.value, '2026年10月20日 12:00')
  assert.equal(data.thing3.value, '足球')            // 赛事类别（原来完全兜不出来）
  assert.equal(data.thing6.value, '阿森纳 vs 曼城')   // 比赛对阵（原来被填成赛段）
  assert.equal(data.thing4.value, '单场')            // 赛制（原来兜到 teams）
})

test('生产模板「完赛通知」(72357)：五个字段各就各位', () => {
  const m = match({
    comp: 'nba', compName: 'NBA', compCat: 'basketball',
    status: 'finished', start: '2026-10-20T02:00:00Z',
    stage: 'NBA · 季前赛', bo: null, statusText: '已结束',
    home: { id: '13', zh: '洛杉矶湖人', abbr: 'LAL', name: 'Los Angeles Lakers', score: 112 },
    away: { id: '9', zh: '金州勇士', abbr: 'GSW', name: 'Golden State Warriors', score: 108 },
  })
  const data = core.templateData(m, known.result.content, 'result')
  assert.deepEqual(Object.keys(data).sort(), ['character_string6', 'thing1', 'thing11', 'thing9', 'time10'])
  assert.equal(data.thing1.value, 'NBA')                      // 赛事名称
  assert.equal(data.time10.value, '2026年10月20日 10:00')      // 比赛日期（time 类型）
  assert.equal(data.thing9.value, '湖人 vs 勇士')     // 参赛人员
  assert.equal(data.character_string6.value, '112:108')
  assert.equal(data.thing11.value, 'NBA · 季前赛')             // 备注 ← 赛段
})

test('云端行只有 zh 字段：必须取到中文队名，不允许回落英文', () => {
  const values = core.matchValues({
    comp: 'epl', compName: '英超', compCat: 'football', start: '2026-10-20T04:00:00Z',
    home: { zh: '阿森纳', abbr: 'ARS', name: 'Arsenal' },
    away: { zh: '曼城', abbr: 'MCI', name: 'Manchester City' },
  })
  assert.equal(values.teams, '阿森纳 vs 曼城')
  // 只要队名本身没变成英文即可（连接词 vs 本来就是拉丁字母）
  assert.equal(/Arsenal|Manchester|City/.test(values.teams), false)
  assert.equal(values.category, '足球')
  // 只有真的没有中文时（如 LPL 的 KC / C9）才允许出现拉丁字母 —— 与 utils/view.js 的显示口径一致
  const latin = core.matchValues({
    comp: 'worlds', compName: '全球总决赛', compCat: 'esports',
    home: { zh: '', name: 'KC' }, away: { zh: '', name: 'C9' },
  })
  assert.equal(latin.teams, 'KC vs C9')
})

test('长英文队名触及 thing(20) / character_string(32) 上限时退成官方缩写，而不是硬截断', () => {
  const m = {
    comp: 'nba', compName: 'NBA', compCat: 'basketball', status: 'finished',
    start: '2026-10-20T02:00:00Z', stage: 'NBA · 常规赛', statusText: '已结束',
    home: { abbr: 'POR', name: 'Example Very Long Home Club Name', score: 110 },
    away: { abbr: 'SAC', name: 'Example Very Long Away Club Name', score: 99 },
  }
  const values = core.matchValues(m)
  assert.equal(values.teams, 'POR vs SAC')
  assert.equal(values.score, 'POR 110:99 SAC')
  const data = core.templateData(m, '参赛人员：{{thing9.DATA}}\n完赛结果：{{character_string6.DATA}}', 'result')
  assert.equal(data.thing9.value, 'POR vs SAC')
  assert.equal(data.character_string6.value, '110:99')
})

test('模板标签解析：有冒号走严格解析，没有冒号时退回「标签紧跟字段」也能认出来', () => {
  const strict = core.parseTemplateFields('比赛名称：{{thing1.DATA}}\n比赛时间:{{thing2.DATA}}')
  assert.deepEqual(strict.fields.map((f) => [f.key, f.label]), [['thing1', '比赛名称'], ['thing2', '比赛时间']])
  const loose = core.parseTemplateFields('比赛名称{{thing1.DATA}}\n比赛时间{{thing2.DATA}}')
  assert.deepEqual(loose.fields.map((f) => [f.key, f.label]), [['thing1', '比赛名称'], ['thing2', '比赛时间']])
  // 两个模板的字段个数必须与后台一致，少一个都会整条发不出去
  assert.equal(core.parseTemplateFields(known.kickoff.content).keys.length, 5)
  assert.equal(core.parseTemplateFields(known.result.content).keys.length, 5)
})
