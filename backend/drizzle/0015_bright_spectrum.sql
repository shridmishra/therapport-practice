DO $$ BEGIN
 CREATE TYPE "price_day_type" AS ENUM('weekday', 'weekend');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "price_time_band" AS ENUM('morning', 'afternoon', 'all_day');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hourly_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_name" "location_name" NOT NULL,
	"day_type" "price_day_type" NOT NULL,
	"time_band" "price_time_band" NOT NULL,
	"rate_gbp" numeric(10, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "permanent_slot_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_name" "location_name" NOT NULL,
	"room_group" varchar(100) NOT NULL,
	"day_type" "price_day_type" NOT NULL,
	"time_band" "price_time_band" NOT NULL,
	"monthly_fee_gbp" numeric(10, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pricing_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monthly_subscription_gbp" numeric(10, 2) NOT NULL,
	"ad_hoc_subscription_gbp" numeric(10, 2) NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hourly_rates_location_day_band_unique" ON "hourly_rates" ("location_name","day_type","time_band");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "permanent_slot_rates_unique" ON "permanent_slot_rates" ("location_name","room_group","day_type","time_band");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pricing_settings" ADD CONSTRAINT "pricing_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
INSERT INTO "pricing_settings" ("monthly_subscription_gbp", "ad_hoc_subscription_gbp")
SELECT 105.00, 150.00
WHERE NOT EXISTS (SELECT 1 FROM "pricing_settings");
--> statement-breakpoint
INSERT INTO "hourly_rates" ("location_name", "day_type", "time_band", "rate_gbp")
VALUES
  ('Kensington', 'weekday', 'morning', 19.00),
  ('Kensington', 'weekday', 'afternoon', 23.00),
  ('Kensington', 'weekend', 'all_day', 14.00),
  ('Pimlico', 'weekday', 'morning', 15.00),
  ('Pimlico', 'weekday', 'afternoon', 20.00),
  ('Pimlico', 'weekend', 'all_day', 13.00)
ON CONFLICT ("location_name", "day_type", "time_band") DO UPDATE
SET
  "rate_gbp" = EXCLUDED."rate_gbp",
  "updated_at" = now();
--> statement-breakpoint
INSERT INTO "permanent_slot_rates" ("location_name", "room_group", "day_type", "time_band", "monthly_fee_gbp")
VALUES
  ('Kensington', 'rooms_1_3_4_5', 'weekday', 'morning', 244.45),
  ('Kensington', 'rooms_1_3_4_5', 'weekday', 'afternoon', 325.94),
  ('Kensington', 'room_2_6', 'weekday', 'morning', 253.15),
  ('Kensington', 'room_2_6', 'weekday', 'afternoon', 337.54),
  ('Kensington', 'rooms_1_6', 'weekend', 'morning', 188.47),
  ('Kensington', 'rooms_1_6', 'weekend', 'afternoon', 188.47),
  ('Pimlico', 'room_a', 'weekday', 'morning', 157.75),
  ('Pimlico', 'room_a', 'weekday', 'afternoon', 210.33),
  ('Pimlico', 'rooms_bcd', 'weekday', 'morning', 210.00),
  ('Pimlico', 'rooms_bcd', 'weekday', 'afternoon', 280.00),
  ('Pimlico', 'room_a', 'weekend', 'morning', 185.71),
  ('Pimlico', 'room_a', 'weekend', 'afternoon', 185.71),
  ('Pimlico', 'rooms_bcd', 'weekend', 'morning', 185.71),
  ('Pimlico', 'rooms_bcd', 'weekend', 'afternoon', 185.71)
ON CONFLICT ("location_name", "room_group", "day_type", "time_band") DO UPDATE
SET
  "monthly_fee_gbp" = EXCLUDED."monthly_fee_gbp",
  "updated_at" = now();
