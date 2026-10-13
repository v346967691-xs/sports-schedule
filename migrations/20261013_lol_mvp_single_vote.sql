-- Enforce one immutable vote per account and series.
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
  ON CONFLICT (match_id, voter_id) DO NOTHING;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This account has already voted for this match' USING ERRCODE = '23505';
  END IF;
END;
$$;
