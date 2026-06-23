-- ============================================================
-- Migration: 003_schedule_depends_on
-- Pipeline Service — add depends_on to pipeline.schedules
--
-- The schedule repository and ScheduleRow type carry a
-- depends_on field (pipeline IDs that must complete before the
-- schedule fires), but 001_initial_schema created the schedules
-- table without it. The cron scheduler SELECTs this column on
-- every tick, so its absence fails every poll. Add it here.
--
-- Stored as JSONB to mirror input_template — the repository
-- writes it via JSON.stringify and reads it as a JS array.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'pipeline'
       AND table_name   = 'schedules'
       AND column_name  = 'depends_on'
  ) THEN
    ALTER TABLE pipeline.schedules
      ADD COLUMN depends_on JSONB NOT NULL DEFAULT '[]';
  END IF;
END;
$$;
