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
