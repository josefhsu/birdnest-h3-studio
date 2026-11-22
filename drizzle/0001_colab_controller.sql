CREATE TABLE songyin_colab_auth (owner TEXT PRIMARY KEY NOT NULL, credentials TEXT, pending TEXT, email TEXT, updated_at INTEGER NOT NULL);
--> statement-breakpoint
CREATE TABLE songyin_colab_runtime (owner TEXT PRIMARY KEY NOT NULL, nbh TEXT NOT NULL, gpu TEXT NOT NULL, phase TEXT NOT NULL, data TEXT NOT NULL, settings TEXT NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
--> statement-breakpoint
ALTER TABLE songyin_jobs ADD COLUMN result TEXT;
