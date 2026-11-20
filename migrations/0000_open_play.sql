CREATE TABLE sessions (
  date TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  location TEXT,
  proposed_by TEXT NOT NULL,
  reviewed_by TEXT,
  CHECK (status <> 'confirmed' OR (location IS NOT NULL AND length(trim(location)) > 0))
);
--> statement-breakpoint

CREATE TABLE signups (
  date TEXT NOT NULL REFERENCES sessions(date) ON DELETE CASCADE,
  member TEXT NOT NULL,
  PRIMARY KEY (date, member)
);
