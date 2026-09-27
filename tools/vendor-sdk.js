/**
 * 把云 SDK 的小程序产物固化进 miniprogram_npm/
 *
 * 为什么不直接依赖开发者工具的「构建 npm」：
 *  - 没跑过「构建 npm」就没有 miniprogram_npm/，此时
 *    require('@tencent-ai/workbuddy-cloud-sdk/miniprogram') 解析不到模块，
 *    轻则登录/收藏功能不可用，重则编译器报错、真机直接白屏；
 *  - 手动跑一次工具很容易忘，换台机器、重新 clone 就又回到原点。
 *
 * 这里把 SDK 自带的 CJS 产物（自包含，0 个外部依赖）原样复制成
 * miniprogram_npm 的目录结构 —— 和「构建 npm」产出的布局完全一致，
 * 但它是仓库里的文件，一定会随包上传。
 *
 * 用法：npm install 之后执行 node tools/vendor-sdk.js
 *       （npm run sync 会自动带上这一步）
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const PKG = '@tencent-ai/workbuddy-cloud-sdk'

const SRC = path.join(ROOT, 'node_modules', PKG, 'lib', 'miniprogram.cjs')
const DEST_DIR = path.join(ROOT, 'miniprogram_npm', PKG)
const DEST = path.join(DEST_DIR, 'miniprogram.js')

function main() {
  if (!fs.existsSync(SRC)) {
    console.log(`  ⚠ 未找到 ${path.relative(ROOT, SRC)}，跳过 SDK 固化（先执行 npm install）`)
    return false
  }

  const version = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', PKG, 'package.json'), 'utf8')).version
    } catch {
      return '0.0.0'
    }
  })()

  // 去掉指向未复制的 .map 的注释，避免开发者工具告警
  const code = fs.readFileSync(SRC, 'utf8').replace(/\n?\/\/# sourceMappingURL=.*$/m, '\n')

  fs.mkdirSync(DEST_DIR, { recursive: true })
  fs.writeFileSync(DEST, code)
  fs.writeFileSync(
    path.join(DEST_DIR, 'package.json'),
    `${JSON.stringify({ name: PKG, version, main: 'miniprogram.js' }, null, 2)}\n`,
  )

  const kb = Math.round(Buffer.byteLength(code) / 1024)
  console.log(`  云 SDK 已固化到 miniprogram_npm/${PKG}/miniprogram.js（${kb} KB，v${version}）`)
  return true
}

if (require.main === module) main()

module.exports = { main }
