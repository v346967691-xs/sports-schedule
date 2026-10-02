/**
 * tabBar 页面之间的跳转（要带参数）
 *
 * ⚠️ 踩过的坑（2026-10-03 用户报「点查看积分榜没反应」）：
 *    `wx.navigateTo` 跳到 **tabBar 页面**会**静默失败** ——
 *    控制台只留一句 `navigateTo:fail can not navigateTo a tabbar page`，
 *    界面上就是「点了完全没反应」，而且**不报错、不弹 toast**，很难查。
 *    而 `wx.switchTab` 又**不支持 url 带 query**（带了会被忽略）。
 *
 *    所以规矩是：**跳 tabBar 页面一律走这里**，参数借 globalData 传，
 *    目标页在 onShow 里取走并**立刻清空** ——
 *    ⚠️ 不清空的话，这个槽位会被下一个切过来的 tab 的 onShow 误当成新指令。
 *
 * 当前 tabBar（改 tabBar 时记得同步 `tools/smoke.js` 的守卫断言）：
 *   看比赛 /pages/index/index · 赛程 /pages/schedule/schedule
 *   · 积分榜 /pages/rank/rank · 我的 /pages/mine/mine
 */
const { appInstance } = require('./app-instance')

/** 切 tabBar 页面，并把参数塞进 globalData 交接 */
function goTab(path, patch) {
  const app = appInstance()
  if (patch) Object.assign(app.globalData, patch)
  wx.switchTab({ url: path })
}

/** 切到「积分榜」tab 并选中某个赛事 */
function toRank(comp) {
  goTab('/pages/rank/rank', comp ? { pendingComp: String(comp) } : { pendingComp: '' })
}

/** 切到「赛程」tab 并选中某个赛事 */
function toScheduleComp(comp) {
  goTab('/pages/schedule/schedule', comp ? { pendingComp: String(comp) } : null)
}

/** 切到「赛程」tab 并只看某支球队（球队详情页用），同时选中它所在赛事 */
function toScheduleTeam(team) {
  goTab('/pages/schedule/schedule', {
    pendingComp: (team && team.comp) || '',
    pendingTeam: team || null,
  })
}

module.exports = { goTab, toRank, toScheduleComp, toScheduleTeam }
