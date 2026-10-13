-- Additive MVP votes for basketball, football and KPL. Existing LOL votes are untouched.
-- WorkBuddy's admin API executes this migration as one atomic statement.
DO $migration$
BEGIN
  CREATE TABLE IF NOT EXISTS public.match_mvp_votes (
    match_id text NOT NULL CHECK (length(match_id) BETWEEN 1 AND 100),
    voter_id text NOT NULL CHECK (length(btrim(voter_id)) > 0 AND voter_id <> 'anon'),
    player_id text NOT NULL CHECK (length(player_id) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (match_id, voter_id)
  );
  ALTER TABLE public.match_mvp_votes ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE public.match_mvp_votes FROM PUBLIC, anon, authenticated;

  CREATE OR REPLACE FUNCTION public.cast_match_mvp_vote(p_match_id text, p_player_id text, p_day_bucket text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $cast$
  DECLARE
    current_user_id text := auth.uid()::text;
    match_data jsonb;
    mvp_data jsonb;
  BEGIN
    IF current_user_id IS NULL OR btrim(current_user_id) = '' OR current_user_id = 'anon' THEN
      RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF p_match_id IS NULL OR length(p_match_id) NOT BETWEEN 1 AND 100
      OR btrim(p_match_id) = ''
      OR p_player_id IS NULL OR length(p_player_id) NOT BETWEEN 1 AND 200
      OR p_day_bucket IS NULL OR p_day_bucket !~ '^d-[0-9]{8}$' THEN
      RAISE EXCEPTION 'Invalid vote' USING ERRCODE = '22023';
    END IF;

    -- Read the exact persisted match in the requested day, never a client roster.
    SELECT bucket.payload -> p_match_id INTO match_data
    FROM public.match_detail AS bucket WHERE bucket.id = p_day_bucket;
    mvp_data := match_data -> 'mvp';
    IF match_data -> 'fin' IS DISTINCT FROM 'true'::jsonb
      OR mvp_data -> 'complete' IS DISTINCT FROM 'true'::jsonb
      OR mvp_data -> 'v' IS DISTINCT FROM '1'::jsonb
      OR COALESCE(mvp_data ->> 'kind', '') NOT IN ('basketball', 'football', 'kpl')
      OR jsonb_typeof(mvp_data -> 'candidates') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Match MVP is not complete' USING ERRCODE = '22023';
    END IF;
    IF (mvp_data ->> 'kind' IN ('basketball', 'football') AND p_player_id !~ '^espn:[A-Za-z0-9_-]+$')
      OR (mvp_data ->> 'kind' = 'kpl' AND p_player_id !~ '^kpl:[A-Za-z0-9_-]+$')
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(mvp_data -> 'candidates') AS candidate(value)
        WHERE candidate.value ->> 'id' = p_player_id
          AND jsonb_typeof(candidate.value -> 'id') = 'string'
          AND jsonb_typeof(candidate.value -> 'name') = 'string'
          AND length(btrim(candidate.value ->> 'name')) > 0
          AND candidate.value ->> 'side' IN ('home', 'away')
      ) THEN
      RAISE EXCEPTION 'Player is not eligible for this match' USING ERRCODE = '22023';
    END IF;

    -- The unique primary key also serializes concurrent requests for this account.
    INSERT INTO public.match_mvp_votes (match_id, voter_id, player_id)
    VALUES (p_match_id, current_user_id, p_player_id)
    ON CONFLICT (match_id, voter_id) DO NOTHING;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'This account has already voted for this match' USING ERRCODE = '23505';
    END IF;
  END;
  $cast$;

  CREATE OR REPLACE FUNCTION public.get_match_mvp_vote_summary(p_match_id text)
  RETURNS TABLE (player_id text, vote_count bigint, is_mine boolean, total_votes bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $summary$
  DECLARE
    current_user_id text := auth.uid()::text;
  BEGIN
    IF p_match_id IS NULL OR length(p_match_id) NOT BETWEEN 1 AND 100 OR btrim(p_match_id) = '' THEN
      RAISE EXCEPTION 'Invalid match id' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY
    WITH grouped AS (
      SELECT v.player_id, count(*)::bigint AS vote_count,
        COALESCE(bool_or(v.voter_id = current_user_id AND current_user_id <> 'anon'), false) AS is_mine
      FROM public.match_mvp_votes AS v
      WHERE v.match_id = p_match_id
      GROUP BY v.player_id
    )
    SELECT g.player_id, g.vote_count, g.is_mine,
      sum(g.vote_count) OVER ()::bigint AS total_votes
    FROM grouped AS g;
  END;
  $summary$;

  REVOKE ALL ON FUNCTION public.cast_match_mvp_vote(text, text, text) FROM PUBLIC, anon;
  REVOKE ALL ON FUNCTION public.get_match_mvp_vote_summary(text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.cast_match_mvp_vote(text, text, text) TO authenticated;
  GRANT EXECUTE ON FUNCTION public.get_match_mvp_vote_summary(text) TO anon, authenticated;
END;
$migration$;
