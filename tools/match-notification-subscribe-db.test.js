const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { PGlite } = require('@electric-sql/pglite')

test('subscription validation follows recent live state while preserving consent and access rules', async t => {
  const db = new PGlite()
  const now = Date.now()
  const sql = file => fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8')
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS text LANGUAGE sql
        AS 'SELECT NULLIF(current_setting(''request.jwt.claim.sub'', true), '''')';
      CREATE TABLE public.favorites(owner_id text, match_id text);
      CREATE TABLE public.schedule_cache(id text PRIMARY KEY, data jsonb, generated_at timestamptz);
      CREATE TABLE public.live_scores(id text PRIMARY KEY, data jsonb, generated_at timestamptz);
      GRANT USAGE ON SCHEMA public TO anon, authenticated;
    `)
    await db.exec(sql('20261013_match_notification_subscriptions.sql'))
    await db.exec(sql('20261014_match_notification_worker.sql'))
    await db.exec(sql('20261014_match_notification_subscribe_live.sql'))
    await db.exec(sql('20261014_match_notification_subscribe_live.sql'))
    const matches = [
      { id: 'ucl-live', status: 'upcoming', start: new Date(now - 10 * 60000).toISOString() },
      { id: 'ucl-final', status: 'live', start: new Date(now - 140 * 60000).toISOString() },
      { id: 'nba-later', status: 'upcoming', start: new Date(now + 150 * 60000).toISOString() },
      { id: 'nba-live', status: 'live', start: new Date(now - 120 * 60000).toISOString() },
    ].map(m => ({ ...m, comp: m.id.startsWith('ucl') ? 'ucl' : 'nba', home: { score: 0 }, away: { score: 0 } }))
    await db.query('INSERT INTO public.schedule_cache VALUES ($1,$2,$3)', ['latest', JSON.stringify(matches), new Date(now - 45 * 60000).toISOString()])
    await db.query('INSERT INTO public.live_scores VALUES ($1,$2,$3)', ['latest', JSON.stringify({ rows: [
      { id: 'ucl-live', st: 'live', hs: 0, as: 1 },
      { id: 'ucl-final', st: 'finished', hs: 1, as: 0 },
    ] }), new Date(now).toISOString()])
    for (const match of matches) await db.query('INSERT INTO public.favorites VALUES ($1,$2)', ['wx:fixture', match.id])
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", ['wx:fixture'])
    const subscribe = async (id, kinds, role = 'authenticated') => {
      await db.exec(`SET ROLE ${role}`)
      try { return await db.query('SELECT public.subscribe_match_notifications($1,$2)', [id, kinds]) }
      finally { await db.exec('RESET ROLE') }
    }
    const count = async id => (await db.query('SELECT count(*)::integer AS n FROM public.match_notification_subscriptions WHERE match_id=$1', [id])).rows[0].n

    await t.test('an ongoing match can subscribe to its result even while the big snapshot is still upcoming', async () => {
      await subscribe('ucl-live', ['result'])
      assert.equal(await count('ucl-live'), 1)
    })
    await t.test('live matches cannot get pre-match reminders and a mixed invalid request does not save partial consent', async () => {
      for (const kinds of [['pre15'], ['pre60'], ['result', 'pre15']]) {
        await assert.rejects(() => subscribe('ucl-live', kinds), e => e.code === '22023' && /Pre-match/.test(e.message))
      }
      assert.equal(await count('ucl-live'), 1)
    })
    await t.test('a fresh finished patch prevents new result subscriptions even when the snapshot remains live', async () => {
      await assert.rejects(() => subscribe('ucl-final', ['result']), e => e.code === '22023')
      assert.equal(await count('ucl-final'), 0)
    })
    await t.test('future NBA notifications and live snapshot result subscriptions continue to work', async () => {
      await subscribe('nba-later', ['pre15', 'result'])
      await subscribe('nba-later', ['pre60'])
      await subscribe('nba-live', ['result'])
      assert.equal(await count('nba-later'), 3)
      assert.equal(await count('nba-live'), 1)
    })
    await t.test('stale live data cannot turn an overdue upcoming snapshot into a subscribable live match', async () => {
      await db.query('UPDATE public.live_scores SET generated_at=$1', [new Date(now - 20 * 60000).toISOString()])
      await assert.rejects(() => subscribe('ucl-live', ['result']), e => e.code === '22023')
    })
    await t.test('only the signed-in account that follows the match can subscribe; private tables remain unreadable', async () => {
      await assert.rejects(() => subscribe('nba-later', ['result'], 'anon'), e => e.code === '42501')
      await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", ['wx:other'])
      await assert.rejects(() => subscribe('nba-later', ['result']), e => e.code === '42501')
      await db.exec('SET ROLE authenticated')
      try { await assert.rejects(() => db.query('SELECT * FROM public.match_notification_subscriptions'), e => e.code === '42501') }
      finally { await db.exec('RESET ROLE') }
    })
  } finally { await db.close() }
})
