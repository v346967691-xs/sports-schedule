-- One accepted notification entitlement per signed-in account, match and message kind.
CREATE TABLE IF NOT EXISTS public.match_notification_subscriptions (
  owner_id text NOT NULL,
  match_id text NOT NULL CHECK (length(match_id) BETWEEN 1 AND 100),
  kind text NOT NULL CHECK (kind IN ('pre60', 'pre15', 'result')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'expired')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  last_error text,
  PRIMARY KEY (owner_id, match_id, kind)
);

CREATE INDEX IF NOT EXISTS match_notification_queue_idx
  ON public.match_notification_subscriptions (status, claimed_at, created_at)
  WHERE status IN ('pending', 'sending');

ALTER TABLE public.match_notification_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.match_notification_subscriptions FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON TABLE public.match_notification_subscriptions TO service_role;

CREATE OR REPLACE FUNCTION public.get_match_notification_states(p_match_id text)
RETURNS TABLE (kind text, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT n.kind, n.status
  FROM public.match_notification_subscriptions AS n
  WHERE n.owner_id = auth.uid()::text
    AND n.match_id = p_match_id
    AND n.status IN ('pending', 'sending', 'sent')
$$;

CREATE OR REPLACE FUNCTION public.subscribe_match_notifications(p_match_id text, p_kinds text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
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
    OR EXISTS (SELECT 1 FROM unnest(p_kinds) AS k WHERE k NOT IN ('pre60', 'pre15', 'result')) THEN
    RAISE EXCEPTION 'Invalid match notification request' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.favorites AS f
    WHERE f.owner_id = current_user_id AND f.match_id = p_match_id
  ) THEN
    RAISE EXCEPTION 'Follow the match before subscribing to notifications' USING ERRCODE = '42501';
  END IF;

  SELECT NULLIF(m.value->>'start', '')::timestamptz, m.value->>'status'
  INTO match_start, match_status
  FROM public.schedule_cache AS s
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.data, '[]'::jsonb)) AS m(value)
  WHERE s.id = 'latest' AND m.value->>'id' = p_match_id
  LIMIT 1;
  IF match_start IS NULL THEN
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
$$;

CREATE OR REPLACE FUNCTION public.cancel_match_notification_subscriptions(p_match_id text)
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
  DELETE FROM public.match_notification_subscriptions
  WHERE owner_id = current_user_id AND match_id = p_match_id;
END;
$$;

-- Server-only bounded queue claim. It avoids transferring every user's future reminders
-- on every 15-minute workflow run and lets concurrent runners skip already-claimed rows.
CREATE OR REPLACE FUNCTION public.claim_due_match_notifications(p_now timestamptz DEFAULT now())
RETURNS TABLE (owner_id text, match_id text, kind text, attempts integer, match_data jsonb, claimed_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  send_time timestamptz := COALESCE(p_now, now());
BEGIN
  UPDATE public.match_notification_subscriptions AS n
  SET status = CASE WHEN n.attempts >= 3 THEN 'failed' ELSE 'expired' END,
      claimed_at = NULL
  FROM public.schedule_cache AS s
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.data, '[]'::jsonb)) AS m(value)
  WHERE s.id = 'latest'
    AND n.match_id = m.value->>'id'
    AND (n.status = 'pending' OR (n.status = 'sending' AND n.claimed_at < send_time - interval '20 minutes'))
    AND (
      (n.kind = 'pre60' AND m.value->>'status' <> 'upcoming')
      OR (n.kind = 'pre15' AND m.value->>'status' NOT IN ('upcoming', 'live'))
      OR (n.kind IN ('pre60', 'pre15') AND NULLIF(m.value->>'start', '')::timestamptz < send_time - interval '10 minutes')
      OR (n.kind = 'pre60' AND NULLIF(m.value->>'start', '')::timestamptz <= send_time + interval '15 minutes')
    );

  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT n.owner_id, n.match_id, n.kind, m.value AS match_data
    FROM public.match_notification_subscriptions AS n
    JOIN public.favorites AS f ON f.owner_id = n.owner_id AND f.match_id = n.match_id
    JOIN public.schedule_cache AS s ON s.id = 'latest'
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.data, '[]'::jsonb)) AS m(value)
    WHERE n.match_id = m.value->>'id'
      AND n.attempts < 3
      AND (
        n.status = 'pending'
        OR (n.status = 'sending' AND n.claimed_at < send_time - interval '20 minutes')
      )
      AND (
        (n.kind = 'pre60'
          AND m.value->>'status' = 'upcoming'
          AND NULLIF(m.value->>'start', '')::timestamptz > send_time + interval '15 minutes'
          AND NULLIF(m.value->>'start', '')::timestamptz <= send_time + interval '60 minutes')
        OR (n.kind = 'pre15'
          AND m.value->>'status' IN ('upcoming', 'live')
          AND NULLIF(m.value->>'start', '')::timestamptz >= send_time - interval '10 minutes'
          AND NULLIF(m.value->>'start', '')::timestamptz <= send_time + interval '15 minutes')
        OR (n.kind = 'result'
          AND m.value->>'status' = 'finished'
          AND COALESCE(m.value #>> '{home,score}', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
          AND COALESCE(m.value #>> '{away,score}', '') ~ '^-?[0-9]+(\.[0-9]+)?$')
      )
    ORDER BY n.created_at
    FOR UPDATE OF n SKIP LOCKED
    LIMIT 100
  ), claimed AS (
    UPDATE public.match_notification_subscriptions AS n
    SET status = 'sending', claimed_at = send_time, attempts = n.attempts + 1, last_error = NULL
    FROM candidates AS c
    WHERE n.owner_id = c.owner_id AND n.match_id = c.match_id AND n.kind = c.kind
    RETURNING n.owner_id, n.match_id, n.kind, n.attempts, n.claimed_at
  )
  -- 🔴 `claimed` 的 RETURNING 只带回了订阅表自己的列，而 match_data 来自 candidates，
  --    所以必须从 `due` 取。写成 c.match_data 会在**运行时**报 42703：
  --    plpgsql 的函数体只是一段字符串，CREATE FUNCTION 时不校验 SQL 语义，
  --    只有真正被调用时才解析 —— 「建函数成功」不代表这个函数能用。
  SELECT c.owner_id, c.match_id, c.kind, c.attempts, due.match_data, c.claimed_at
  FROM claimed AS c
  JOIN candidates AS due USING (owner_id, match_id, kind);
END;
$$;

REVOKE ALL ON FUNCTION public.get_match_notification_states(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.subscribe_match_notifications(text, text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_match_notification_subscriptions(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.claim_due_match_notifications(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_match_notification_states(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.subscribe_match_notifications(text, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_match_notification_subscriptions(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_match_notifications(timestamptz) TO service_role;
