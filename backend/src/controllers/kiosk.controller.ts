import { Request, Response } from 'express';
import { KioskService } from '../services/kiosk.service';
import { logger } from '../utils/logger.util';

export class KioskController {
  async getLocations(req: Request, res: Response) {
    try {
      const locations = await KioskService.getLocations();
      res.status(200).json({ success: true, data: locations });
    } catch (error) {
      logger.error('Failed to get kiosk locations', error, {
        method: req.method,
        url: req.originalUrl,
      });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async getPractitioners(req: Request, res: Response) {
    try {
      const { location: locationParam } = req.params;
      if (!locationParam) {
        return res
          .status(400)
          .json({ success: false, error: 'Location is required' });
      }

      const locationName = KioskService.normalizeLocationParam(locationParam);
      const { location, practitioners } =
        await KioskService.getPractitionersForLocation(locationName);

      res.status(200).json({
        success: true,
        data: {
          location,
          practitioners,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Internal server error';

      if (
        error instanceof Error &&
        message.startsWith('Invalid location.')
      ) {
        return res.status(400).json({ success: false, error: message });
      }

      logger.error('Failed to get kiosk practitioners', error, {
        method: req.method,
        url: req.originalUrl,
        location: req.params.location,
      });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async signIn(req: Request, res: Response) {
    try {
      const { location: locationParam } = req.params;
      const { userId } = req.body as { userId?: string };

      if (!locationParam) {
        return res
          .status(400)
          .json({ success: false, error: 'Location is required' });
      }
      if (!userId) {
        return res
          .status(400)
          .json({ success: false, error: 'userId is required' });
      }

      const locationName = KioskService.normalizeLocationParam(locationParam);
      await KioskService.signIn(userId, locationName, req.ip);

      const { location, practitioners } =
        await KioskService.getPractitionersForLocation(locationName);

      res.status(200).json({
        success: true,
        data: {
          location,
          practitioners,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Internal server error';

      if (message.startsWith('Invalid location.')) {
        return res.status(400).json({ success: false, error: message });
      }

      if (message === 'Practitioner not found or not active') {
        return res.status(404).json({ success: false, error: message });
      }

      logger.error('Failed to sign in via kiosk', error, {
        method: req.method,
        url: req.originalUrl,
        location: req.params.location,
        body: req.body,
      });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  async signOut(req: Request, res: Response) {
    try {
      const { location: locationParam } = req.params;
      const { userId } = req.body as { userId?: string };

      if (!locationParam) {
        return res
          .status(400)
          .json({ success: false, error: 'Location is required' });
      }
      if (!userId) {
        return res
          .status(400)
          .json({ success: false, error: 'userId is required' });
      }

      const locationName = KioskService.normalizeLocationParam(locationParam);
      await KioskService.signOut(userId, locationName, req.ip);

      const { location, practitioners } =
        await KioskService.getPractitionersForLocation(locationName);

      res.status(200).json({
        success: true,
        data: {
          location,
          practitioners,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Internal server error';

      if (message.startsWith('Invalid location.')) {
        return res.status(400).json({ success: false, error: message });
      }

      logger.error('Failed to sign out via kiosk', error, {
        method: req.method,
        url: req.originalUrl,
        location: req.params.location,
        body: req.body,
      });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}

export const kioskController = new KioskController();

