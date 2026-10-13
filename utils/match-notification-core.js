const BEIJING_OFFSET = 8 * 60 * 60 * 1000

/** 平台大类 → 中文。键与 utils/data.js 的 `catOf()` 三个取值一一对应 */
const CATEGORY_ZH = { football: '足球', basketball: '篮球', esports: '电竞' }

function isDue(match, now = Date.now(), kind = 'pre15', options = {}) {
  if (!match || !match.comp) return false
  if (kind === 'result') {
    const hasScore = (side) => side && side.score !== null && side.score !== undefined
      && String(side.score).trim() !== '' && Number.isFinite(Number(side.score))
    return match.status === 'finished' && hasScore(match.home) && hasScore(match.away)
  }
  if (!['pre60', 'pre15'].includes(kind) || !['upcoming', 'live'].includes(match.status)) return false
  if (match.status === 'live' && kind !== 'pre15') return false
  const start = Date.parse(match.start)
  if (!Number.isFinite(start)) return false
  const lead = kind === 'pre60' ? 60 * 60 * 1000 : 15 * 60 * 1000
  const latest = kind === 'pre60' ? start - 15 * 60 * 1000 : start + (options.afterMs || 10 * 60 * 1000)
  return now >= start - lead && now <= latest
}

function truncate(value, max) {
  return Array.from(String(value || '')).slice(0, max).join('')
}

function beijingDateTime(value) {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return ''
  const date = new Date(time + BEIJING_OFFSET).toISOString()
  return `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日 ${date.slice(11, 16)}`
}

/* --------------------------------------------------------------------------
 * 队名取值口径
 *
 * 🔴 **必须与 utils/view.js 的 `withZh()` / utils/data.js 的显示口径一致：
 *    `zh || name || abbr`。**
 *
 *    云端 `schedule_cache` 里存的是**原始**比赛对象，队名只有 `zh`
 *    （`zhName` 是页面层的 `utils/view.js:withZh()` 才补上的字段，库里不存在）。
 *    推送进程直接读 `row.match_data`，所以少读一个 `zh` 就会让通知里
 *    出现英文队名（实测 `Liverpool` / `Ipswich Town`）—— 违反中文红线。
 * ------------------------------------------------------------------------ */
function sideName(side) {
  const team = side || {}
  return String(team.zh || team.zhName || team.name || team.abbr || '').trim()
}

function sideAbbr(side) {
  const team = side || {}
  return String(team.abbr || team.zh || team.zhName || team.name || '').trim()
}

/** 「主 vs 客」；整体超过 limit 个字符时退成官方缩写（POR vs SAC），不靠截断硬切 */
function versus(match, limit, nameOf) {
  const home = nameOf(match && match.home) || '待定'
  const away = nameOf(match && match.away) || '待定'
  const full = `${home} vs ${away}`
  if (Array.from(full).length <= limit) return full
  const short = `${sideAbbr(match && match.home) || home} vs ${sideAbbr(match && match.away) || away}`
  return short || full
}

/** 「主 1:2 客」；超过 limit 个字符时同样退成缩写 */
function versusScore(match, limit) {
  const hs = Number(match && match.home && match.home.score)
  const as = Number(match && match.away && match.away.score)
  const long = `${sideName(match.home)} ${hs}:${as} ${sideName(match.away)}`
  if (Array.from(long).length <= limit) return long
  return `${sideAbbr(match.home)} ${hs}:${as} ${sideAbbr(match.away)}`
}

function matchValues(match) {
  const m = match || {}
  const hasScore = (side) => side && side.score !== null && side.score !== undefined
    && String(side.score).trim() !== '' && Number.isFinite(Number(side.score))
  const complete = hasScore(m.home) && hasScore(m.away)
  const hs = Number(m.home && m.home.score)
  const as = Number(m.away && m.away.score)

  const competition = String(m.compName || m.compShort || m.stage || m.comp || '').trim() || '比赛'
  const stage = String(m.stage || '').trim()
  const statusText = String(m.statusText || '').trim()
  const bo = String(m.bo == null ? '' : m.bo).trim()

  return {
    teams: versus(m, 20, sideName),
    competition,
    category: CATEGORY_ZH[m.compCat || m.cat] || '',
    stage: stage || competition,
    // 赛制：电竞上游给了 bo（"5" → BO5）；足球/篮球都是单场决胜，用「单场」。
    // ⚠️ 这两个字是**按运动项目的常识推的**，不是上游字段 —— 若要改，改这一处。
    format: /^\d+$/.test(bo) ? `BO${bo}` : '单场',
    kickoff: beijingDateTime(m.start),
    score: complete ? versusScore(m, 32) : '赛果待更新',
    scoreCompact: complete ? `${hs}:${as}` : '',
    winner: complete ? (hs === as ? '平局' : hs > as ? sideName(m.home) : sideName(m.away)) : '待定',
    remark: stage && stage !== competition ? stage : (statusText || competition),
  }
}

/* --------------------------------------------------------------------------
 * 订阅消息字段适配
 *
 * 🔴 字段的「类型」由 key 前缀决定（thing1 / number2 / phrase3 …），微信对每种类型
 *    都有**强校验**，值不合规会直接以 errcode 47003 拒发整条消息。规则出处：
 *    微信官方《发送订阅消息 - 订阅消息参数值内容限制说明》
 *
 *      thing            20 字符以内，可汉字/数字/字母/符号组合
 *      number           32 位以内数字，只能数字，可带小数
 *      letter           32 位以内字母，只能字母
 *      symbol           5 位以内符号，只能符号
 *      character_string 32 位以内数字、字母或符号
 *      time             24 小时制，**支持 + 年月日**（15:01 或 2019年10月1日 15:01）
 *      date             年月日，**支持 + 24 小时制时间**
 *      amount           1 个币种符号 + 10 位以内纯数字，可带小数，结尾可带「元」
 *      name             10 个以内纯汉字 或 20 个以内纯字母/符号
 *      phrase           5 个以内**纯汉字**
 *      phone_number     17 位以内；car_number 8 位以内
 *
 * 🔴 两条硬约定（本项目）：
 *    1) **产出不合规的值 → 抛错**，绝不把非法值发出去（微信会整条拒收，
 *       且客户端拿不到可读原因）。抛出的错误会写进 last_error，便于排查。
 *    2) **模板里出现的每个 {{key.DATA}} 都必须被填值** —— 用宽松正则先取全集，
 *       再逐个生成，任何一个补不上都抛错。只填「解析出标签的那几个」是不够的。
 *
 * 🔴 **两个生产模板的真实字段（2026-10-13 由用户在小程序后台截图确认）：**
 *
 *    kickoff（「比赛开始提醒」，模板编号 6637）—— 五个字段**全是 thing**：
 *      比赛名称 {{thing1.DATA}}   比赛时间 {{thing2.DATA}}   赛事类别 {{thing3.DATA}}
 *      比赛对阵 {{thing6.DATA}}   赛制     {{thing4.DATA}}
 *      ⚠️ 编号与展示顺序不一致（6 排在 4 前面），所以**位置兜底必须按 content 顺序**，
 *         而且不能只靠位置 —— 必须靠标签精确映射。
 *
 *    result（「完赛通知」，模板编号 72357）：
 *      赛事名称 {{thing1.DATA}}         比赛日期 {{time10.DATA}}
 *      参赛人员 {{thing9.DATA}}         完赛结果 {{character_string6.DATA}}
 *      备注     {{thing11.DATA}}
 *
 *    ⚠️ 注意 kickoff 里**没有 time 字段**，「比赛时间」是 `thing2` ——
 *       之前误以为是 `time` 类型而准备「支持带年月日」的注释，其实不适用这里；
 *       反过来说，`thing` 有 20 字符上限，「2026年10月20日 12:00」正好 17 字符，安全。
 * ------------------------------------------------------------------------ */

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/
const ALPHA = /[A-Za-z]/
// 符号 = 除中文、英文字母、数字、空白之外的常见符号（微信不允许换行等控制字符）
const SYMBOL = /[^\w\u3400-\u4dbf\u4e00-\u9fff\s]/

/** 按微信类型规则把候选值规整成合法内容；无法规整时返回空串（由调用方抛错） */
function coerceByType(type, value) {
  const text = String(value == null ? '' : value).trim()
  switch (type) {
    case 'thing':
      return truncate(text, 20)
    case 'phrase':
      // 5 个以内「纯汉字」——英文队名等非汉字内容必须滤掉，不能整段塞进去
      return truncate(Array.from(text).filter((char) => HAN.test(char)).join(''), 5)
    case 'letter':
      return truncate(Array.from(text).filter((char) => ALPHA.test(char)).join(''), 32)
    case 'symbol':
      return truncate(Array.from(text).filter((char) => SYMBOL.test(char)).join(''), 5)
    case 'character_string':
      return truncate(text, 32)
    case 'number': {
      const hit = text.match(/-?\d+(?:\.\d+)?/)
      return hit ? truncate(hit[0], 32) : ''
    }
    case 'amount': {
      const hit = text.match(/\d+(?:\.\d+)?/)
      return hit ? `¥${truncate(hit[0], 10)}` : ''
    }
    case 'name': {
      // 含汉字就按「纯汉字 10 个以内」处理，否则按「纯字母 20 个以内」
      if (HAN.test(text)) return truncate(Array.from(text).filter((char) => HAN.test(char)).join(''), 10)
      return truncate(Array.from(text).filter((char) => ALPHA.test(char)).join(''), 20)
    }
    case 'phone_number':
      return truncate(text, 17)
    case 'car_number':
      return truncate(text, 8)
    case 'time':
      // 官方明确支持带年月日（如 2026年10月20日 12:00），无需再截断
      return text
    case 'date': {
      const hit = text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/)
      if (!hit) return text
      return `${hit[1]}-${String(hit[2]).padStart(2, '0')}-${String(hit[3]).padStart(2, '0')}`
    }
    case 'enum':
      // 枚举值无法在本地校验，原样透传
      return text
    default:
      // 未知/未来新增类型：按最宽松的 32 字符处理，避免直接拒发
      return truncate(text, 32)
  }
}

/**
 * 标签 → 取哪个值（**精确表，优先于模糊规则**）。
 *
 * 为什么必须有这张表：模糊规则里 `/(对阵|队伍|战队|比赛)/` 会先吃掉「比赛名称」，
 * 而「赛事类别」「赛制」「参赛人员」「备注」四个标签**一条规则都命中不了**，
 * 只能靠位置兜底 —— 于是「比赛对阵」被填成赛段（`NBA · 季前赛`），
 * 这是明显错误的中文，宁可重写也不能上线。
 */
const LABEL_MAP = {
  比赛名称: 'competition',
  赛事名称: 'competition',
  联赛名称: 'competition',
  杯赛名称: 'competition',
  比赛时间: 'kickoff',
  开赛时间: 'kickoff',
  比赛日期: 'kickoff',
  赛事类别: 'category',
  赛事类型: 'category',
  比赛类型: 'category',
  比赛对阵: 'teams',
  对阵双方: 'teams',
  对阵: 'teams',
  参赛队伍: 'teams',
  参赛人员: 'teams',
  对战双方: 'teams',
  完赛结果: 'score',
  比赛结果: 'score',
  最终比分: 'score',
  赛制: 'format',
  轮次: 'stage',
  赛段: 'stage',
  阶段: 'stage',
  备注: 'remark',
  说明: 'remark',
  胜方: 'winner',
  获胜方: 'winner',
}

/** 标签的模糊兜底规则（精确表没命中时用）。顺序有意义：「结果」必须排在「比赛」之前 */
const LABEL_RULES = [
  [/(胜方|获胜|赢家|冠军)/, (values) => values.winner],
  [/(比分|赛果|结果)/, (values) => values.score],
  [/(赛制|赛程制度|bo[0-9]?)/i, (values) => values.format],
  [/(时间|日期|开赛|开始)/, (values) => values.kickoff],
  [/(类别|类型|项目)/, (values) => values.category],
  [/(赛事|联赛|杯赛|大会)/, (values) => values.competition],
  [/(阶段|轮次|赛段|备\s*注|说明)/, (values) => values.stage],
  [/(对阵|队伍|战队|人员|比赛)/, (values) => values.teams],
]

/** 标签认不出时的位置兜底：按两个真实模板的 content 顺序排列 */
const POSITION_FALLBACK = {
  result: ['competition', 'kickoff', 'teams', 'score', 'remark'],
  kickoff: ['competition', 'kickoff', 'category', 'teams', 'format'],
}

/**
 * 解析模板 content，列出它声明的**全部**字段。
 *
 * 1) 「宽松」取全集：任何 `{{key.DATA}}` 都算，保证不漏字段（漏一个就整条发不出去）。
 * 2) 「严格」取标签：`标签 + 冒号 + 字段`。
 * 3) 「无冒号」兜底：只有当严格一条都没解析出来时才启用 —— 我们没有 AppSecret，
 *    无法调 gettemplate 复核 content 的确切分隔符，多这一层是为了不把生杀大权
 *    全押在「冒号一定存在」上。标签限长 8 个字符且不跨行，避免把正文吞进标签。
 *
 * @returns {{keys:string[], labelByKey:Object, fields:Array<{key:string,type:string,label:string}>}}
 */
function parseTemplateFields(content) {
  const text = String(content || '')
  const keys = []
  for (const hit of text.matchAll(/\{\{\s*([A-Za-z_]+\d*)\s*\.DATA\s*\}\}/g)) {
    if (!keys.includes(hit[1])) keys.push(hit[1])
  }
  const labelByKey = {}
  const collect = (pattern) => {
    let hit
    while ((hit = pattern.exec(text))) {
      if (!(hit[2] in labelByKey)) labelByKey[hit[2]] = hit[1].trim()
    }
  }
  collect(/([^{}\n\r:：]{1,8}?)\s*[:：]\s*\{\{\s*([A-Za-z_]+\d*)\s*\.DATA\s*\}\}/g)
  if (!Object.keys(labelByKey).length) {
    collect(/([^{}\n\r:：]{1,8}?)\s*\{\{\s*([A-Za-z_]+\d*)\s*\.DATA\s*\}\}/g)
  }
  const fields = keys.map((key) => ({
    key,
    type: key.replace(/\d+$/, '').toLowerCase(),
    label: labelByKey[key] || '',
  }))
  return { keys, labelByKey, fields }
}

function templateData(match, content, kind = 'pre15', options = {}) {
  const values = matchValues(match)
  if (kind === 'result' && options.remark) values.remark = options.remark
  // pre60 / pre15 共用 kickoff 模板，位置兜底也共用同一张表
  const shape = kind === 'result' ? 'result' : 'kickoff'
  const fallbacks = POSITION_FALLBACK[shape].map((key) => values[key])

  const { keys, labelByKey } = parseTemplateFields(content)
  if (!keys.length) return {}

  const result = {}
  keys.forEach((key, index) => {
    const type = key.replace(/\d+$/, '').toLowerCase()
    const label = labelByKey[key] || ''
    const exact = LABEL_MAP[label.replace(/\s+/g, '')]
    const rule = exact ? null : LABEL_RULES.find(([pattern]) => pattern.test(label))
    // 候选值优先级：精确标签 → 模糊规则 → 位置兜底 → 对阵（永不为空）
    let candidate = (exact && values[exact])
      || (rule && rule[1](values))
      || fallbacks[index]
      || values.teams
    // character_string 仅使用数字比分；中文队名已完整放在旁边的参赛人员 thing 字段。
    if (type === 'character_string' && candidate === values.score) candidate = values.scoreCompact
    const value = coerceByType(type, candidate)
    if (!value) {
      throw new Error(`订阅模板字段 ${key}（${type}）无法生成合规内容${label ? `：${label}` : ''}`)
    }
    result[key] = { value }
  })
  return result
}

module.exports = {
  isDue, templateData, beijingDateTime, coerceByType, matchValues, parseTemplateFields, CATEGORY_ZH,
}
