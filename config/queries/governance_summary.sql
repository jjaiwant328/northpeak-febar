-- Guarded policy-endpoint inference log. The AI Gateway on
-- jai-northpeak-guarded auto-captures every check_policy call into this
-- payload table — this is the governance panel's live data source on the
-- Platform page. NOTE: the table lives next to the endpoint (jai_tech),
-- not in the demo schema, so the charts route binds the catalog/schema
-- OVERRIDE for this key (see QUERY_FILES in server/routes/charts.ts).
-- @param catalog STRING = jai_tech
-- @param schema STRING = northpeak
SELECT
  CAST(COUNT(*) AS BIGINT) AS requests_total,
  CAST(SUM(CASE WHEN request_date = current_date() THEN 1 ELSE 0 END) AS BIGINT) AS requests_today,
  CAST(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS BIGINT) AS errors_total,
  CAST(COUNT(DISTINCT requester) AS BIGINT) AS requesters,
  CAST(ROUND(AVG(execution_duration_ms)) AS BIGINT) AS avg_latency_ms,
  CAST(MAX(request_time) AS STRING) AS last_call
FROM IDENTIFIER('`' || :catalog || '`.`' || :schema || '`.`jai_guarded_payload`')
