import { z } from 'zod';
import { yyyyMmDdDateSchema } from './common.schemas';

export const recurringSlotSchema = z.object({
  startDate: yyyyMmDdDateSchema,
  practitionerName: z.string().min(1).max(255),
  weekday: z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']),
  roomId: z.string().uuid(),
  timeBand: z.enum(['morning', 'afternoon']),
});
