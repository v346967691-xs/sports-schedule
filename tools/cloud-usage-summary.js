const fs = require('node:fs')
const path = require('node:path')

function summarize(records) {
  const operations = {}, windows = new Set()
  for (const record of records) {
    for (const window of record.databaseRequestWindows || []) windows.add(window)
    for (const [name, row] of Object.entries(record.operations || {})) {
      const target = operations[name] ||= { calls: 0, failures: 0, requestBodyBytes: 0, responseBodyBytes: 0, unreadResponses: 0, durationMs: 0 }
      for (const key of Object.keys(target)) target[key] += row[key] || 0
    }
  }
  return { processes: records.length, observedFiveMinuteWindows: windows.size, operations }
}
if (require.main === module) {
  const dir = process.env.CLOUD_USAGE_DIR
  const records = dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : []
  const result = summarize(records)
  console.log(JSON.stringify(result, null, 2))
  const lines = ['## 云请求诊断（不是计费账单）', '', `记录 ${result.processes} 个进程，数据库请求涉及 ${result.observedFiveMinuteWindows} 个不同的 5 分钟窗口。`, '',
    '| 操作 | 请求数 | 失败数 | 请求正文 bytes | 已读取响应 bytes | 未读取响应数 | HTTP 耗时 ms |', '|---|---:|---:|---:|---:|---:|---:|']
  for (const [name, row] of Object.entries(result.operations)) lines.push(`| ${name} | ${row.calls} | ${row.failures} | ${row.requestBodyBytes} | ${row.responseBodyBytes} | ${row.unreadResponses} | ${row.durationMs} |`)
  lines.push('', '仅覆盖本班 Node 进程发往应用数据库的 fetch 请求；不含小程序用户访问、服务器内部 SQL、真实 CPU、存储、协议开销。响应是解压后的正文量，不能视为计费流量。窗口已跨进程去重，但不是平台计费窗口或费用。')
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n')
}
module.exports = { summarize }
