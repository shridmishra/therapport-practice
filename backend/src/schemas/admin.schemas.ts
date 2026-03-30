import { z } from 'zod';
import { yyyyMmDdDateSchema } from './common.schemas';

export const setRecurringTerminationBodySchema = z.object({
  recurringTerminationDate: yyyyMmDdDateSchema.nullable(),
});
