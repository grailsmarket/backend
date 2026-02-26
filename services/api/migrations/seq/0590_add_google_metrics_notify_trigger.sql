-- Add NOTIFY trigger on google_metrics so WAL listener detects
-- inserts/updates and can re-index the corresponding ENS name in Elasticsearch.
CREATE TRIGGER google_metrics_notify
  AFTER INSERT OR UPDATE ON google_metrics
  FOR EACH ROW EXECUTE FUNCTION notify_changes();
