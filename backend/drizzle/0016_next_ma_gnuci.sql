DO $$ BEGIN
 CREATE TYPE "contract_type" AS ENUM('standard', 'recurring');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "recurring_time_band" AS ENUM('morning', 'afternoon');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "recurring_weekday" AS ENUM('monday', 'tuesday', 'wednesday', 'thursday', 'friday');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "contract_type" "contract_type" DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "recurring_start_date" date;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "recurring_practitioner_name" varchar(255);--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "recurring_weekday" "recurring_weekday";--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "recurring_room_id" uuid;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "recurring_time_band" "recurring_time_band";--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "recurring_termination_date" date;