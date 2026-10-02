/**
 * 临时探针：POST JSON 接口。用法：node tools/probe-post.js <url> '<json body>' [打印长度]
 * 例：node tools/probe-post.js https://kplshop-op.timi-esports.qq.com/kplow/getScheduleList '{"seasonid":""}' 800
 */
const url = process.argv[2]
const body = process.argv[3] || '{}'
const len = Number(process.argv[4] || 600)

;(async () => {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
        Referer: 'https://kpl.qq.com/',
        Origin: 'https://kpl.qq.com',
      },
      body,
    })
    const t = await res.text()
    console.log(`HTTP ${res.status}  ${t.length}B  content-type=${res.headers.get('content-type')}`)
    console.log(t.slice(0, len))
  } catch (e) {
    console.log('失败：' + e.message)
  }
})()
