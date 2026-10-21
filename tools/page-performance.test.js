const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const {createRequire} = require('node:module')

function fixture() {
  const filename = path.resolve(__dirname, '../utils/data.js'), native = createRequire(filename)
  let scans = 0
  const scope = native('./tennis-scope')
  const cloud = {isReady:()=>false}
  const box = {module:{exports:{}}, console, Date, require(id) {
    if (id === './cloud') return cloud
    if (id === './tennis-scope') return {...scope, allows(...args) {scans++; return scope.allows(...args)}}
    return native(id)
  }}
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), box, {filename})
  const data = box.module.exports
  const app = {globalData:{}, isFav:()=>false, refreshAuth:async()=>{}}
  function page(name) {
    const file = path.resolve(__dirname, `../pages/${name}/${name}.js`), req = createRequire(file)
    let spec
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {Page:p=>{spec=p}, console, Date, setInterval, clearInterval,
      wx:{getStorageSync:()=>null, getWindowInfo:()=>({windowWidth:375,windowHeight:667})},
      require(id) {
        if (id.endsWith('/data')) return data
        if (id.endsWith('/poster')) return {build:async()=>''}
        if (id.endsWith('/app-instance')) return {appInstance:()=>app}
        return req(id)
      }}, {filename:file})
    spec.setData = function(values, cb) {Object.assign(this.data, values); if (cb) cb()}
    return spec
  }
  return {data, cloud, page, scans:()=>scans}
}

test('schedule category and league switches reuse scope checks instead of rescanning the full tennis calendar', () => {
  const f = fixture(), p = f.page('schedule')
  p.applyCat('football')
  const firstScans = f.scans()
  assert.ok(firstScans > 0)
  const visible = f.data.matches()
  visible.pop()
  assert.equal(f.data.matches().length, visible.length + 1, 'caller sorting or removing rows must not alter shared scope results')
  for (const key of ['basketball', 'esports', 'tennis', 'football']) {
    p.onCatTap({currentTarget:{dataset:{key}}})
    assert.equal(p.data.activeCat, key)
    assert.ok(!p.data.loadError)
  }
  for (const key of ['ucl','liga','epl']) {
    p.onCompTap({currentTarget:{dataset:{key}}})
    assert.equal(p.data.activeComp, key)
    assert.ok(!p.data.loadError)
  }
  assert.equal(f.scans(), firstScans, 'unchanged snapshots must not rescan tournament levels per card/team query')
})

test('ranking mounts only current and adjacent screens, preserves horizontal navigation and bounds payload size', () => {
  const f = fixture(), p = f.page('rank')
  p.onLoad({})
  assert.ok(p.data.slides.length > 10)
  assert.ok(Buffer.byteLength(JSON.stringify(p.data.slides)) < 65000, 'hidden tennis and other leagues must not be sent to the view')
  for (const key of ['nba','wta','atp','epl','liga','ucl']) {
    p.onCompTap({currentTarget:{dataset:{key}}})
    assert.equal(p.data.activeComp, key)
    const visible = p.data.slides.filter(s=>s.visible)
    assert.ok(visible.length <= 3)
    const cur = p.data.slides[p.data.swiperIndex]
    assert.equal(cur.key, key)
    assert.equal(cur.visible, true)
    assert.ok(cur.groups.length || cur.rankRows.length || cur.boards.length || cur.swiss.length)
    for (const slide of p.data.slides.filter(s=>!s.visible)) {
      assert.equal((slide.rankRows || []).length + (slide.groups || []).length + (slide.boards || []).length, 0)
    }
  }
})

test('scope cache updates after replacing the cloud snapshot and live patches stay visible', async () => {
  const f = fixture()
  const before = f.data.matches(), scans = f.scans()
  const match = {...before.find(m=>m.comp === 'nba'), id:'nba-perf-new', status:'live', home:{id:'13',name:'Los Angeles Lakers',score:1},away:{id:'9',name:'Golden State Warriors',score:2}}
  const meta = {...f.data.meta, generatedAt:new Date(Date.now()+1000).toISOString()}
  f.cloud.isReady = ()=>true
  let table
  const chain = {select(){return this},eq(){return this},async maybeSingle(){
    return table === 'schedule_cache' ? {data:{data:[match],meta}}
      : table === 'live_scores' ? {data:{data:{rows:[{id:match.id,hs:88,as:79,at:meta.generatedAt}]}, generated_at:meta.generatedAt}} : {}
  }}
  f.cloud.cloud = {database:{from(name){table=name;return chain}}}
  await f.data.refresh()
  assert.equal(f.data.matches()[0].id, match.id)
  assert.ok(f.scans() > scans)
  const afterScans = f.scans()
  await f.data.refreshLive(true)
  assert.equal(f.data.matches()[0].home.score, 88)
  assert.equal(f.scans(), afterScans)
})
