CREATE TABLE members (
  email TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL
);
--> statement-breakpoint
DELETE FROM pages_sessions;
