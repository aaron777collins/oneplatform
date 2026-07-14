-- Migration 006: change last_sync_job_id from UUID to TEXT
--
-- BullMQ assigns sequential integer IDs to jobs (e.g. "1", "2"), not UUIDs.
-- The original schema incorrectly declared this column as UUID, causing every
-- sync job to fail with "invalid input syntax for type uuid" when the worker
-- tried to persist the job ID.
ALTER TABLE ingestion.sync_state
  ALTER COLUMN last_sync_job_id TYPE TEXT;
