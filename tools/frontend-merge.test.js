const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.resolve(__dirname, '..')

test('registered tennis subpackages keep existing URLs and resolve every runtime dependency from the packaged files', () => {
  const app = require('../app.json')
  const config = require('../project.config.json')
  const routes = app.pages.concat((app.subPackages || []).flatMap(p => p.pages.map(f => `${p.root}/${f}`)))
  assert.equal(new Set(routes).size, routes.length)
  assert.deepEqual(app.pages, app.tabBar.list.map(tab => tab.pagePath), 'only the four tab pages remain in the main package')
  for (const name of ['detail', 'team', 'player', 'teams', 'brief', 'search', 'worlds', 'worlds-brief']) {
    assert.ok(routes.includes(`pages/${name}/${name}`), 'existing navigation and share paths stay valid')
    assert.ok(app.subPackages.some(p => p.root === `pages/${name}` && !p.independent))
  }
  for (const name of ['tournament', 'tennis-player']) {
    assert.ok(routes.includes(`pages/${name}/${name}`))
    assert.ok(app.subPackages.some(p => p.root === `pages/${name}` && !p.independent))
  }
  const excluded = f => config.packOptions.ignore.some(i => i.type === 'folder' ? f === i.value || f.startsWith(i.value + '/') : f === i.value)
  const visited = new Set()
  const packageOf = file => (app.subPackages.find(p => file.startsWith(p.root + '/')) || {}).root || 'main'
  function visit(file) {
    assert.equal(excluded(file), false, `excluded runtime dependency: ${file}`)
    assert.ok(fs.statSync(path.join(root, file)).isFile(), file)
    if (visited.has(file)) return
    visited.add(file)
    for (const match of fs.readFileSync(path.join(root, file), 'utf8').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const ref = match[1]
      let target = ref.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), ref)) : `miniprogram_npm/${ref}`
      if (!fs.existsSync(path.join(root, target)) || !fs.statSync(path.join(root, target)).isFile()) target += '.js'
      assert.ok(packageOf(target) === 'main' || packageOf(target) === packageOf(file), `${file} cannot require another subpackage: ${target}`)
      visit(target)
    }
  }
  visit('app.js')
  function visitComponents(configFile) {
    const json=JSON.parse(fs.readFileSync(path.join(root,configFile),'utf8'))
    for(const ref of Object.values(json.usingComponents||{})) {
      const base=ref.startsWith('/')?ref.slice(1):path.posix.normalize(path.posix.join(path.posix.dirname(configFile),ref))
      assert.ok(packageOf(base+'.json') === 'main' || packageOf(base+'.json') === packageOf(configFile), `${configFile} cannot load another subpackage component: ${base}`)
      for(const ext of ['.js','.json','.wxml','.wxss'])assert.ok(fs.existsSync(path.join(root,base+ext)),base+ext)
      visit(base+'.js')
      visitComponents(base+'.json')
    }
  }
  for (const route of routes) {
    for (const ext of ['.js', '.json', '.wxml', '.wxss']) assert.ok(fs.existsSync(path.join(root, route + ext)), route + ext)
    visit(route + '.js')
    visitComponents(route+'.json')
  }
  for (const file of ['data/kpl-rank.js', 'utils/match-notification-core.js']) {
    assert.ok(excluded(file))
    assert.equal(visited.has(file), false)
  }
  const poster = require('../utils/poster')
  for (const sport of ['football', 'basketball', 'esports', 'tennis']) {
    assert.equal(poster.BG.matches[sport], `/images/share-match-${sport}.jpg`)
    for (const file of [`images/share-match-${sport}.jpg`, `images/sport-${sport}.png`, `images/sport-${sport}-white.png`]) {
      assert.ok(fs.statSync(path.join(root, file)).size > 0)
      assert.equal(excluded(file), false)
    }
  }
})

test('schedule favorites and five-result form coexist, clear on other tabs and leave the shared snapshot unchanged', () => {
  let page
  const reads = []
  const match = { id: 'fixture', comp: 'epl', home: { id: 'h' }, away: { id: 'a' } }
  const data = { teamForm(comp, id, n) { reads.push([comp, id, n]); return [{ result: 'W' }, { result: 'D' }, { result: 'L' }] } }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/schedule/schedule.js'), 'utf8'), {
    Page: p => { page = p }, console,
    require: name => name.endsWith('/data') ? data : name.endsWith('/app-instance') ? { appInstance: () => ({ isFav: () => true }) } : {},
  })
  page.allGroups = [{ date: '2026-10-18', items: [match] }]
  const before = JSON.stringify(match)
  page.data.mode = 'upcoming'
  let card = page.buildRows(1).find(r => r.type === 'match').match
  assert.equal(card._isFav, true)
  assert.deepEqual(Array.from(card._homeForm), ['W', 'D', 'L'])
  assert.deepEqual(Array.from(card._awayForm), ['W', 'D', 'L'])
  assert.deepEqual(reads, [['epl', 'h', 5], ['epl', 'a', 5]])
  for (const mode of ['live', 'finished']) {
    page.data.mode = mode
    card = page.buildRows(1).find(r => r.type === 'match').match
    assert.equal(card._isFav, true)
    assert.equal(card._homeForm.length, 0)
    assert.equal(card._awayForm.length, 0)
  }
  assert.equal(reads.length, 2)
  assert.equal(JSON.stringify(match), before)
})

test('ranking fetches tennis points on entering tennis, with a 15-minute timer, and stops on leaving or hiding', async () => {
  let page, callback, interval, reads = 0, clears = 0
  const data = { catOf: key => key === 'atp' ? 'tennis' : 'football', refreshTennisInsights: async () => { reads++; return false } }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/rank/rank.js'), 'utf8'), {
    Page: p => { page = p }, console,
    require: name => name.endsWith('/data') ? data : name.endsWith('/tennis-refresh') ? require('../utils/tennis-refresh') : {},
    setInterval: (fn, ms) => { callback = fn; interval = ms; return 1 }, clearInterval: () => { clears++ },
  })
  page.visible = true
  page.data.activeComp = 'epl'
  page.syncTennisPoll()
  assert.equal(reads, 0)
  page.data.activeComp = 'atp'
  page.syncTennisPoll()
  assert.equal(reads, 1)
  assert.equal(interval, 15 * 60000)
  page.syncTennisPoll()
  assert.equal(reads, 1)
  await callback()
  assert.equal(reads, 2)
  page.data.activeComp = 'epl'
  page.syncTennisPoll()
  assert.equal(page.tennisTimer, null)
  assert.equal(clears, 1)
  page.data.activeComp = 'atp'
  page.syncTennisPoll()
  page.onHide()
  assert.equal(clears, 2)
  const hiddenReads = reads
  page.syncTennisPoll()
  assert.equal(reads, hiddenReads)
})
