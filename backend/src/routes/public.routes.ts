import { Router } from 'express';
import { publicController } from '../controllers/public.controller';

const router = Router();

router.get('/rooms', publicController.getRooms.bind(publicController));
router.get('/availability', publicController.getAvailability.bind(publicController));
router.get('/prices', publicController.getPrices.bind(publicController));

export default router;
