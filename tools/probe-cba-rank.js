/**
 * 一次性探测脚本（不进包、不参与同步）：CBA 官方排名接口
 *
 *   node tools/probe-cba-rank.js
 *
 * ⚠️ 这是一条**逆向出来的私有接口**，不是公开 API，见下面说明。
 *
 * 怎么找到的：
 *   portal-server.cbaleague.com/home/* 上 8 个排名候选全 404，
 *   但官网数据站 https://www.cbaleague.com/data/ 的 JS 包里写着另一个域名
 *   data-server.cbaleague.com/api，路径里有 /api/HeadTeamSort。
 *
 * ⚠️ 响应是密文：官网 JS 里自带解密（AES-128-ECB + Pkcs7），
 *    密钥硬编码在前端，所以技术上能解 —— 但这意味着：
 *    ① 官方并没有开放这个接口，对方换密钥 / 换算法我们就失效；
 *    ② 属于逆向私有接口，合规性存疑。
 *    是否使用由使用者决定，脚本只负责验证它现在还活着。
 */
const crypto = require('crypto')

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
const API = 'https://data-server.cbaleague.com/api'
// 官网 assets/index.*.js 里的 U6e()：tp.AES.decrypt(e, Utf8.parse("uVayqL4ONKjFbVzQ"), {mode: ECB, padding: Pkcs7})
const AES_KEY = Buffer.from('uVayqL4ONKjFbVzQ', 'utf8')

function decrypt(body) {
  const b64 = String(body).replace(/"/g, '').trim()
  const d = crypto.createDecipheriv('aes-128-ecb', AES_KEY, null)
  return Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]).toString('utf8')
}

async function call(path) {
  const r = await fetch(API + path, {
    headers: { 'User-Agent': UA, Referer: 'https://www.cbaleague.com/data/' },
  })
  const raw = await r.text()
  return { status: r.status, raw, json: (() => { try { return JSON.parse(decrypt(raw)) } catch (e) { return null } })() }
}

;(async () => {
  const rank = await call('/HeadTeamSort')
  console.log('HeadTeamSort:', rank.status, rank.json ? `解密成功，${rank.json.length} 队` : '解密失败')
  if (rank.json) {
    console.log('字段:', Object.keys(rank.json[0]).join(', '))
    rank.json.slice(0, 5).forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.teamName}  ${t.winNum}-${t.loserNum}  胜率 ${t.winRatePercent}  积分 ${t.integral}`)
    })
    const started = rank.json.some((t) => (t.winNum || 0) + (t.loserNum || 0) > 0)
    console.log('赛季是否已开打:', started ? '是' : '否（全是 0，榜出了也没意义）')
  }

  const seasons = await call('/com-code-tables/getSeason')
  console.log('\ngetSeason:', seasons.status, seasons.json ? JSON.stringify(seasons.json).slice(0, 200) : '解密失败')
})()
