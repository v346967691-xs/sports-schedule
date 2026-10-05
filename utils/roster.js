/**
 * 球队名单的**共享**解析口径
 * ============================================================
 * `tools/team-roster.js`（构建期抓数据）与 `pages/team/team.js`（渲染）都要用同一套
 * 位置分组规则 —— 两边各写一份的话，改了一边名单顺序就会悄悄跑偏。
 * 所以这里放唯一一份，两边都 require。
 *
 * ⚠️ 这是 `utils/`，会进代码包 —— 但只有两张小表 + 一个纯函数（约 700 字节），
 *    远比「两边顺序不一致」这种隐性 bug 便宜。
 */

/**
 * 位置缩写 → 中文
 * 足球四档（ESPN 给 G/D/M/F）；篮球三档用 **BG/BF/BC**。
 * 🔴 为什么篮球不直接复用 G/F：足球的 `G` 是**门将**、篮球的 `G` 是**后卫**，
 *    同一个字母两种意思，混在一张表里必然打架 —— 所以篮球另起一组缩写。
 */
const POS_ZH = { G: '门将', D: '后卫', M: '中场', F: '前锋', BG: '后卫', BF: '前锋', BC: '中锋' }

/**
 * 分组排列顺序：足球 门将→后卫→中场→前锋，篮球 后卫→前锋→中锋。
 * 两组编号不重叠，同一份名单里不可能混（一支队只属于一个项目）。
 */
const POS_ORDER = { G: 0, D: 1, M: 2, F: 3, BG: 4, BF: 5, BC: 6 }

/**
 * 篮球位置缩写 → 名单用的分组缩写。
 * ESPN 给 `position.abbreviation`，值是 `G` / `F` / `C`，也有复合的 `G-F` / `F-C`
 * （取第一个字母）。取不到就回落空串（页面归到「其他」）。
 */
const BASKET_POS = { G: 'BG', F: 'BF', C: 'BC' }
function basketPos(raw) {
  const s = String((raw && raw.abbreviation) || raw || '').trim().toUpperCase()
  return BASKET_POS[s.charAt(0)] || ''
}

/**
 * KPL 上游的 `position` 是 **1~5 的数字**，语义与常见直觉不同（2 不是打野）。
 * 🔴 映射关系是**实测**核对出来的（2026-10-05，用英雄反推：
 *    pos1=夏洛特/达摩、pos2=海月/女娲、pos3=百里守约/敖隐、pos4=赵云/裴擒虎、pos5=张飞/苏烈），
 *    不是猜的 —— 上游没有给出文字说明，改这里之前先重新核对一局真实数据。
 * 🔴 与足球/篮球的两套缩写（G/D/M/F 与 BG/BF/BC）**互不复用** —— 数字键不可能撞，但别图省事合表。
 */
const KPL_POS = { 1: '对抗路', 2: '中路', 3: '发育路', 4: '打野', 5: '游走' }
/** 英雄图标：KPL 上游只给 `hero_id`，头像拼在王者官方 CDN（实测 200，KPL 自家那个是占位图） */
function kplHeroIcon(heroId) {
  const id = Number(heroId)
  return id ? `https://game.gtimg.cn/images/yxzj/img201606/heroimg/${id}/${id}.jpg` : ''
}


/**
 * 名单按位置分组，返回可直接喂给 WXML 的结构。
 *
 * ⚠️ 展示名优先级：`z`（中文名）→ `s`（英文短名）→ `n`（全名）。
 *    有中文名时把英文短名放到副标题；没有中文名就**别重复**显示同一串英文。
 *    中文名缺失是**预期状态**（球员中文名已停止主动补种），不是 bug。
 */
function groupByPos(players) {
  const groups = []
  const seen = {}
  ;(players || []).forEach((p) => {
    if (!p) return
    const key = p.p || 'X'
    if (!seen[key]) {
      seen[key] = {
        key,
        title: POS_ZH[key] || '其他',
        order: POS_ORDER[key] == null ? 9 : POS_ORDER[key],
        list: [],
      }
      groups.push(seen[key])
    }
    seen[key].list.push({
      pid: p.i,
      jersey: p.j || '',
      name: p.z || p.s || p.n || '',
      enName: p.z ? (p.s || '') : '',
      age: p.ag ? `${p.ag}岁` : '',
      nation: p.cz || p.c || '',
      posZh: p.pn || POS_ZH[key] || '',
    })
  })
  return groups.sort((a, b) => a.order - b.order)
}

module.exports = { POS_ZH, POS_ORDER, groupByPos, basketPos, BASKET_POS, KPL_POS, kplHeroIcon }
