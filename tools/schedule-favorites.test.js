const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function fixture() {
  let page
  const app = { ids: [], isFav(id) { return this.ids.includes(id) }, async refreshAuth() {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/schedule/schedule.js'), 'utf8'), {
    Page(spec) { page = spec }, console,
    require(name) { return name.endsWith('/app-instance') ? { appInstance: () => app } : name.endsWith('/data') ? {teamForm:()=>{throw new Error('schedule cards must not calculate recent-form dots')}} : {} },
  })
  page.setData = function (values) { Object.assign(this.data, values) }
  page.allGroups = [{ date: '2026-10-17', items: ['liga', 'nba', 'lol', 'atp', 'wta'].map(comp => ({ id: comp, comp, home:{id:comp+'-h'},away:{id:comp+'-a'} })) }]
  return { page, app }
}

test('schedule marks only individually followed matches across all sports without mutating source matches', () => {
  const { page, app } = fixture()
  app.ids = ['liga', 'nba', 'lol', 'atp', 'wta']
  let matches = page.buildRows(3).filter(row => row.type === 'match')
  assert.ok(matches.every(row => row.match._isFav))
  app.ids = ['atp']
  matches = page.buildRows(3).filter(row => row.type === 'match')
  assert.deepEqual(Array.from(matches, row => row.match._isFav), [false, false, false, true, false])
  assert.ok(page.allGroups[0].items.every(match => !Object.hasOwn(match, '_isFav')))
})

test('cloud favorites refresh updates visible cards and removes canceled favorites', async () => {
  const { page, app } = fixture()
  page.liveVisible = true
  app.refreshAuth = async () => { app.ids = ['wta'] }
  await page.syncFavorites()
  assert.equal(page.data.rows.at(-1).match._isFav, true)
  app.refreshAuth = async () => { app.ids = [] }
  await page.syncFavorites()
  assert.ok(page.data.rows.filter(row => row.type === 'match').every(row => !row.match._isFav))
})

test('favorites response does not redraw a hidden schedule page', async () => {
  const { page } = fixture()
  page.liveVisible = false
  await page.syncFavorites()
  assert.equal(page.data.rows.length, 0)
})
