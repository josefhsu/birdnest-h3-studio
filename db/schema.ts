import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const jobs=sqliteTable('songyin_jobs',{id:text('id').primaryKey(),owner:text('owner').notNull(),kind:text('kind').notNull(),prompt:text('prompt').notNull(),manifest:text('manifest').notNull(),state:text('state').notNull().default('draft'),result:text('result'),createdAt:integer('created_at').notNull(),updatedAt:integer('updated_at').notNull()});
export const sessions=sqliteTable('songyin_sessions',{owner:text('owner').primaryKey(),requestId:text('request_id').notNull(),gpu:text('gpu').notNull(),endpoint:text('endpoint'),kernel:text('kernel'),phase:text('phase').notNull().default('idle'),settings:text('settings').notNull(),createdAt:integer('created_at').notNull(),lastActivity:integer('last_activity').notNull(),message:text('message')});

export const colabAuth=sqliteTable('songyin_colab_auth',{owner:text('owner').primaryKey(),credentials:text('credentials'),pending:text('pending'),email:text('email'),updatedAt:integer('updated_at').notNull()});
export const colabRuntime=sqliteTable('songyin_colab_runtime',{owner:text('owner').primaryKey(),nbh:text('nbh').notNull(),gpu:text('gpu').notNull(),phase:text('phase').notNull(),data:text('data').notNull(),settings:text('settings').notNull(),leaseUntil:integer('lease_until').notNull().default(0),updatedAt:integer('updated_at').notNull()});
export const creatorNetwork=sqliteTable('songyin_creator_network',{
  browser:text('browser').primaryKey().notNull(),
  primaryNetwork:text('primary_network').notNull(),
});

export const scriptLabEntries = sqliteTable('songyin_script_lab_entries', {
  id: text('id').primaryKey().notNull(),
  draft: text('draft').notNull(),
  published: text('published'),
  revision: integer('revision').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
