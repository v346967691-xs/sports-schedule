-- 30-minute collection cadence; retire pre15 without converting or deleting user consent.
-- Requires the existing worker and subscription migrations. Does not change secrets, tables or grants.
DO $migration$
BEGIN
  CREATE OR REPLACE FUNCTION public.match_notification_effective_matches(p_now timestamptz)
  RETURNS TABLE(match_id text, match_data jsonb)
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public
  AS $matches$
    SELECT m.value->>'id', CASE WHEN l.value IS NULL THEN m.value ELSE
      jsonb_set(jsonb_set(jsonb_set(jsonb_set(m.value,
        '{status}', l.value->'st'),
        '{statusText}', to_jsonb(COALESCE(l.value->>'stt', m.value->>'statusText', ''))),
        '{home,score}', COALESCE(l.value->'hs', m.value #> '{home,score}', 'null'::jsonb)),
        '{away,score}', COALESCE(l.value->'as', m.value #> '{away,score}', 'null'::jsonb)) END
    FROM public.schedule_cache AS s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.data, '[]'::jsonb)) AS m(value)
    LEFT JOIN public.live_scores AS live ON live.id = 'latest'
      AND live.generated_at >= p_now - interval '45 minutes'
      AND live.generated_at <= p_now + interval '1 minute'
      AND live.generated_at > s.generated_at
    LEFT JOIN LATERAL (
      SELECT patch.value FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(live.data->'rows') = 'array' THEN live.data->'rows' ELSE '[]'::jsonb END
      ) AS patch(value)
      WHERE patch.value->>'id' = m.value->>'id'
        AND patch.value->>'st' IN ('live', 'finished')
        AND COALESCE(NULLIF(patch.value->>'at', '')::timestamptz, live.generated_at)
          BETWEEN GREATEST(s.generated_at, p_now - interval '45 minutes') AND p_now + interval '1 minute'
      LIMIT 1
    ) AS l ON true
    WHERE s.id = 'latest';
  $matches$;
  REVOKE ALL ON FUNCTION public.match_notification_effective_matches(timestamptz) FROM PUBLIC, anon, authenticated;

  CREATE OR REPLACE FUNCTION public.claim_due_match_notifications(p_token text, p_now timestamptz DEFAULT now())
  RETURNS TABLE(owner_id text, match_id text, kind text, attempts integer, match_data jsonb, claimed_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
  AS $claim$
  DECLARE send_time timestamptz := COALESCE(p_now, now());
  BEGIN
    PERFORM public.assert_match_notification_worker(p_token);
    IF abs(extract(epoch FROM send_time - now())) > 300 THEN
      RAISE EXCEPTION 'Worker clock is too far from database time' USING ERRCODE = '22023';
    END IF;

    UPDATE public.match_notification_subscriptions AS retired
    SET status = 'expired', claimed_at = NULL, last_error = '15-minute reminders retired'
    WHERE retired.kind = 'pre15' AND retired.status IN ('pending', 'sending');

    UPDATE public.match_notification_subscriptions AS n
    SET status = 'failed', claimed_at = NULL, last_error = COALESCE(n.last_error, 'Retry limit reached')
    WHERE n.attempts >= 3 AND (n.status = 'pending'
      OR (n.status = 'sending' AND n.claimed_at < send_time - interval '20 minutes'));

    UPDATE public.match_notification_subscriptions AS n
    SET status = 'expired', claimed_at = NULL
    FROM public.match_notification_effective_matches(send_time) AS m
    WHERE n.match_id = m.match_id
      AND (n.status = 'pending' OR (n.status = 'sending' AND n.claimed_at < send_time - interval '20 minutes'))
      AND (
        (n.kind = 'pre60' AND m.match_data->>'status' <> 'upcoming')
        OR (n.kind = 'pre15' AND m.match_data->>'status' NOT IN ('upcoming', 'live'))
        OR (n.kind IN ('pre60', 'pre15') AND NULLIF(m.match_data->>'start', '')::timestamptz < send_time - interval '10 minutes')
        OR (n.kind = 'pre60' AND NULLIF(m.match_data->>'start', '')::timestamptz <= send_time + interval '15 minutes')
      );

    RETURN QUERY WITH candidates AS MATERIALIZED (
      SELECT n.owner_id, n.match_id, n.kind, m.match_data
      FROM public.match_notification_subscriptions AS n
      JOIN public.favorites AS f ON f.owner_id = n.owner_id AND f.match_id = n.match_id
      JOIN public.match_notification_effective_matches(send_time) AS m ON m.match_id = n.match_id
      WHERE n.kind IN ('pre60', 'result') AND n.attempts < 3
        AND (n.status = 'pending' OR (n.status = 'sending' AND n.claimed_at < send_time - interval '20 minutes'))
        AND (
          (n.kind = 'pre60' AND m.match_data->>'status' = 'upcoming'
            AND NULLIF(m.match_data->>'start', '')::timestamptz > send_time + interval '15 minutes'
            AND NULLIF(m.match_data->>'start', '')::timestamptz <= send_time + interval '60 minutes')
          OR (n.kind = 'result' AND m.match_data->>'status' = 'finished'
            AND COALESCE(m.match_data #>> '{home,score}', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
            AND COALESCE(m.match_data #>> '{away,score}', '') ~ '^-?[0-9]+(\.[0-9]+)?$')
        )
      ORDER BY n.created_at FOR UPDATE OF n SKIP LOCKED LIMIT 100
    ), claimed AS (
      UPDATE public.match_notification_subscriptions AS n
      SET status = 'sending', claimed_at = send_time, attempts = n.attempts + 1, last_error = NULL
      FROM candidates AS c WHERE n.owner_id = c.owner_id AND n.match_id = c.match_id AND n.kind = c.kind
      RETURNING n.owner_id, n.match_id, n.kind, n.attempts, n.claimed_at
    )
    SELECT c.owner_id, c.match_id, c.kind, c.attempts, due.match_data, c.claimed_at
    FROM claimed AS c JOIN candidates AS due USING (owner_id, match_id, kind);
  END;
  $claim$;
  REVOKE ALL ON FUNCTION public.claim_due_match_notifications(text, timestamptz) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.claim_due_match_notifications(text, timestamptz) TO anon;

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
    IF NOT EXISTS (SELECT 1 FROM unnest(p_kinds) AS k WHERE k IN ('pre60', 'result')) THEN
      RAISE EXCEPTION '15-minute reminders retired' USING ERRCODE = '22023';
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
      IF notification_kind = 'pre15' THEN CONTINUE; END IF; -- Old mixed requests keep result consent only.
      IF notification_kind = 'pre60' AND (match_status <> 'upcoming' OR match_start <= now()) THEN
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
    UPDATE public.match_notification_subscriptions AS retired
    SET status = 'expired', claimed_at = NULL, last_error = '15-minute reminders retired'
    WHERE retired.kind = 'pre15' AND retired.status IN ('pending', 'sending');

END;
$migration$;
