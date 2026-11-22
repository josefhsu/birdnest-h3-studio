CREATE TABLE `songyin_script_lab_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`draft` text NOT NULL,
	`published` text,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL
);
