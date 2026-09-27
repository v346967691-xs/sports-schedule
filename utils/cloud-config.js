/**
 * 云服务公开配置
 *
 * endpoint 与 publishableKey 来自开通云服务时返回的 publicConfig，
 * 是唯一允许写进前端代码的两个值（publishableKey 本身不带任何权限）。
 * 请勿手工修改 endpoint —— 它由后端下发，改动会破坏服务端的来源校验。
 */

module.exports = {
  endpoint: 'https://mp-api.app.workbuddy.host',
  publishableKey: 'wbpk_ggc4JdtBl29lVDPv9QfcyC_nLPCl92RvZtIPNsDvtfXxNd26GWYzOAH',
}
