const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')
const archive = require('../utils/tennis-event')

test('the tour feed preserves courts, event edition and the official retirement winner; qualifiers stay excluded', async () => {
  const filename = path.join(__dirname, 'sync.js')
  const raw = { id: 'test-2026', name: 'China Open', date: '2026-09-28T04:00:00Z', endDate: '2026-10-18T04:00:00Z', groupings: [{
    grouping: { slug: 'mens-singles' }, competitions: [{ id: '123', date: '2026-10-10T04:00:00Z',
      round: { displayName: 'Final' }, venue: { fullName: 'Beijing, China PR', court: 'Lotus' },
      status: { type: { state: 'post', name: 'STATUS_RETIRED', description: 'Retired' } },
      competitors: [{ id: '1', homeAway: 'home', winner: false, athlete: { id: '1', displayName: 'A' }, score: '1' },
        { id: '2', homeAway: 'away', winner: true, athlete: { id: '2', displayName: 'B' }, score: '0' }] },
      { id: 'qualifier', round: { displayName: 'Qualifying 1st Round' } }],
  }] }
  const box = { require: createRequire(filename), module: { exports: {} }, __dirname, console,
    Date, process: { argv: ['node', filename], env: {} }, AbortController, setTimeout, clearTimeout,
    fetch: async () => ({ ok: true, json: async () => ({ events: [raw] }) }) }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), box, { filename })
  const matches = await box.module.exports.fetchTennis({ key: 'atp', tour: 'atp', name: 'ATP', accent: '#1c6b45' })
  assert.equal(matches.length, 1)
  const match = matches[0]
  assert.equal(match.eventId, raw.id)
  assert.equal(match.winnerId, '2')
  assert.equal(match.statusText, '退赛')
  assert.equal(match.venue, 'Beijing, China PR · Lotus')
  const payload = archive.buildArchive(matches, null, Date.parse('2026-10-16T00:00:00Z'))
  const restored = archive.archiveRows(JSON.parse(JSON.stringify(payload)))[0]
  assert.equal(restored.winnerId, '2')
  assert.equal(restored.eventId, raw.id)
  assert.equal(restored.venue, match.venue)
  assert.equal(Date.parse(restored.start), Date.parse(match.start))
})
