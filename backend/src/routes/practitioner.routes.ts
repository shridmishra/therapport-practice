import { Router } from 'express';
import { practitionerController } from '../controllers/practitioner.controller';
import { bookingController } from '../controllers/booking.controller';
import { subscriptionController } from '../controllers/subscription.controller';
import { authenticate } from '../middleware/auth.middleware';
import { checkMarketingAddon } from '../middleware/rbac.middleware';

const router = Router();

// All practitioner routes require authentication
router.get(
  '/dashboard',
  authenticate,
  practitionerController.getDashboard.bind(practitionerController)
);
router.get(
  '/kiosk/status',
  authenticate,
  practitionerController.getKioskStatus.bind(practitionerController)
);
router.post(
  '/kiosk/sign-out',
  authenticate,
  practitionerController.signOutFromKiosk.bind(practitionerController)
);
// Booking routes (merged to avoid dual mount at same path)
router.get('/bookings', authenticate, bookingController.getBookings.bind(bookingController));
router.get(
  '/bookings/availability',
  authenticate,
  bookingController.getAvailability.bind(bookingController)
);
router.get(
  '/bookings/calendar',
  authenticate,
  bookingController.getCalendar.bind(bookingController)
);
router.get('/bookings/quote', authenticate, bookingController.getQuote.bind(bookingController));
router.get('/bookings/:id', authenticate, bookingController.getBookingById.bind(bookingController));
router.post('/bookings', authenticate, bookingController.createBooking.bind(bookingController));
router.patch(
  '/bookings/:id',
  authenticate,
  bookingController.updateBooking.bind(bookingController)
);
router.delete(
  '/bookings/:id',
  authenticate,
  bookingController.cancelBooking.bind(bookingController)
);
router.get('/rooms', authenticate, bookingController.getRooms.bind(bookingController));
router.get('/credits', authenticate, bookingController.getCredits.bind(bookingController));
router.get('/invoices', authenticate, subscriptionController.getInvoices.bind(subscriptionController));

// Subscription routes (PR 8)
router.get(
  '/subscriptions/status',
  authenticate,
  subscriptionController.getStatus.bind(subscriptionController)
);
router.post(
  '/subscriptions/monthly',
  authenticate,
  subscriptionController.createMonthly.bind(subscriptionController)
);
router.post(
  '/subscriptions/ad-hoc',
  authenticate,
  subscriptionController.createAdHoc.bind(subscriptionController)
);
router.post(
  '/subscriptions/terminate',
  authenticate,
  subscriptionController.terminate.bind(subscriptionController)
);

router.post(
  '/documents/insurance/upload-url',
  authenticate,
  practitionerController.getInsuranceUploadUrl.bind(practitionerController)
);
router.put(
  '/documents/insurance/confirm',
  authenticate,
  practitionerController.confirmInsuranceUpload.bind(practitionerController)
);
router.get(
  '/documents/insurance',
  authenticate,
  practitionerController.getInsuranceDocument.bind(practitionerController)
);

// Clinical routes require authentication + marketing add-on
router.post(
  '/documents/clinical/upload-url',
  authenticate,
  checkMarketingAddon,
  practitionerController.getClinicalUploadUrl.bind(practitionerController)
);
router.put(
  '/documents/clinical/confirm',
  authenticate,
  checkMarketingAddon,
  practitionerController.confirmClinicalUpload.bind(practitionerController)
);
router.get(
  '/documents/clinical',
  authenticate,
  checkMarketingAddon,
  practitionerController.getClinicalDocument.bind(practitionerController)
);
router.post(
  '/clinical-executor',
  authenticate,
  checkMarketingAddon,
  practitionerController.createOrUpdateClinicalExecutor.bind(practitionerController)
);
router.get(
  '/clinical-executor',
  authenticate,
  checkMarketingAddon,
  practitionerController.getClinicalExecutor.bind(practitionerController)
);
router.get(
  '/reminders',
  authenticate,
  practitionerController.getReminders.bind(practitionerController)
);
router.get(
  '/transaction-history',
  authenticate,
  practitionerController.getTransactionHistory.bind(practitionerController)
);

export default router;
