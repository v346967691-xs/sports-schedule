const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { PGlite } = require('@electric-sql/pglite')

test('generic match MVP RPCs validate official completed candidates and preserve private immutable votes', async t => {
  const db = new PGlite()
  const migration = file => fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8')
  const day = 'd-20261014'
  const candidate = (id, name = 'Official Player', side = 'home') => ({
    id, name, side, role: 'Player', roleKey: 'player', stats: [{ label: 'Score', value: '20' }],
  })
  const final = (kind, candidates) => ({ fin: true, mvp: { v: 1, kind, complete: true, candidates, note: '' } })
  const fixtures = {
    'nba-final': final('basketball', [candidate('espn:1'), candidate('espn:2', 'Away Player', 'away')]),
    'football-final': final('football', [candidate('espn:3')]),
    'kpl-final': final('kpl', [{ ...candidate('kpl:4'), champions: ['Hero'], games: 3 }]),
    'nba-live': { ...final('basketball', [candidate('espn:1')]), fin: false },
    'nba-incomplete': { fin: true, mvp: { ...final('basketball', [candidate('espn:1')]).mvp, complete: false } },
    'nba-string-final': { ...final('basketball', [candidate('espn:1')]), fin: 'true' },
    'nba-string-complete': { fin: true, mvp: { ...final('basketball', [candidate('espn:1')]).mvp, complete: 'true' } },
    'nba-empty': final('basketball', []),
    'nba-invalid-candidates': final('basketball', {}),
    'nba-missing-mvp': { fin: true },
    'nba-invalid-version': { fin: true, mvp: { ...final('basketball', [candidate('espn:1')]).mvp, v: 2 } },
    'nba-wrong-prefix': final('basketball', [candidate('kpl:4')]),
    'nba-placeholder': final('basketball', [candidate('espn:5', '')]),
    'nba-bad-side': final('basketball', [candidate('espn:6', 'Player', 'bench')]),
    'lol-final': { fin: true, lol: { complete: true, rounds: [{ complete: true, h: { id: 'h', players: [{ playerId: '10', name: 'LOL Player' }] }, a: { id: 'a', players: [] } }] } },
    'lol-generic': final('lol', [candidate('espn:1')]),
  }
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS text LANGUAGE sql
        AS 'SELECT NULLIF(current_setting(''request.jwt.claim.sub'', true), '''')';
      CREATE TABLE public.match_detail(id text PRIMARY KEY, payload jsonb);
      GRANT USAGE ON SCHEMA public TO anon, authenticated;
    `)
    await db.query('INSERT INTO public.match_detail VALUES ($1,$2)', [day, JSON.stringify(fixtures)])
    await db.exec(migration('20261012_lol_mvp_votes.sql'))
    await db.exec(migration('20261013_lol_mvp_single_vote.sql'))
    await db.query("SELECT set_config('request.jwt.claim.sub', 'wx:existing', false)")
    await db.query('SELECT public.cast_lol_mvp_vote($1,$2,$3)', ['lol-final', 'riot:10', day])
    const lolBefore = (await db.query('SELECT * FROM public.lol_mvp_votes')).rows
    const lolFunctionsBefore = (await db.query("SELECT oid::regprocedure::text AS name, pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname IN ('cast_lol_mvp_vote', 'get_lol_mvp_vote_summary') ORDER BY proname")).rows
    await db.exec(migration('20261014_match_mvp_votes.sql'))

    const asRole = async (role, fn) => {
      await db.exec(`SET ROLE ${role}`)
      try { return await fn() } finally { await db.exec('RESET ROLE') }
    }
    const identity = value => db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [value])
    const cast = (match, player, bucket = day, role = 'authenticated') => asRole(role, () => db.query('SELECT public.cast_match_mvp_vote($1,$2,$3)', [match, player, bucket]))
    const summary = (match, role = 'authenticated') => asRole(role, async () => (await db.query('SELECT * FROM public.get_match_mvp_vote_summary($1) ORDER BY player_id', [match])).rows)
    const rejectsCode = (fn, code) => assert.rejects(fn, error => error.code === code)

    await t.test('final NBA, football and KPL candidates can receive one vote per account and match', async () => {
      await identity('wx:alice')
      await cast('nba-final', 'espn:1')
      await cast('football-final', 'espn:3')
      await cast('kpl-final', 'kpl:4')
      assert.deepEqual((await db.query('SELECT match_id, voter_id, player_id FROM public.match_mvp_votes ORDER BY match_id')).rows, [
        { match_id: 'football-final', voter_id: 'wx:alice', player_id: 'espn:3' },
        { match_id: 'kpl-final', voter_id: 'wx:alice', player_id: 'kpl:4' },
        { match_id: 'nba-final', voter_id: 'wx:alice', player_id: 'espn:1' },
      ])
      await rejectsCode(() => cast('nba-final', 'espn:1'), '23505')
      await rejectsCode(() => cast('nba-final', 'espn:2'), '23505')
      assert.equal((await summary('nba-final'))[0].player_id, 'espn:1')
    })

    await t.test('multi-account aggregate totals and is_mine expose only the LOL-compatible summary shape', async () => {
      await identity('wx:bob'); await cast('nba-final', 'espn:2')
      await identity('wx:carol'); await cast('nba-final', 'espn:1')
      assert.deepEqual(await summary('nba-final'), [
        { player_id: 'espn:1', vote_count: 2, is_mine: true, total_votes: 3 },
        { player_id: 'espn:2', vote_count: 1, is_mine: false, total_votes: 3 },
      ])
      await identity('wx:bob')
      assert.deepEqual((await summary('nba-final')).map(row => row.is_mine), [false, true])
      await identity('')
      const anonymous = await summary('nba-final', 'anon')
      assert.deepEqual(anonymous.map(row => row.is_mine), [false, false])
      assert.equal(anonymous[0].total_votes, 3)
      assert.deepEqual(Object.keys(anonymous[0]).sort(), ['is_mine', 'player_id', 'total_votes', 'vote_count'])
      assert.deepEqual(await summary('no-votes', 'anon'), [])
    })

    await t.test('authentication and table grants prevent reads, inserts, edits, deletes and identity spoofing', async () => {
      await identity('wx:spoof')
      await rejectsCode(() => cast('nba-final', 'espn:1', day, 'anon'), '42501')
      for (const value of ['', 'anon', '   ']) {
        await identity(value)
        await rejectsCode(() => cast('nba-final', 'espn:1'), '42501')
      }
      await identity('wx:spoof')
      for (const role of ['anon', 'authenticated']) {
        for (const query of [
          'SELECT * FROM public.match_mvp_votes',
          "INSERT INTO public.match_mvp_votes VALUES ('nba-final','wx:victim','espn:1',now())",
          "UPDATE public.match_mvp_votes SET player_id='espn:2'",
          'DELETE FROM public.match_mvp_votes',
        ]) await rejectsCode(() => asRole(role, () => db.query(query)), '42501')
      }
      await cast('football-final', 'espn:3')
      assert.equal((await db.query("SELECT voter_id FROM public.match_mvp_votes WHERE match_id='football-final' AND voter_id='wx:spoof'")).rows[0].voter_id, 'wx:spoof')
      assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.match_mvp_votes'::regclass")).rows[0].relrowsecurity, true)
      const functions = (await db.query("SELECT proname, prosecdef, proconfig FROM pg_proc WHERE proname IN ('cast_match_mvp_vote','get_match_mvp_vote_summary')")).rows
      assert.equal(functions.length, 2)
      for (const fn of functions) {
        assert.equal(fn.prosecdef, true)
        assert.deepEqual(fn.proconfig, ['search_path=pg_catalog, public'])
      }
    })

    await t.test('wrong day, foreign players, unfinished payloads and invalid parameters cannot create votes', async () => {
      await identity('wx:invalid')
      const before = (await db.query('SELECT count(*)::integer AS n FROM public.match_mvp_votes')).rows[0].n
      for (const [match, player, bucket] of [
        ['nba-final', 'espn:1', 'd-20261013'], ['nba-final', 'espn:3', day],
        ['nba-live', 'espn:1', day], ['nba-incomplete', 'espn:1', day],
        ['nba-string-final', 'espn:1', day], ['nba-string-complete', 'espn:1', day],
        ['nba-empty', 'espn:1', day], ['nba-invalid-candidates', 'espn:1', day],
        ['nba-missing-mvp', 'espn:1', day], ['nba-invalid-version', 'espn:1', day],
        ['nba-wrong-prefix', 'kpl:4', day], ['nba-placeholder', 'espn:5', day],
        ['nba-bad-side', 'espn:6', day], ['lol-generic', 'espn:1', day],
        ['missing-match', 'espn:1', day], [null, 'espn:1', day], ['', 'espn:1', day],
        [' '.repeat(5), 'espn:1', day], ['x'.repeat(101), 'espn:1', day],
        ['nba-final', null, day], ['nba-final', '', day], ['nba-final', 'x'.repeat(201), day],
        ['nba-final', 'espn:1', null], ['nba-final', 'espn:1', '20261014'],
        ['nba-final', 'espn:1', 'd-20261014-extra'],
      ]) await rejectsCode(() => cast(match, player, bucket), '22023')
      for (const match of [null, '', ' ', 'x'.repeat(101)]) await rejectsCode(() => summary(match, 'anon'), '22023')
      assert.equal((await db.query('SELECT count(*)::integer AS n FROM public.match_mvp_votes')).rows[0].n, before)
    })

    await t.test('unique primary key makes simultaneous votes immutable with one winner', async () => {
      await identity('wx:parallel')
      await db.exec('SET ROLE authenticated')
      let results
      try {
        results = await Promise.allSettled([
          db.query('SELECT public.cast_match_mvp_vote($1,$2,$3)', ['nba-final', 'espn:1', day]),
          db.query('SELECT public.cast_match_mvp_vote($1,$2,$3)', ['nba-final', 'espn:2', day]),
        ])
      } finally { await db.exec('RESET ROLE') }
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
      assert.equal(results.find(result => result.status === 'rejected').reason.code, '23505')
      assert.equal((await db.query("SELECT count(*)::integer AS n FROM public.match_mvp_votes WHERE match_id='nba-final' AND voter_id='wx:parallel'")).rows[0].n, 1)
    })

    await t.test('single-statement migration reruns preserve all new votes and every LOL function and prior vote', async () => {
      const votesBefore = (await db.query('SELECT * FROM public.match_mvp_votes ORDER BY match_id, voter_id')).rows
      // query(), unlike exec(), requires one PostgreSQL statement: the admin API contract.
      await db.query(migration('20261014_match_mvp_votes.sql'))
      assert.deepEqual((await db.query('SELECT * FROM public.match_mvp_votes ORDER BY match_id, voter_id')).rows, votesBefore)
      assert.deepEqual((await db.query('SELECT * FROM public.lol_mvp_votes')).rows, lolBefore)
      assert.deepEqual((await db.query("SELECT oid::regprocedure::text AS name, pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname IN ('cast_lol_mvp_vote', 'get_lol_mvp_vote_summary') ORDER BY proname")).rows, lolFunctionsBefore)
      await identity('wx:existing')
      await rejectsCode(() => asRole('authenticated', () => db.query('SELECT public.cast_lol_mvp_vote($1,$2,$3)', ['lol-final', 'riot:10', day])), '23505')
      await rejectsCode(() => cast('nba-final', 'espn:1', day, 'anon'), '42501')
      await rejectsCode(() => asRole('authenticated', () => db.query('SELECT * FROM public.match_mvp_votes')), '42501')
    })
  } finally { await db.close() }
})
