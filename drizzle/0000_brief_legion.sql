CREATE TABLE `songyin_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`kind` text NOT NULL,
	`prompt` text NOT NULL,
	`manifest` text NOT NULL,
	`state` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `songyin_sessions` (
	`owner` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`gpu` text NOT NULL,
	`endpoint` text,
	`kernel` text,
	`phase` text DEFAULT 'idle' NOT NULL,
	`settings` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_activity` integer NOT NULL,
	`message` text
);
