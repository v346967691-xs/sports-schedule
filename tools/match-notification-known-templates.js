/**
 * 两个订阅消息模板的**实测字段快照**。
 * ============================================================
 * 来源：2026-10-13 用户在小程序后台「订阅消息」页面截的「基础信息 + 详细内容」两张图。
 * 用途：在没有 AppSecret（调不了 `wxaapi/newtmpl/gettemplate`）时，仍能**离线**
 *       校验字段映射是否把每个字段都填对了 —— 否则「配置对不对」这件事只能靠肉眼。
 *
 * 🔴 这不是权威来源。模板只要在后台被改动（增删字段、换关键词），这里就会过期。
 *    有凭据时一律以 `tools/check-notification-templates.js` 从接口拉到的 content 为准。
 *    本快照只用来兜住「没有凭据也能自查」这一步。
 *
 * ⚠️ content 里的分隔符写法（`：` 还是 `:`、带不带空格）是按后台展示形式复原的，
 *    没有经过接口校验；`parseTemplateFields()` 因此对冒号做了
 *    「严格 → 无冒号」两级解析，两级都不成时才退回按位置取值。
 */
module.exports = {
  kickoff: {
    id: '6DSxxuaVZBvjGQ9-J52kJ6-4r1XG98zDoE7SXCAtAX0',
    number: 6637,
    title: '比赛开始提醒',
    scope: '赛前提醒',
    content: [
      '比赛名称：{{thing1.DATA}}',
      '比赛时间：{{thing2.DATA}}',
      '赛事类别：{{thing3.DATA}}',
      '比赛对阵：{{thing6.DATA}}',
      '赛制：{{thing4.DATA}}',
    ].join('\n'),
  },
  result: {
    id: 'uTwK8vI2uN18Lfj9UzbBM4zRcz_gy8BjZVBHJfqKQSQ',
    number: 72357,
    title: '完赛通知',
    scope: '比赛结果',
    content: [
      '赛事名称：{{thing1.DATA}}',
      '比赛日期：{{time10.DATA}}',
      '参赛人员：{{thing9.DATA}}',
      '完赛结果：{{character_string6.DATA}}',
      '备注：{{thing11.DATA}}',
    ].join('\n'),
  },
}
