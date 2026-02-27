import { Router } from 'express';
import { kioskController } from '../controllers/kiosk.controller';

const router = Router();

// Public kiosk endpoints (no auth) – used by mounted tablets
router.get('/locations', kioskController.getLocations.bind(kioskController));

router.get(
  '/:location/practitioners',
  kioskController.getPractitioners.bind(kioskController)
);

router.post('/:location/sign-in', kioskController.signIn.bind(kioskController));

router.post(
  '/:location/sign-out',
  kioskController.signOut.bind(kioskController)
);

export default router;

