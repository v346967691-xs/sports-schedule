/**
 * 临时探针：抓取任意 URL，按可能编码解码后打印前 N 字符，用于评估数据源可用性。
 * 用法：node tools/probe-src.js <url> [编码] [打印长度]
 * 例：  node tools/probe-src.js https://cba.sports.sina.com.cn/api/schedule gb18030 1200
 */
const url = process.argv[2]
const enc = process.argv[3] || 'utf-8'
const len = Number(process.argv[4] || 800)

;(async () => {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        Referer: url,
      },
    })
    const buf = Buffer.from(await res.arrayBuffer())
    let text
    try {
      text = new TextDecoder(enc).decode(buf)
    } catch (e) {
      text = buf.toString('utf8')
    }
    console.log(`HTTP ${res.status}  ${buf.length}B  content-type=${res.headers.get('content-type') || '?'}`)
    console.log(text.slice(0, len))
  } catch (e) {
    console.log(`失败：${e.message}`)
  }
})()
