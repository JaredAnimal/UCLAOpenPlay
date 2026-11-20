CREATE TABLE pages_sessions (
  credential_hash TEXT PRIMARY KEY NOT NULL,
  challenge TEXT,
  user_id TEXT NOT NULL,
  member TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX pages_sessions_expiry ON pages_sessions (expires_at);
