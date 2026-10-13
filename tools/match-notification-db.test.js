const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { PGlite } = require('@electric-sql/pglite')

test('notification worker migration executes in PostgreSQL with private tables and bounded token RPCs', async t => {
  const db = new PGlite()
  const token = 'a'.repeat(64)
  const digest = crypto.createHash('sha256').update(token).digest('hex')
  const now = new Date()
  const sql = file => fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8')
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS text LANGUAGE sql AS 'SELECT NULL::text';
      CREATE TABLE public.favorites(owner_id text, match_id text);
      CREATE TABLE public.schedule_cache(id text PRIMARY KEY, data jsonb, generated_at timestamptz);
      CREATE TABLE public.live_scores(id text PRIMARY KEY, data jsonb, generated_at timestamptz);
      GRANT USAGE ON SCHEMA public TO anon, authenticated;
    `)
    await db.exec(sql('20261013_match_notification_subscriptions.sql'))
    await db.exec(sql('20261014_match_notification_worker.sql'))
    // Reapplying only the NEW migration cannot recreate subscriptions or drop existing RPCs.
    await db.exec(sql('20261014_match_notification_worker.sql'))

    const anon = async fn => {
      await db.exec('SET ROLE anon')
      try { return await fn() } finally { await db.exec('RESET ROLE') }
    }
    const claim = key => db.query('SELECT * FROM public.claim_due_match_notifications($1, $2)', [key, now.toISOString()])
    const matches = [
      { id: 'lol-pre60', status: 'upcoming', start: new Date(+now + 45 * 60000).toISOString() },
      { id: 'lol-pre15', status: 'upcoming', start: new Date(+now + 10 * 60000).toISOString() },
      { id: 'lol-result', status: 'live', start: new Date(+now - 2 * 3600000).toISOString() },
    ].map(m => ({ ...m, comp: 'worlds', home: { score: 0 }, away: { score: 0 } }))
    await db.query('INSERT INTO public.schedule_cache VALUES ($1, $2, $3)', ['latest', JSON.stringify(matches), new Date(+now - 45 * 60000).toISOString()])
    await db.query('INSERT INTO public.live_scores VALUES ($1, $2, $3)', ['latest', JSON.stringify({ rows: [{ id: 'lol-result', st: 'finished', hs: 3, as: 2 }] }), now.toISOString()])
    for (const [index, kind] of ['pre60', 'pre15', 'result'].entries()) {
      await db.query('INSERT INTO public.favorites VALUES ($1,$2)', ['wx:fixture', matches[index].id])
      await db.query('INSERT INTO public.match_notification_subscriptions(owner_id,match_id,kind) VALUES ($1,$2,$3)', ['wx:fixture', matches[index].id, kind])
    }

    await t.test('unset, empty or incorrect token fails closed before changing any row', async () => {
      await anon(() => assert.rejects(() => claim(token), e => e.code === '42501'))
      await db.query('INSERT INTO public.match_notification_worker_secret(name,token_digest) VALUES ($1,$2)', ['worker', digest])
      for (const value of [null, '', 'b'.repeat(64)]) {
        await anon(() => assert.rejects(() => claim(value), e => e.code === '42501'))
      }
      assert.equal((await db.query("SELECT count(*)::integer AS n FROM public.match_notification_subscriptions WHERE status='pending'")).rows[0].n, 3)
      assert.equal((await anon(() => db.query('SELECT public.check_match_notification_worker($1) AS ok', [token]))).rows[0].ok, true)
    })

    await t.test('anonymous callers cannot read private tables, call helpers or use the legacy overload', async () => {
      for (const query of [
        'SELECT * FROM public.match_notification_worker_secret',
        'SELECT * FROM public.match_notification_subscriptions',
        'SELECT public.assert_match_notification_worker(NULL)',
        'SELECT * FROM public.match_notification_effective_matches(now())',
        'SELECT * FROM public.claim_due_match_notifications(now())',
      ]) await anon(() => assert.rejects(() => db.query(query), e => e.code === '42501'))
    })

    let rows
    await t.test('valid token claims both reminder rounds and the fresh live final score exactly once', async () => {
      rows = (await anon(() => claim(token))).rows
      assert.deepEqual(rows.map(r => r.kind).sort(), ['pre15', 'pre60', 'result'])
      const result = rows.find(r => r.kind === 'result')
      assert.equal(result.match_data.status, 'finished')
      assert.equal(result.match_data.home.score, 3)
      assert.equal(result.match_data.away.score, 2)
      assert.equal(result.attempts, 1)
      assert.equal((await anon(() => claim(token))).rows.length, 0)
    })

    const finish = (row, overrides = {}) => {
      const p = { key: token, status: 'sent', claimed: row.claimed_at, ...overrides }
      return db.query('SELECT public.finish_match_notification($1,$2,$3,$4,$5,$6,$7) AS changed',
        [p.key, row.owner_id, row.match_id, row.kind, p.status, p.claimed, null])
    }
    await t.test('completion enforces authorization, allowed states and the claim timestamp lock', async () => {
      await anon(() => assert.rejects(() => finish(rows[0], { key: null }), e => e.code === '42501'))
      await anon(() => assert.rejects(() => finish(rows[0], { status: 'sending' }), e => e.code === '22023'))
      assert.equal((await anon(() => finish(rows[0], { claimed: new Date(+now - 60000).toISOString() }))).rows[0].changed, 0)
      assert.equal((await anon(() => finish(rows[0]))).rows[0].changed, 1)
      assert.equal((await anon(() => finish(rows[0]))).rows[0].changed, 0)
      const saved = (await db.query('SELECT status,sent_at,claimed_at FROM public.match_notification_subscriptions WHERE match_id=$1', [rows[0].match_id])).rows[0]
      assert.equal(saved.status, 'sent')
      assert.ok(saved.sent_at)
      assert.equal(saved.claimed_at, null)
    })

    await t.test('an old live overlay cannot prematurely send a result from a live snapshot', async () => {
      await db.query("UPDATE public.match_notification_subscriptions SET status='pending',claimed_at=NULL WHERE kind='result'")
      await db.query('UPDATE public.live_scores SET generated_at=$1', [new Date(+now - 20 * 60000).toISOString()])
      assert.equal((await anon(() => claim(token))).rows.length, 0)
    })

    await t.test('third abandoned attempts become failed instead of remaining stuck in the queue', async () => {
      await db.query("UPDATE public.match_notification_subscriptions SET status='sending',attempts=3,claimed_at=$1 WHERE kind='result'", [new Date(+now - 21 * 60000).toISOString()])
      await anon(() => claim(token))
      assert.equal((await db.query("SELECT status FROM public.match_notification_subscriptions WHERE kind='result'")).rows[0].status, 'failed')
    })
  } finally { await db.close() }
})
