/** 由现有译名表生成客户端字典，不抓取网络、不增加同步频率。 */
const fs = require('node:fs')
const path = require('node:path')
const target = path.join(__dirname, '../data/football-player-names.js')
function source() {
  const autoFile = require.resolve('./player-zh')
  delete require.cache[autoFile]
  const {AUTO_PLAYER_ZH} = require(autoFile)
  const {PLAYER_ZH} = require('./zh-names')
  const nba = require('../utils/nba-players').ZH
  return Object.fromEntries(Object.entries({...AUTO_PLAYER_ZH,...PLAYER_ZH})
    .filter(([id,zh])=>!nba[id] && typeof zh === 'string' && zh.trim())
    .sort(([a],[b])=>Number(a)-Number(b)))
}
function render() { return '/** 由 tools/build-football-player-names.js 生成；纠错请修改 tools/zh-names.js。 */\nmodule.exports = '+JSON.stringify({ZH:source()})+'\n' }
function write() { fs.writeFileSync(target,render()); return target }
if (require.main === module) {
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(target) || fs.readFileSync(target,'utf8').replace(/\r\n/g,'\n') !== render()) {
      console.error('足球客户端译名表未同步，请运行 node tools/build-football-player-names.js')
      process.exitCode = 1
    }
  } else console.log(write())
}
module.exports = {source,render,write}
