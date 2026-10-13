-- Requires the already deployed 20261014_match_notification_worker migration.
-- Subscription validation must use the same recent live overlay as the sender.
-- One atomic statement; existing subscription rows and table grants are untouched.
DO $migration$
BEGIN
  CREATE OR REPLACE FUNCTION public.subscribe_match_notifications(p_match_id text, p_kinds text[])
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $subscribe$
  DECLARE
    current_user_id text := auth.uid()::text;
    match_start timestamptz;
    match_status text;
    notification_kind text;
  BEGIN
    IF current_user_id IS NULL OR current_user_id = 'anon' THEN
      RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF p_match_id IS NULL OR length(p_match_id) NOT BETWEEN 1 AND 100
      OR p_kinds IS NULL OR cardinality(p_kinds) NOT BETWEEN 1 AND 3
      OR EXISTS (SELECT 1 FROM unnest(p_kinds) AS k WHERE k IS NULL OR k NOT IN ('pre60', 'pre15', 'result')) THEN
      RAISE EXCEPTION 'Invalid match notification request' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.favorites AS f
      WHERE f.owner_id = current_user_id AND f.match_id = p_match_id
    ) THEN
      RAISE EXCEPTION 'Follow the match before subscribing to notifications' USING ERRCODE = '42501';
    END IF;

    SELECT NULLIF(m.match_data->>'start', '')::timestamptz, m.match_data->>'status'
    INTO match_start, match_status
    FROM public.match_notification_effective_matches(now()) AS m
    WHERE m.match_id = p_match_id
    LIMIT 1;
    IF match_start IS NULL OR match_status IS NULL THEN
      RAISE EXCEPTION 'Match start time is unavailable' USING ERRCODE = '22023';
    END IF;

    FOREACH notification_kind IN ARRAY p_kinds LOOP
      IF notification_kind IN ('pre60', 'pre15') AND (match_status <> 'upcoming' OR match_start <= now()) THEN
        RAISE EXCEPTION 'Pre-match notification is no longer available' USING ERRCODE = '22023';
      END IF;
      IF notification_kind = 'result' AND (match_status NOT IN ('upcoming', 'live') OR (match_status = 'upcoming' AND match_start <= now())) THEN
        RAISE EXCEPTION 'Result notification is no longer available' USING ERRCODE = '22023';
      END IF;
      INSERT INTO public.match_notification_subscriptions (owner_id, match_id, kind)
      VALUES (current_user_id, p_match_id, notification_kind)
      ON CONFLICT (owner_id, match_id, kind) DO UPDATE
      SET status = 'pending', attempts = 0, claimed_at = NULL, created_at = now(), sent_at = NULL, last_error = NULL
      WHERE public.match_notification_subscriptions.status IN ('sent', 'failed', 'expired');
    END LOOP;
  END;
  $subscribe$;
  REVOKE ALL ON FUNCTION public.subscribe_match_notifications(text, text[]) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.subscribe_match_notifications(text, text[]) TO authenticated;
END;
$migration$;
