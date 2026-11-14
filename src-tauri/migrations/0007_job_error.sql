-- Persist the terminal error of a job so the Export Center can show the
-- real cause after the transient job://finished event is gone (restart,
-- missed listener). Additive: NULL for rows that predate this column.
ALTER TABLE jobs ADD COLUMN error TEXT;
