-- Add only the Worlds report namespace; do not change ordinary brief policies or data.
-- Execute once through the database administrator SQL interface.
DO $migration$
BEGIN
  DROP POLICY IF EXISTS worlds_brief_read ON public.daily_brief;
  CREATE POLICY worlds_brief_read ON public.daily_brief FOR SELECT TO anon, authenticated
    USING (id = 'worlds-morning-' || date::text AND date::text BETWEEN '2026-10-15' AND '2026-11-15');

  DROP POLICY IF EXISTS worlds_brief_insert ON public.daily_brief;
  CREATE POLICY worlds_brief_insert ON public.daily_brief FOR INSERT TO anon, authenticated
    WITH CHECK (
      id = 'worlds-morning-' || date::text
      AND date::text BETWEEN '2026-10-15' AND '2026-11-15'
      AND kind = 'morning' AND mode = 'report'
      AND payload ->> 'id' = id AND payload ->> 'date' = date::text
      AND payload ->> 'version' = '1'
      AND payload ->> 'editionHour' IN ('9', '14')
    );

  DROP POLICY IF EXISTS worlds_brief_update ON public.daily_brief;
  CREATE POLICY worlds_brief_update ON public.daily_brief FOR UPDATE TO anon, authenticated
    USING (id = 'worlds-morning-' || date::text AND date::text BETWEEN '2026-10-15' AND '2026-11-15')
    WITH CHECK (
      id = 'worlds-morning-' || date::text
      AND date::text BETWEEN '2026-10-15' AND '2026-11-15'
      AND kind = 'morning' AND mode = 'report'
      AND payload ->> 'id' = id AND payload ->> 'date' = date::text
      AND payload ->> 'version' = '1'
      AND payload ->> 'editionHour' IN ('9', '14')
    );
END;
$migration$;
