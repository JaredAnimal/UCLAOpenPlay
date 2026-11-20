ALTER TABLE sessions ADD COLUMN start_hour INTEGER;
--> statement-breakpoint
ALTER TABLE sessions ADD COLUMN end_hour INTEGER;
--> statement-breakpoint
ALTER TABLE signups ADD COLUMN name TEXT;
--> statement-breakpoint
ALTER TABLE pages_sessions ADD COLUMN name TEXT;
