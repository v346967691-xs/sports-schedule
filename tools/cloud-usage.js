/** Opt-in Node preload: diagnostic HTTP counters only; never writes to the cloud. */
const fs = require('node:fs')
const path = require('node:path')

function createMeter(endpoint, fetcher, clock = Date.now) {
  const base = new URL(endpoint), started = clock(), groups = new Map(), windows = new Set()
  const prefix = base.pathname.replace(/\/$/, '') + '/.cloud/database/rest/'
  async function measured(input, init = {}) {
    let url
    try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url) } catch (_) { return fetcher(input, init) }
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) return fetcher(input, init)
    const parts = url.pathname.slice(prefix.length).split('/')
    // Never log filters, bodies, tokens, user identifiers, or arbitrary path values.
    const operation = parts[0] === 'rpc' ? 'rpc' : (init.method || input.method || 'GET').toUpperCase()
    const target = parts[0] === 'rpc' ? parts[1] : parts[0]
    const key = `${operation}:${/^[a-z_]+$/.test(target || '') ? target : 'other'}`
    const row = groups.get(key) || { calls: 0, failures: 0, requestBodyBytes: 0, responseBodyBytes: 0, unreadResponses: 0, durationMs: 0 }
    groups.set(key, row); row.calls++
    if (typeof init.body === 'string') row.requestBodyBytes += Buffer.byteLength(init.body)
    const start = clock()
    windows.add(Math.floor(start / 300000))
    try {
      const response = await fetcher(input, init)
      if (!response.ok) row.failures++
      row.unreadResponses++
      let counted = false
      const record = value => { if (!counted) { counted = true; row.unreadResponses--; row.responseBodyBytes += Buffer.byteLength(value) } }
      // Count decoded response bodies when the SDK consumes them; do not clone or read ahead.
      return new Proxy(response, { get(object, property) {
        if (property === 'text') return async () => { const value = await object.text(); record(value); return value }
        if (property === 'json') return async () => { const value = await object.text(); record(value); return JSON.parse(value) }
        const value = Reflect.get(object, property, object)
        return typeof value === 'function' ? value.bind(object) : value
      } })
    } catch (error) { row.failures++; throw error }
    finally { row.durationMs += Math.max(0, clock() - start) }
  }
  return { fetch: measured, snapshot: () => ({ version: 1, diagnosticOnly: true,
    script: path.basename(process.argv[1] || 'node'), runtimeMs: Math.max(0, clock() - started),
    databaseRequestWindows: [...windows].sort((a,b) => a-b), operations: Object.fromEntries(groups) }) }
}

if (process.env.CLOUD_USAGE_DIR && typeof globalThis.fetch === 'function') {
  const meter = createMeter(require('../utils/cloud-config').endpoint, globalThis.fetch.bind(globalThis))
  globalThis.fetch = meter.fetch
  process.on('exit', () => {
    const snapshot = meter.snapshot()
    if (!Object.keys(snapshot.operations).length) return
    try {
      fs.mkdirSync(process.env.CLOUD_USAGE_DIR, { recursive: true })
      fs.writeFileSync(path.join(process.env.CLOUD_USAGE_DIR, `${Date.now()}-${process.pid}.json`), JSON.stringify(snapshot))
      console.log('[cloud-usage]', JSON.stringify(snapshot))
    } catch (error) { console.warn('[cloud-usage] local diagnostic output unavailable:', error.code) }
  })
}
module.exports = { createMeter }
