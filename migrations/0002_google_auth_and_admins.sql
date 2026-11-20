CREATE TABLE admins (
  email TEXT PRIMARY KEY NOT NULL,
  added_by TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE google_login_attempts (
  state_hash TEXT PRIMARY KEY NOT NULL,
  nonce TEXT NOT NULL,
  verifier TEXT NOT NULL,
  pages_challenge TEXT,
  date TEXT,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX google_login_attempts_expiry ON google_login_attempts (expires_at);
--> statement-breakpoint
ALTER TABLE pages_sessions ADD COLUMN channel TEXT NOT NULL DEFAULT 'pages' CHECK (channel IN ('pages', 'site'));
