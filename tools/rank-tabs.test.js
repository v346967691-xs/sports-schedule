const test = require('node:test')
const assert = require('node:assert/strict')
const { anchor } = require('../utils/rank-tabs')
const keys = ['a', 'b', 'c', 'd', 'e', 'f']

test('ranking tabs stay put for three positions then advance one at a time', () => {
  let current = ''
  const anchors = keys.map(selected => (current = anchor(keys, selected, current)))
  assert.deepEqual(anchors, ['a', 'a', 'a', 'b', 'c', 'd'])
  assert.equal(anchor(keys, 'e', 'd'), 'd')
  assert.equal(anchor(keys, 'd', 'd'), 'd')
  assert.equal(anchor(keys, 'c', 'd'), 'c')
  assert.equal(anchor(keys, 'a', 'c'), 'a')
})

test('deep links, missing selections and changed ordering keep anchors valid', () => {
  assert.equal(anchor(keys, 'f', ''), 'd')
  assert.equal(anchor(keys, 'd', 'removed'), 'b')
  assert.equal(anchor(['f', 'a', 'b'], 'a', 'f'), 'f')
  assert.equal(anchor(keys, 'removed', 'f'), 'a')
  assert.equal(anchor([], '', ''), '')
})

test('actual ranking page keeps the first three tabs fixed across swiper changes and taps', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
  const root = path.join(__dirname, '..')
  let options
  const source = fs.readFileSync(path.join(root, 'pages/rank/rank.js'), 'utf8')
  const data = { compOf: key => ({ name: key, cat: 'football' }), source: () => 'local', standingsGeneratedAt: () => '' }
  vm.runInNewContext(source, {
    Page: value => { options = value }, console,
    require: name => name.endsWith('/rank-tabs') ? require('../utils/rank-tabs')
      : name.endsWith('/data') ? data : {},
  })
  const page = {
    ...options, data: JSON.parse(JSON.stringify(options.data)),
    setData(patch, callback) { Object.assign(this.data, patch); if (callback) callback() },
    compKeys: () => keys, resolveTier: () => 'standings',
    tierKindOf: () => 'standings', tierLabelOf: () => '', tierState: () => [],
    buildSlide: key => ({ key }), buildShareImage() {}, syncTennisPoll() {}, topAt: () => ({}),
  }
  page.render()
  const result = [page.data.chipAnchor]
  for (const current of [1, 2, 3, 4]) {
    page.onSwiperChange({ detail: { current } })
    result.push(page.data.chipAnchor)
    assert.equal(page.data.activeComp, keys[current])
  }
  assert.deepEqual(result, ['a', 'a', 'a', 'b', 'c'])
  page.onSwiperChange({ detail: { current: 3 } })
  assert.equal(page.data.chipAnchor, 'c')
  page.onCompTap({ currentTarget: { dataset: { key: 'a' } } })
  assert.equal(page.data.chipAnchor, 'a')
  const template = fs.readFileSync(path.join(root, 'pages/rank/rank.wxml'), 'utf8')
  assert.ok(template.includes('scroll-into-view="chip-{{chipAnchor}}"'))
  assert.ok(!template.includes('scroll-into-view="chip-{{activeComp}}"'))
})
