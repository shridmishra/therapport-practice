import { Request, Response } from 'express';
import { z } from 'zod';
import * as PublicService from '../services/public.service';
import { logger } from '../utils/logger.util';

const locationSchema = z.object({
  location: z.enum(['Pimlico', 'Kensington']),
});

export class PublicController {
  private handleControllerError(error: unknown, res: Response, context: string) {
    if (error instanceof z.ZodError) {
      const details = error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
        code: issue.code,
      }));
      const message =
        error.issues.map((issue) => issue.message).join(', ') || 'Invalid request';
      return res.status(400).json({
        success: false,
        error: message,
        details,
      });
    }

    logger.error(`Public controller error in ${context}`, error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }

  async getRooms(req: Request, res: Response) {
    try {
      const { location } = locationSchema.parse(req.query);
      const data = await PublicService.getPublicRooms(location);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return this.handleControllerError(error, res, 'getRooms');
    }
  }

  async getAvailability(req: Request, res: Response) {
    try {
      const { location } = locationSchema.parse(req.query);
      const data = await PublicService.getPublicAvailability(location);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return this.handleControllerError(error, res, 'getAvailability');
    }
  }

  async getPrices(req: Request, res: Response) {
    try {
      const { location } = locationSchema.parse(req.query);
      const data = await PublicService.getPublicPrices(location);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return this.handleControllerError(error, res, 'getPrices');
    }
  }
}

export const publicController = new PublicController();
