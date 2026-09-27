/**
 * 云服务客户端（全应用唯一实例）
 *
 * 依赖 `@tencent-ai/workbuddy-cloud-sdk` 的 miniprogram 子路径。
 * 若还没有在微信开发者工具里执行「构建 npm」，SDK 会加载失败 —— 这里捕获该异常，
 * 由页面给出明确提示，而不是让整个小程序崩掉。
 */

const publicConfig = require('./cloud-config')

let cloud = null
let initError = null

try {
  const { createMiniProgramWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk/miniprogram')
  const { createDiagnosticWx } = require('./workbuddy-cloud-diagnostics')
  cloud = createMiniProgramWorkBuddyCloud({
    endpoint: publicConfig.endpoint,
    publishableKey: publicConfig.publishableKey,
    wx: createDiagnosticWx(wx),
  })
} catch (err) {
  initError = err
  console.error('[赛程助手] 云服务 SDK 初始化失败，请在开发者工具中执行「构建 npm」', err)
}

/** 云服务是否可用 */
function isReady() {
  return !!cloud
}

/** 微信登录 */
async function signInWithWechat() {
  if (!cloud) return { data: null, error: { message: cloudUnavailableMessage(), kind: 'sdk-missing' } }
  return new Promise((resolve) => {
    wx.login({
      async success({ code }) {
        try {
          const appid = wx.getAccountInfoSync().miniProgram.appId
          const result = await cloud.auth.signInWithWechat(code, appid)
          resolve(result)
        } catch (error) {
          console.error('[WorkBuddy Cloud] login failed', JSON.stringify({
            stage: 'wechat-login-handler',
            message: error instanceof Error ? error.message : '微信登录失败，请重试',
          }))
          resolve({ data: null, error: { message: '微信登录失败，请重试', kind: 'handler' } })
        }
      },
      fail(error) {
        console.error('[WorkBuddy Cloud] login failed', JSON.stringify({
          stage: 'wx.login',
          message: error.errMsg,
        }))
        resolve({ data: null, error: { message: error.errMsg || '获取微信登录凭证失败', kind: 'wx-login' } })
      },
    })
  })
}

async function getSession() {
  if (!cloud) return { data: null, error: { message: cloudUnavailableMessage(), kind: 'sdk-missing' } }
  return cloud.auth.getSession()
}

async function signOut() {
  if (!cloud) return { error: { message: cloudUnavailableMessage(), kind: 'sdk-missing' } }
  return cloud.auth.signOut()
}

function cloudUnavailableMessage() {
  return '云服务未就绪，请在微信开发者工具中执行「构建 npm」后重新预览'
}

module.exports = {
  cloud,
  initError,
  isReady,
  signInWithWechat,
  getSession,
  signOut,
  unavailableMessage: cloudUnavailableMessage,
}
