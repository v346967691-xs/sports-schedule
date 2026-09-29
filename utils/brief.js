/**
 * 日报数据源
 *
 * 从云表 daily_brief 读取由 GitHub Actions 生成的日报（早报 06:00 / 晚报 21:00 双轨）。
 * 每天 2 期，纯文本内容，单期约 3KB，一次拉最近 10 期也就 30KB。
 *
 * ⚠️ 当前不读图片：分享图方案未定（程序化图案达不到要求，外部图像 API 待定），
 *    所以页面只渲染文字。等方案定了，image.prompt / image.poster 字段已经在数据里了，
 *    不用改数据层，只要页面加一个 <image> 或 canvas 即可。
 *
 * 失败一律返回空列表 + reason，绝不抛错 —— 日报是附加功能，
 * 不能因为它挂了就影响用户看比分。
 */

const cloudClient = require('./cloud')

/**
 * ⚠️ 云 SDK 返回的是数据库原始列名（snake_case），不会自动转驼峰。
 * 参考 utils/favorites.js 里的 row.match_id、utils/team-follows.js 里的 row.team_id。
 * 所以这里是 pub_at 而不是 pubAt —— 写错的话整份日报都拿不到出报时间。
 */
const TABLE = 'daily_brief'
const THROTTLE_MS = 5 * 60 * 1000

// 服务端多取几行再本地过滤：未来的期次按 pub_at 排在最前面，
// 只取 n 行的话它们会把已出报的历史期次挤出结果集，导致列表变短。
// 一天最多 2 期（早报 + 晚报），留 4 行的余量足够。
const FUTURE_BUFFER = 4

let lastFetchAt = 0
let inflight = null
let cache = []

function isReady() { return !!(cloudClient && cloudClient.isReady && cloudClient.isReady()) }

function kindZh(kind) { return kind === 'evening' ? '晚报' : '早报' }

/**
 * 这期到出报时刻了吗？
 *
 * 背景（2026-09-29 实测）：生成脚本每 15 分钟就把最近两天的期次重算一遍，
 * 于是「当天 21:00 的晚报」在下午三四点就已经躺在云表里了 —— 内容是按那一刻的
 * 快照算的，窗口里的比赛还没打完，甚至整张列表都可能是残的。按 pub_at 倒序取，
 * 这条未来期次稳居第一，用户下午就看到「9月29日 晚报」，看起来像穿帮。
 *
 * 所以这里做兜底：出报时刻还没到的期次一律不进列表。生成端 tools/brief-push.js
 * 也用同一条规则跳过未到期次（那边的同名实现在 tools/brief-window.js 的 isDue，
 * 小程序打不到 tools/，两份必须同步改）。
 *
 * ⚠️ 解析不出出报时刻时返回 true（照旧展示）：这种行本来就没有时间信息、
 * 无从判断早晚，一律隐藏会导致整页空白，反而更难排查。正常数据 pub_at 必然存在。
 *
 * @param {string} pubAt ISO 出报时刻
 * @param {number} [now] 参照时刻（毫秒），不传取当前时间；测试可注入
 */
function isDue(pubAt, now) {
  const t = Date.parse(pubAt || '')
  if (!Number.isFinite(t)) return true
  return t <= (now === undefined || now === null ? Date.now() : now)
}

/**
 * 过滤出「已出报」的期次（按 pub_at 倒序，保持入参顺序）
 * @param {Array} list normalize 之后的列表
 * @param {number} [n] 只取前 n 条，不传则全部
 * @param {number} [now] 参照时刻
 */
function onlyDue(list, n, now) {
  const out = (list || []).filter((o) => isDue(o && o.pubAt, now))
  return n ? out.slice(0, n) : out
}

/**
 * 取最近 limit 期日报，按出报时刻倒序（最新在前）
 * @returns {Promise<{list:Array, reason?:string, fromCache:boolean}>}
 */
async function fetchBriefs(limit) {
  const n = limit || 10
  if (!isReady()) return { list: onlyDue(cache, n), reason: 'no-cloud', fromCache: true }
  if (inflight) return inflight
  const now = Date.now()
  if (cache.length && now - lastFetchAt < THROTTLE_MS) {
    return { list: onlyDue(cache, n, now), fromCache: true }
  }
  lastFetchAt = now
  inflight = doFetch(n).finally(() => { inflight = null })
  return inflight
}

async function doFetch(n) {
  try {
    const { data, error } = await cloudClient.cloud.database
      .from(TABLE)
      .select('id, kind, date, pub_at, mode, payload, generated_at')
      .order('pub_at', { ascending: false })
      .limit(n + FUTURE_BUFFER)
    if (error || !Array.isArray(data)) {
      return { list: onlyDue(cache, n), reason: 'error', fromCache: true }
    }
    // ⚠️ cache 里保留未到期次（下次还能用，时间到了自然出现），只在对外返回时过滤
    cache = data
      .map((r) => normalize(r))
      .filter(Boolean)
      .sort((a, b) => Date.parse(b.pubAt) - Date.parse(a.pubAt))
    return { list: onlyDue(cache, n), fromCache: false }
  } catch (err) {
    console.warn('[赛程助手] 日报读取失败', err)
    return { list: onlyDue(cache, n), reason: 'error', fromCache: true }
  }
}

// 云表行 → 页面可直接绑定的结构
function normalize(row) {
  const p = row.payload
  if (!p || typeof p !== 'object') return null
  const o = {
    id: row.id,
    kind: row.kind,
    kindZh: kindZh(row.kind),
    date: row.date,
    pubAt: row.pub_at || row.pubAt || '',
    windowLabel: p.windowLabel || '',
    mode: p.mode,
    aigc: p.aigc || null,
  }
  if (p.mode === 'report' && p.headline) {
    o.headline = p.headline
    o.briefs = p.briefs || []
  } else if (p.mode === 'preview' && p.preview) {
    o.preview = p.preview
  } else {
    o.note = p.note || ''
  }
  return o
}

/**
 * 入口条用的一句话摘要（首页 / 我的页共用）。
 * 战报期用头条标题；前瞻期不念 intro（太啰嗦），直接给最值得留意的那场对阵。
 */
function teaser(one) {
  if (!one) return ''
  if (one.mode === 'report' && one.headline) return one.headline.title || ''
  if (one.mode === 'preview' && one.preview && one.preview.items && one.preview.items.length) {
    const it = one.preview.items[0]
    const n = one.preview.items.length
    return '值得留意：' + it.home + ' vs ' + it.away + (n > 1 ? ` 等 ${n} 场` : '')
  }
  return ''
}

function p2(n) { return String(n).padStart(2, '0') }

/**
 * 把 ISO 时间显示成「9月29日 06:00」（北京时间）。
 *
 * ⚠️ 不能直接用字符串切片：PostgREST 返回 timestamptz 时通常按数据库时区输出
 * （很可能是 +00:00），直接取前面几位会把 06:00 的早报显示成 22:00 的昨晚。
 * 这里按「时刻」解析再整体平移到东八区，无论服务端用哪个时区输出都正确。
 */
function fmtPubAt(iso) {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return String(iso)
  const d = new Date(t + 8 * 3600000)
  return (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日 ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes())
}

// normalize 一并导出：冒烟测试要用它把「云表原始行」跑一遍真实的字段映射，
// 这样 pub_at / payload 这类列名改动能在本地就被测出来，而不是等真机上才空白。
module.exports = { fetchBriefs, fmtPubAt, kindZh, normalize, teaser, isDue, onlyDue, TABLE }
