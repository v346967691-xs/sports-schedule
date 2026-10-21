const test = require('node:test')
const assert = require('node:assert/strict')
const nba = require('../utils/nba-names')

test('NBA全部30队统一短名，原始身份与其他项目不受影响', () => {
  assert.equal(new Set(nba.ROWS.map(r => r[0])).size, 30)
  assert.equal(new Set(nba.ROWS.map(r => r[1])).size, 30)
  for (const [id, short, zh, name] of nba.ROWS) {
    const original = {comp:'nba', home:{id:String(id), zh, name, abbr:'ABC', score:123}, away:{id:'unknown', name:'待定'}}
    const out = nba.match(original)
    assert.equal(out.home.zh, short)
    assert.equal(out.home.display, short)
    assert.equal(out.home.name, name)
    assert.equal(out.home.id, String(id))
    assert.equal(out.home.score, 123)
    assert.equal(original.home.zh, zh)
    assert.equal(nba.text(name), short)
    assert.equal(require('./zh-names').NBA_ZH[id], short)
    const soccer = {...original, comp:'epl'}
    assert.equal(nba.match(soccer), soccer)
  }
  assert.equal(nba.text('俄克拉荷马城雷霆 vs 洛杉矶快船'), '雷霆 vs 快船')
  assert.equal(nba.text('费城76人'), '76人')
})

test('旧排行榜、球员所属队、日报与分享文案去城市，链接与数据不变', () => {
  const old = {groups:[{rows:[{id:'13', name:'Los Angeles Lakers', zh:'洛杉矶湖人', pts:42}]}],
    players:[{i:'123', z:'勒布朗·詹姆斯', tz:'洛杉矶湖人'}],
    team:'波士顿凯尔特人', headline:{title:'金州勇士胜洛杉矶湖人', body:'费城76人出战'},
    home:'明尼苏达森林狼', away:'俄克拉荷马城雷霆',
    url:'https://example.com/Los Angeles Lakers', id:'洛杉矶湖人', abbr:'LAL'}
  const out = nba.payload(old)
  assert.equal(out.groups[0].rows[0].name, '湖人')
  assert.equal(out.groups[0].rows[0].pts, 42)
  assert.equal(out.players[0].tz, '湖人')
  assert.equal(out.players[0].z, '勒布朗·詹姆斯')
  assert.equal(out.team, '凯尔特人')
  assert.equal(out.headline.title, '勇士胜湖人')
  assert.equal(out.headline.body, '76人出战')
  assert.equal(out.home, '森林狼')
  assert.equal(out.away, '雷霆')
  assert.equal(out.url, old.url)
  assert.equal(out.id, old.id)
  assert.equal(out.abbr, 'LAL')
  assert.equal(old.players[0].tz, '洛杉矶湖人')
})

test('实际赛程与全站搜索对旧城市名和短名均返回短队名', () => {
  const data = require('../utils/data')
  const search = require('../utils/search')
  const matches = data.matches().filter(m => m.comp === 'nba')
  assert.ok(matches.length)
  for (const m of matches) for (const side of [m.home, m.away]) {
    if (nba.SHORT[side.id]) assert.equal(side.zh, nba.SHORT[side.id])
  }
  for (const query of ['洛杉矶湖人','洛杉矶','湖人','Los Angeles Lakers']) {
    const rows = search.search(query, 50)
    assert.ok(rows.some(r => r.display === '湖人'), query)
    assert.ok(!rows.some(r => r.display === '洛杉矶湖人'), query)
  }
})

test('旧关注比赛与已关注球队显示短名，关注身份保持不变', async () => {
  const fs = require('node:fs')
  const vm = require('node:vm')
  const {createRequire} = require('node:module')
  const path = require('node:path')
  const old = {comp:'nba', id:'13', zh:'洛杉矶湖人', display:'洛杉矶湖人', name:'Los Angeles Lakers'}
  const rows = [{id:1, match_id:'nba-1', comp:'nba', home:'洛杉矶湖人', away:'金州勇士'}]
  const cloud = {isReady:()=>true, getSession:async()=>({data:{user:{id:'u'}}}), cloud:{database:{from:()=>({select:()=>({order:async()=>({data:rows})})})}}}
  function load(file) {
    const filename = path.resolve(__dirname, '../utils', file)
    const native = createRequire(filename)
    const box = {module:{exports:{}}, require:id=>id === './cloud' ? cloud : native(id), wx:{getStorageSync:()=>[old]}, console}
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), box, {filename})
    return box.module.exports
  }
  const favorites = await load('favorites.js').list()
  assert.equal(favorites.data[0].home, '湖人')
  assert.equal(favorites.data[0].away, '勇士')
  assert.equal(favorites.data[0].match_id, 'nba-1')
  assert.equal(rows[0].home, '洛杉矶湖人')
  const follows = load('team-follows.js')
  const saved = follows.all()[0]
  assert.equal(saved.display, '湖人')
  assert.equal(saved.id, '13')
  assert.equal(follows.has('nba', '13'), true)
})
