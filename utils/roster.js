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

/** 位置缩写 → 中文（ESPN 给 G/D/M/F 四档） */
const POS_ZH = { G: '门将', D: '后卫', M: '中场', F: '前锋' }

/** 分组排列顺序 */
const POS_ORDER = { G: 0, D: 1, M: 2, F: 3 }

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

module.exports = { POS_ZH, POS_ORDER, groupByPos }
