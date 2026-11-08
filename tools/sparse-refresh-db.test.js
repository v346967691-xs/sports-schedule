const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { PGlite } = require('@electric-sql/pglite')

test('sparse-refresh migration retires old pre15 consent, preserves result consent, and uses bounded newer overlays', async () => {
  const db = new PGlite()
  const sql = name => fs.readFileSync(path.join(__dirname, '../migrations', name), 'utf8')
  const now = Date.now(), token = 'a'.repeat(64)
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS text LANGUAGE sql
        AS 'SELECT NULLIF(current_setting(''request.jwt.claim.sub'',true),'''')';
      CREATE TABLE public.favorites(owner_id text,match_id text);
      CREATE TABLE public.schedule_cache(id text PRIMARY KEY,data jsonb,generated_at timestamptz);
      CREATE TABLE public.live_scores(id text PRIMARY KEY,data jsonb,generated_at timestamptz);
      GRANT USAGE ON SCHEMA public TO anon,authenticated;`)
    for (const name of ['20261013_match_notification_subscriptions.sql', '20261014_match_notification_worker.sql',
      '20261014_match_notification_subscribe_live.sql']) await db.exec(sql(name))
    const match = { id: 'nba-1', comp: 'nba', status: 'live', start: new Date(now - 90 * 60000).toISOString(),
      home: { score: 80 }, away: { score: 77 } }
    const later = { ...match, id: 'nba-later', status: 'upcoming', start: new Date(now + 40 * 60000).toISOString() }
    await db.query('INSERT INTO public.schedule_cache VALUES ($1,$2,$3)', ['latest', JSON.stringify([match, later]), new Date(now - 80 * 60000).toISOString()])
    await db.query('INSERT INTO public.live_scores VALUES ($1,$2,$3)', ['latest', JSON.stringify({ rows: [{ id: match.id, st: 'finished', hs: 100, as: 99 }] }), new Date(now - 22 * 60000).toISOString()])
    await db.query('INSERT INTO public.match_notification_worker_secret(name,token_digest) VALUES ($1,$2)', ['worker', crypto.createHash('sha256').update(token).digest('hex')])
    for (const m of [match, later]) await db.query('INSERT INTO public.favorites VALUES ($1,$2)', ['wx:fixture', m.id])
    await db.exec(`INSERT INTO public.match_notification_subscriptions(owner_id,match_id,kind,status) VALUES
      ('wx:fixture','nba-1','result','pending'),('wx:fixture','nba-later','pre15','pending'),
      ('wx:history','old-match','pre15','sent');`)
    await db.exec(sql('20261108_sparse_refresh_retire_pre15.sql'))
    await db.exec(sql('20261108_sparse_refresh_retire_pre15.sql'))
    const old = (await db.query("SELECT status FROM public.match_notification_subscriptions WHERE kind='pre15' ORDER BY owner_id")).rows
    assert.deepEqual(old.map(r => r.status), ['expired', 'sent'])
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", ['wx:fixture'])
    await db.exec('SET ROLE authenticated')
    await assert.rejects(() => db.query('SELECT public.subscribe_match_notifications($1,$2)', [later.id, ['pre15']]), /retired/)
    await db.query('SELECT public.subscribe_match_notifications($1,$2)', [later.id, ['pre15', 'result', 'pre60']])
    await db.exec('RESET ROLE')
    const active = (await db.query("SELECT kind FROM public.match_notification_subscriptions WHERE match_id=$1 AND status='pending' ORDER BY kind", [later.id])).rows
    assert.deepEqual(active.map(r => r.kind), ['pre60', 'result'])
    const claim = () => db.query('SELECT * FROM public.claim_due_match_notifications($1,$2)', [token, new Date(now).toISOString()])
    await db.exec('SET ROLE anon')
    await assert.rejects(() => db.query('SELECT * FROM public.match_notification_subscriptions'), e => e.code === '42501')
    const claimed = (await claim()).rows
    assert.deepEqual(claimed.map(r => r.kind).sort(), ['pre60', 'result'])
    assert.equal(claimed.find(r => r.kind === 'result').match_data.home.score, 100)
    assert.equal((await claim()).rows.length, 0)
    await db.exec('RESET ROLE')
    const effective = () => db.query('SELECT match_data FROM public.match_notification_effective_matches($1) WHERE match_id=$2', [new Date(now).toISOString(), match.id])
    for (const age of [46, 81, -2]) {
      await db.query('UPDATE public.live_scores SET generated_at=$1', [new Date(now - age * 60000).toISOString()])
      assert.equal((await effective()).rows[0].match_data.home.score, 80)
    }
    // A fresh heartbeat cannot make an old individual row current.
    await db.query('UPDATE public.live_scores SET generated_at=$1,data=$2', [new Date(now).toISOString(), JSON.stringify({ rows: [
      { id: match.id, st: 'finished', hs: 101, as: 99, at: new Date(now - 81 * 60000).toISOString() },
    ] })])
    assert.equal((await effective()).rows[0].match_data.home.score, 80)
  } finally { await db.close() }
})
