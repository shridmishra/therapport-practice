import { z } from 'zod';

/** YYYY-MM-DD string validated as a real UTC calendar date. */
export const yyyyMmDdDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) => {
      const [yearPart, monthPart, dayPart] = value.split('-');
      const year = Number(yearPart);
      const month = Number(monthPart);
      const day = Number(dayPart);
      const parsedDate = new Date(Date.UTC(year, month - 1, day));
      return (
        parsedDate.getUTCFullYear() === year &&
        parsedDate.getUTCMonth() + 1 === month &&
        parsedDate.getUTCDate() === day
      );
    },
    { message: 'Must be a valid calendar date in YYYY-MM-DD format' }
  );
