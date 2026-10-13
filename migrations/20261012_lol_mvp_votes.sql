-- LOL series MVP: one editable vote per signed-in user and match.
-- Only aggregate rows are returned to the mini-program; voter identities remain private.
CREATE TABLE IF NOT EXISTS public.lol_mvp_votes (
  match_id text NOT NULL CHECK (length(match_id) BETWEEN 1 AND 100),
  voter_id text NOT NULL,
  player_id text NOT NULL CHECK (length(player_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, voter_id)
);

-- WorkBuddy user IDs are text claims (anonymous requests may use "anon"), not UUIDs.
-- Keep this safe to re-run after an earlier version created the column as UUID.
ALTER TABLE public.lol_mvp_votes
  ALTER COLUMN voter_id TYPE text USING voter_id::text;

ALTER TABLE public.lol_mvp_votes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lol_mvp_votes FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.cast_lol_mvp_vote(p_match_id text, p_player_id text, p_day_bucket text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_user_id text := auth.uid()::text;
BEGIN
  IF current_user_id IS NULL OR current_user_id = 'anon' THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_match_id IS NULL OR length(p_match_id) NOT BETWEEN 1 AND 100
    OR p_player_id IS NULL OR length(p_player_id) NOT BETWEEN 1 AND 200
    OR p_day_bucket IS NULL OR p_day_bucket !~ '^d-[0-9]{8}$' THEN
    RAISE EXCEPTION 'Invalid vote' USING ERRCODE = '22023';
  END IF;

  -- Confirm the chosen ID is present in this completed match's official detail payload.
  IF NOT EXISTS (
    SELECT 1
    FROM public.match_detail AS bucket
    CROSS JOIN LATERAL jsonb_each(COALESCE(bucket.payload, '{}'::jsonb)) AS match_row(match_id, detail)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(match_row.detail #> '{lol,rounds}', '[]'::jsonb)) AS game(round)
    CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(game.round->'h', game.round->'a')) AS team(value)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(team.value->'players', '[]'::jsonb)) AS player(value)
    WHERE bucket.id = p_day_bucket
      AND match_row.match_id = p_match_id
      AND match_row.detail #>> '{lol,complete}' = 'true'
      AND game.round->>'complete' = 'true'
      AND (
        ('riot:' || (player.value->>'playerId')) = p_player_id
        OR ('fallback:' || (team.value->>'id') || ':' || lower(btrim(player.value->>'name'))) = p_player_id
      )
  ) THEN
    RAISE EXCEPTION 'Player is not eligible for this match' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.lol_mvp_votes (match_id, voter_id, player_id)
  VALUES (p_match_id, current_user_id, p_player_id)
  ON CONFLICT (match_id, voter_id) DO UPDATE
    SET player_id = EXCLUDED.player_id, updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.get_lol_mvp_vote_summary(p_match_id text)
RETURNS TABLE (player_id text, vote_count bigint, is_mine boolean, total_votes bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_user_id text := auth.uid()::text;
BEGIN
  IF p_match_id IS NULL OR length(p_match_id) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid match id' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH grouped AS (
    SELECT v.player_id, count(*)::bigint AS vote_count,
      COALESCE(bool_or(v.voter_id = current_user_id), false) AS is_mine
    FROM public.lol_mvp_votes AS v
    WHERE v.match_id = p_match_id
    GROUP BY v.player_id
  )
  SELECT g.player_id, g.vote_count, g.is_mine,
    sum(g.vote_count) OVER ()::bigint AS total_votes
  FROM grouped AS g;
END;
$$;

REVOKE ALL ON FUNCTION public.cast_lol_mvp_vote(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_lol_mvp_vote_summary(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cast_lol_mvp_vote(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_lol_mvp_vote_summary(text) TO anon, authenticated;
