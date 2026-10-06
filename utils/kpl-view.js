/**
 * KPL 单局战报的**共享**渲染口径
 * ============================================================
 * `pages/detail/detail.js`（渲染）与 `tools/smoke.js`（守卫）共用一份 ——
 * 排序、对位、局分累计这些逻辑放页面里没法测，抽出来 smoke 就能拿真实 payload 直接跑。
 *
 * 输入是 `tools/match-detail.js` 的 pickKplDetail 存进 payload 的形状：
 *   `{list:[{n,w,s}], picks:[[10×{i,h}]], people:{id:{n,r,av,q,t}}, heroes:{hid:名}}`
 *
 * ⚠️ 英雄图标 / 选手头像的 URL **不在 payload 里**（省体积），这里按 id / 完整地址拼。
 *    英雄图标拼在王者官方 CDN（`game.gtimg.cn`），选手头像存的就是完整 URL。
 * ⚠️ `list[].s` 是胜方在哪一边（h/a），空串表示上游没给（不猜，也不加分）。
 * ⚠️ 位置 `q` 走 utils/roster.js 的 KPL_POS（1=对抗路 2=中路 3=发育路 4=打野 5=游走）。
 */
const { KPL_POS, kplHeroIcon } = require('./roster')

/**
 * 整理成「局 tab + 对位卡」结构。
 *
 * 视觉形态对齐 KPL 官方 App 的「数据」页（10-06 用户给的参考图）：
 *   顶部横滑的「第 N 局」tab，一次只看一局；局内左右两队按位置对位。
 *   🔴 不能像第一版那样把三局十名选手整列铺下来 —— 那是一竖排 30 行，没法看。
 *
 * 🔴 上游给不了的东西不要硬造：没有击杀 / 经济 / Ban 位，所以局条上不放比分数字，
 *    放的是**打完这局后的累计局分**（从逐局胜方推出来，每局 1 分，信息真实且直观）。
 *
 * @returns {{homeLabel, awayLabel, rounds:[{idx,n,w,s,hs,as,rows:[{l,r,pos}]}], active}|null}
 *          active 默认最后一局 —— 用户点开已结束的比赛，最想看的是决胜那局。
 */
function buildKpl(d, homeLabel, awayLabel) {
  if (!d || !d.kpl || !d.kpl.list || !d.kpl.list.length) return null
  const people = d.kpl.people || {}
  const heroes = d.kpl.heroes || {}
  // 一侧的出场名单：按位置升序，缺名的过滤（有人被 ban 但没上场，上游也给空）
  const roster = (picks) => (side) => (picks || [])
    .map((p) => {
      const per = people[p.i] || {}
      if (per.t !== side) return null
      return {
        hero: heroes[p.h] || '',
        icon: kplHeroIcon(p.h),
        n: per.n || '',
        real: per.r || '',
        pos: KPL_POS[per.q] || '',
      }
    })
    .filter(Boolean)
    .filter((x) => x.hero || x.n)
    .sort((a, b) => (a.q || 9) - (b.q || 9))

  let hs = 0
  let as = 0
  const rounds = (d.kpl.list || []).map((r, i) => {
    if (r.s === 'h') hs += 1
    else if (r.s === 'a') as += 1
    const picks = (d.kpl.picks || [])[i] || []
    const sideOf = roster(picks)
    const home = sideOf('h')
    const away = sideOf('a')
    if (!home.length && !away.length) return null
    // 对位行在这里配好对（而不是 WXML 里用下标硬对）—— 两队人数可能不齐（有人没上场），
    // 缺的一侧置 null，页面按空渲染，绝不错位。
    const rows = []
    const len = Math.max(home.length, away.length)
    for (let k = 0; k < len; k += 1) {
      const l = home[k] || null
      const rt = away[k] || null
      rows.push({ l, r: rt, pos: ((l || rt) || {}).pos || '' })
    }
    return { idx: i, n: r.n || i + 1, w: r.w || '', s: r.s || '', hs, as, rows }
  }).filter(Boolean)
  if (!rounds.length) return null
  return {
    homeLabel: homeLabel || '主队',
    awayLabel: awayLabel || '客队',
    rounds,
    active: rounds.length - 1,
  }
}

module.exports = { buildKpl }
