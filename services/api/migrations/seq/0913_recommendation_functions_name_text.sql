-- 0913: Fix the three collaborative-filtering functions behind /api/v1/recommendations/*.
--
-- 1. REGRESSION FROM 0912. All three declare RETURNS TABLE (..., name character varying, ...).
--    0912 changed ens_names.name to text, and PL/pgSQL RETURN QUERY needs an exact type match.
--    So every call now fails with
--      42804 "structure of query does not match function result type".
--    Function bodies are not tracked in pg_depend, so 0912's dependency check (which found the
--    12 trending_* matviews) could not see them. Fix: return name as text.
--
-- 2. Pre-existing bugs, fixed here because these functions are being recreated anyway:
--    - get_collectors_also_viewed casts viewer_identifier to INTEGER. Authenticated identifiers
--      are 'user:<id>' since 2025-11-04 (digits before that), so any name with a logged-in
--      co-viewer failed with 22P02. It now accepts both formats.
--    - get_similar_to_watchlist and get_recommendations_by_votes have failed on every call since
--      0240 with 42702 "column reference ens_name_id is ambiguous": the unqualified ens_name_id in
--      their NOT IN subquery collides with the ens_name_id output column.
--      Their logic also could never return a row: they joined only on names the target user already
--      watches/upvoted, then excluded exactly those names. They now find the users who share a
--      watched/upvoted name with the target, then recommend those users' OTHER names. Scores keep
--      their original meaning: the number of those users who watch/upvoted the candidate.
--
-- A return type can't be changed with CREATE OR REPLACE, so each function is dropped and recreated
-- in one transaction. Checked in prod 2026-11-19: nothing depends on them, the ACLs are the default
-- (NULL), and the owner is postgres. Their comments are re-added below. Signatures, argument names,
-- defaults and output column names are unchanged, so services/api/src/routes/recommendations.ts
-- needs no change.
--
-- Apply by hand (see CLAUDE.md "Schema source of truth"):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0913_recommendation_functions_name_text.sql

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- get_collectors_also_viewed: body identical to prod except the shared_viewers cast.
-- ---------------------------------------------------------------------------------------------
DROP FUNCTION public.get_collectors_also_viewed(integer, integer);

CREATE FUNCTION public.get_collectors_also_viewed(target_name_id integer, result_limit integer DEFAULT 10)
 RETURNS TABLE(ens_name_id integer, name text, also_viewed_count bigint, shared_viewers integer[])
 LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    nv2.ens_name_id,
    en.name,
    COUNT(DISTINCT nv2.viewer_identifier) as also_viewed_count,
    -- authenticated viewer_identifier is 'user:<id>' (or bare '<id>' before 2025-11-04); anything else -> NULL
    ARRAY_AGG(DISTINCT (regexp_match(nv2.viewer_identifier, '^(?:user:)?([0-9]+)$'))[1]::INTEGER
              ORDER BY (regexp_match(nv2.viewer_identifier, '^(?:user:)?([0-9]+)$'))[1]::INTEGER) as shared_viewers
  FROM public.name_views nv1
  JOIN public.name_views nv2 ON nv1.viewer_identifier = nv2.viewer_identifier
  JOIN public.ens_names en ON nv2.ens_name_id = en.id
  WHERE nv1.ens_name_id = target_name_id
    AND nv2.ens_name_id != target_name_id
    AND nv1.viewer_type = 'authenticated'
    AND nv2.viewer_type = 'authenticated'
  GROUP BY nv2.ens_name_id, en.name
  ORDER BY also_viewed_count DESC
  LIMIT result_limit;
END;
$function$;

COMMENT ON FUNCTION public.get_collectors_also_viewed(integer, integer) IS 'Get names that authenticated users who viewed a specific name also viewed (collaborative filtering)';

-- ---------------------------------------------------------------------------------------------
-- get_similar_to_watchlist
-- ---------------------------------------------------------------------------------------------
DROP FUNCTION public.get_similar_to_watchlist(integer, integer);

CREATE FUNCTION public.get_similar_to_watchlist(target_user_id integer, result_limit integer DEFAULT 10)
 RETURNS TABLE(ens_name_id integer, name text, similarity_score bigint, common_watchers integer)
 LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    w3.ens_name_id,
    en.name,
    COUNT(DISTINCT w3.user_id) as similarity_score,
    COUNT(DISTINCT w3.user_id)::INTEGER as common_watchers
  FROM (
    -- users who watch at least one name the target user watches
    SELECT DISTINCT w2.user_id
    FROM public.watchlist w1
    JOIN public.watchlist w2 ON w1.ens_name_id = w2.ens_name_id
    WHERE w1.user_id = target_user_id
      AND w2.user_id != target_user_id
  ) su
  JOIN public.watchlist w3 ON w3.user_id = su.user_id
  JOIN public.ens_names en ON w3.ens_name_id = en.id
  WHERE w3.ens_name_id NOT IN (
      SELECT w4.ens_name_id FROM public.watchlist w4 WHERE w4.user_id = target_user_id
    )
  GROUP BY w3.ens_name_id, en.name
  ORDER BY similarity_score DESC
  LIMIT result_limit;
END;
$function$;

COMMENT ON FUNCTION public.get_similar_to_watchlist(integer, integer) IS 'Get names watched by users with similar watchlists (collaborative filtering)';

-- ---------------------------------------------------------------------------------------------
-- get_recommendations_by_votes
-- ---------------------------------------------------------------------------------------------
DROP FUNCTION public.get_recommendations_by_votes(integer, integer);

CREATE FUNCTION public.get_recommendations_by_votes(target_user_id integer, result_limit integer DEFAULT 10)
 RETURNS TABLE(ens_name_id integer, name text, recommendation_score bigint, similar_voters integer)
 LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    nv3.ens_name_id,
    en.name,
    COUNT(DISTINCT nv3.user_id) as recommendation_score,
    COUNT(DISTINCT nv3.user_id)::INTEGER as similar_voters
  FROM (
    -- users who upvoted at least one name the target user upvoted
    SELECT DISTINCT nv2.user_id
    FROM public.name_votes nv1
    JOIN public.name_votes nv2 ON nv1.ens_name_id = nv2.ens_name_id
    WHERE nv1.user_id = target_user_id
      AND nv2.user_id != target_user_id
      AND nv1.vote = 1  -- Only consider upvotes
      AND nv2.vote = 1
  ) sv
  JOIN public.name_votes nv3 ON nv3.user_id = sv.user_id AND nv3.vote = 1
  JOIN public.ens_names en ON nv3.ens_name_id = en.id
  WHERE nv3.ens_name_id NOT IN (
      SELECT nv4.ens_name_id FROM public.name_votes nv4 WHERE nv4.user_id = target_user_id
    )
  GROUP BY nv3.ens_name_id, en.name
  ORDER BY recommendation_score DESC
  LIMIT result_limit;
END;
$function$;

COMMENT ON FUNCTION public.get_recommendations_by_votes(integer, integer) IS 'Get names upvoted by users with similar voting patterns (collaborative filtering)';

COMMIT;
