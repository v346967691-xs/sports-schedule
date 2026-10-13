-- One atomic statement: no interval in which a new SECURITY DEFINER RPC is PUBLIC.
-- Existing subscription/MVP migrations are not rerun and no user rows are changed.
-- The worker token is generated separately; only its SHA-256 digest goes in this table.
DO $migration$
BEGIN
  CREATE TABLE IF NOT EXISTS public.match_notification_worker_secret (
    name text PRIMARY KEY CHECK (name = 'worker'),
    token_digest text NOT NULL CHECK (token_digest ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE public.match_notification_worker_secret ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE public.match_notification_worker_secret FROM PUBLIC, anon, authenticated;

  CREATE OR REPLACE FUNCTION public.assert_match_notification_worker(p_token text)
  RETURNS void LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = pg_catalog, public
  AS $auth$
  DECLARE expected_digest text;
  BEGIN
    SELECT s.token_digest INTO expected_digest
    FROM public.match_notification_worker_secret AS s WHERE s.name = 'worker';
    IF p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' OR expected_digest IS NULL
      OR encode(sha256(convert_to(p_token, 'UTF8')), 'hex') IS DISTINCT FROM expected_digest THEN
      RAISE EXCEPTION 'Unauthorized notification worker' USING ERRCODE = '42501';
    END IF;
  END;
  $auth$;
  REVOKE ALL ON FUNCTION public.assert_match_notification_worker(text) FROM PUBLIC, anon, authenticated;

  CREATE OR REPLACE FUNCTION public.check_match_notification_worker(p_token text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
  AS $check$
  BEGIN
    PERFORM public.assert_match_notification_worker(p_token);
    RETURN true;
  END;
  $check$;
  REVOKE ALL ON FUNCTION public.check_match_notification_worker(text) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.check_match_notification_worker(text) TO anon;

  -- Use the same recent live overlay as the client, so results do not wait for the 90-minute snapshot gate.
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
      AND live.generated_at >= p_now - interval '15 minutes'
      AND live.generated_at <= p_now + interval '1 minute'
      AND live.generated_at > s.generated_at
    LEFT JOIN LATERAL (
      SELECT patch.value FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(live.data->'rows') = 'array' THEN live.data->'rows' ELSE '[]'::jsonb END
      ) AS patch(value)
      WHERE patch.value->>'id' = m.value->>'id'
        AND patch.value->>'st' IN ('live', 'finished')
      LIMIT 1
    ) AS l ON true
    WHERE s.id = 'latest';
  $matches$;
  REVOKE ALL ON FUNCTION public.match_notification_effective_matches(timestamptz) FROM PUBLIC, anon, authenticated;

  -- The old (timestamptz) overload remains service-role-only. The anon worker must supply p_token.
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
      WHERE n.attempts < 3
        AND (n.status = 'pending' OR (n.status = 'sending' AND n.claimed_at < send_time - interval '20 minutes'))
        AND (
          (n.kind = 'pre60' AND m.match_data->>'status' = 'upcoming'
            AND NULLIF(m.match_data->>'start', '')::timestamptz > send_time + interval '15 minutes'
            AND NULLIF(m.match_data->>'start', '')::timestamptz <= send_time + interval '60 minutes')
          OR (n.kind = 'pre15' AND m.match_data->>'status' IN ('upcoming', 'live')
            AND NULLIF(m.match_data->>'start', '')::timestamptz >= send_time - interval '10 minutes'
            AND NULLIF(m.match_data->>'start', '')::timestamptz <= send_time + interval '15 minutes')
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

  CREATE OR REPLACE FUNCTION public.finish_match_notification(
    p_token text, p_owner_id text, p_match_id text, p_kind text, p_status text,
    p_claimed_at timestamptz, p_error text DEFAULT NULL
  ) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
  AS $finish$
  DECLARE affected integer;
  BEGIN
    PERFORM public.assert_match_notification_worker(p_token);
    IF p_status IS NULL OR p_status NOT IN ('pending', 'sent', 'failed', 'expired')
      OR p_kind IS NULL OR p_kind NOT IN ('pre60', 'pre15', 'result')
      OR p_owner_id IS NULL OR length(p_owner_id) NOT BETWEEN 1 AND 200
      OR p_match_id IS NULL OR length(p_match_id) NOT BETWEEN 1 AND 100
      OR p_claimed_at IS NULL THEN
      RAISE EXCEPTION 'Invalid notification completion' USING ERRCODE = '22023';
    END IF;
    UPDATE public.match_notification_subscriptions AS n
    SET status = CASE WHEN p_status = 'pending' AND n.attempts >= 3 THEN 'failed' ELSE p_status END,
        sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE n.sent_at END,
        claimed_at = NULL, last_error = left(replace(p_error, p_token, '[redacted]'), 200)
    WHERE n.owner_id = p_owner_id AND n.match_id = p_match_id AND n.kind = p_kind
      AND n.status = 'sending' AND n.claimed_at = p_claimed_at;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected;
  END;
  $finish$;
  REVOKE ALL ON FUNCTION public.finish_match_notification(text, text, text, text, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.finish_match_notification(text, text, text, text, text, timestamptz, text) TO anon;
END;
$migration$;
