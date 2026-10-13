-- Fix the runtime-only defect in `claim_due_match_notifications`.
--
-- 20261013 的版本建函数时成功了，但**一调用就报 42703**：
--   ERROR: column c.match_data does not exist
-- 原因是 `claimed` 这个 CTE 的 RETURNING 只带回了订阅表自身的列
-- （owner_id / match_id / kind / attempts / claimed_at），而 match_data 来自
-- `candidates`，外层却写成 `c.match_data`。
--
-- 🔴 为什么当时没发现：plpgsql 的函数体对 PostgreSQL 来说只是一段字符串，
--    CREATE OR REPLACE FUNCTION 不会校验里面的 SQL 语义，只有真正执行到
--    那一步才会解析。所以「函数创建成功」≠「函数可用」——
--    这个缺陷会让线上每一次 claim 都抛错，通知一条也发不出去。
--
-- 本文件只重定义这一个函数（其余对象见 20261013），可安全重复执行。
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
  -- match_data 来自 candidates（claimed 的 RETURNING 不带它）
  SELECT c.owner_id, c.match_id, c.kind, c.attempts, due.match_data, c.claimed_at
  FROM claimed AS c
  JOIN candidates AS due USING (owner_id, match_id, kind);
END;
$$;
