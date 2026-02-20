ALTER TABLE "bookings" ADD COLUMN "stripe_payment_intent_id" varchar(255);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bookings_stripe_payment_intent_id_idx" ON "bookings" USING btree ("stripe_payment_intent_id");