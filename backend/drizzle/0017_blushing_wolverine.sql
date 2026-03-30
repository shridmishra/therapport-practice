DO $$ BEGIN
 ALTER TABLE "memberships" ADD CONSTRAINT "memberships_recurring_room_id_rooms_id_fk" FOREIGN KEY ("recurring_room_id") REFERENCES "rooms"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
