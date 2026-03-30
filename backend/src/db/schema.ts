import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  date,
  time,
  decimal,
  pgEnum,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Enums
export const userRoleEnum = pgEnum('user_role', ['practitioner', 'admin']);
export const membershipTypeEnum = pgEnum('membership_type', ['permanent', 'ad_hoc']);
export const locationNameEnum = pgEnum('location_name', ['Pimlico', 'Kensington']);
export const bookingStatusEnum = pgEnum('booking_status', ['confirmed', 'cancelled', 'completed']);
export const bookingTypeEnum = pgEnum('booking_type', [
  'permanent_recurring',
  'ad_hoc',
  'free',
  'internal',
]);
export const documentTypeEnum = pgEnum('document_type', [
  'insurance',
  'clinical_registration',
  'reference',
]);
export const kioskActionEnum = pgEnum('kiosk_action', ['sign_in', 'sign_out']);
export const notificationStatusEnum = pgEnum('notification_status', ['pending', 'sent', 'failed']);
export const userStatusEnum = pgEnum('user_status', ['pending', 'active', 'suspended', 'rejected']);
export const subscriptionTypeEnum = pgEnum('subscription_type', ['monthly', 'ad_hoc']);
export const contractTypeEnum = pgEnum('contract_type', ['standard', 'recurring']);
export const recurringWeekdayEnum = pgEnum('recurring_weekday', [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
]);
export const recurringTimeBandEnum = pgEnum('recurring_time_band', ['morning', 'afternoon']);
export const creditSourceEnum = pgEnum('credit_source', [
  'monthly_subscription',
  'ad_hoc_subscription',
  'pay_difference',
  'manual',
]);
export const priceDayTypeEnum = pgEnum('price_day_type', ['weekday', 'weekend']);
export const priceTimeBandEnum = pgEnum('price_time_band', ['morning', 'afternoon', 'all_day']);
// Users table
export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    firstName: varchar('first_name', { length: 100 }).notNull(),
    lastName: varchar('last_name', { length: 100 }).notNull(),
    phone: varchar('phone', { length: 50 }),
    photoUrl: varchar('photo_url', { length: 500 }),
    role: userRoleEnum('role').notNull().default('practitioner'),
    status: userStatusEnum('status').notNull().default('active'),
    nextOfKin: jsonb('next_of_kin'),
    emailVerifiedAt: timestamp('email_verified_at'),
    deletedAt: timestamp('deleted_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => {
    return {
      emailIdx: index('users_email_idx').on(table.email),
    };
  }
);

// Memberships table
export const memberships = pgTable('memberships', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  type: membershipTypeEnum('type').notNull(),
  marketingAddon: boolean('marketing_addon').notNull().default(false),
  contractType: contractTypeEnum('contract_type').notNull().default('standard'),
  permanentSchedule: jsonb('permanent_schedule'),
  recurringStartDate: date('recurring_start_date'),
  recurringPractitionerName: varchar('recurring_practitioner_name', { length: 255 }),
  recurringWeekday: recurringWeekdayEnum('recurring_weekday'),
  recurringRoomId: uuid('recurring_room_id').references(() => rooms.id, { onDelete: 'set null' }),
  recurringTimeBand: recurringTimeBandEnum('recurring_time_band'),
  recurringTerminationDate: date('recurring_termination_date'),
  subscriptionType: subscriptionTypeEnum('subscription_type'),
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }),
  stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),
  subscriptionStartDate: date('subscription_start_date'),
  subscriptionEndDate: date('subscription_end_date'),
  terminationRequestedAt: timestamp('termination_requested_at'),
  suspensionDate: date('suspension_date'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Admin-managed pricing settings (single global row)
export const pricingSettings = pgTable('pricing_settings', {
  id: uuid('id').defaultRandom().primaryKey(),
  monthlySubscriptionGbp: decimal('monthly_subscription_gbp', { precision: 10, scale: 2 }).notNull(),
  adHocSubscriptionGbp: decimal('ad_hoc_subscription_gbp', { precision: 10, scale: 2 }).notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Hourly booking rates by location/day/time band
export const hourlyRates = pgTable(
  'hourly_rates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    locationName: locationNameEnum('location_name').notNull(),
    dayType: priceDayTypeEnum('day_type').notNull(),
    timeBand: priceTimeBandEnum('time_band').notNull(),
    rateGbp: decimal('rate_gbp', { precision: 10, scale: 2 }).notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    locationDayBandUnique: uniqueIndex('hourly_rates_location_day_band_unique').on(
      table.locationName,
      table.dayType,
      table.timeBand
    ),
  })
);

// Permanent slot monthly fees matrix
export const permanentSlotRates = pgTable(
  'permanent_slot_rates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    locationName: locationNameEnum('location_name').notNull(),
    roomGroup: varchar('room_group', { length: 100 }).notNull(),
    dayType: priceDayTypeEnum('day_type').notNull(),
    timeBand: priceTimeBandEnum('time_band').notNull(),
    monthlyFeeGbp: decimal('monthly_fee_gbp', { precision: 10, scale: 2 }).notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    locationGroupDayBandUnique: uniqueIndex('permanent_slot_rates_unique').on(
      table.locationName,
      table.roomGroup,
      table.dayType,
      table.timeBand
    ),
  })
);

// Locations table
export const locations = pgTable('locations', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: locationNameEnum('name').notNull().unique(),
  roomCount: decimal('room_count', { precision: 2, scale: 0 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Rooms table
export const rooms = pgTable('rooms', {
  id: uuid('id').defaultRandom().primaryKey(),
  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  roomNumber: decimal('room_number', { precision: 3, scale: 0 }).notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Bookings table
export const bookings = pgTable('bookings', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  roomId: uuid('room_id')
    .notNull()
    .references(() => rooms.id, { onDelete: 'cascade' }),
  membershipId: uuid('membership_id')
    .notNull()
    .references(() => memberships.id, { onDelete: 'cascade' }),
  bookingDate: date('booking_date').notNull(),
  startTime: time('start_time').notNull(),
  endTime: time('end_time').notNull(),
  pricePerHour: decimal('price_per_hour', { precision: 10, scale: 2 }).notNull(),
  totalPrice: decimal('total_price', { precision: 10, scale: 2 }).notNull(),
  creditUsed: decimal('credit_used', { precision: 10, scale: 2 }).notNull().default('0.00'),
  voucherHoursUsed: decimal('voucher_hours_used', { precision: 10, scale: 2 })
    .notNull()
    .default('0.00'),
  status: bookingStatusEnum('status').notNull().default('confirmed'),
  bookingType: bookingTypeEnum('booking_type').notNull(),
  stripePaymentIntentId: varchar('stripe_payment_intent_id', { length: 255 }),
  stripePaymentAmount: decimal('stripe_payment_amount', { precision: 10, scale: 2 }),
  cancelledAt: timestamp('cancelled_at'),
  cancellationReason: text('cancellation_reason'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Credit ledgers table
export const creditLedgers = pgTable('credit_ledgers', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  monthYear: date('month_year').notNull(),
  monthlyCredit: decimal('monthly_credit', { precision: 10, scale: 2 }).notNull().default('105.00'),
  usedCredit: decimal('used_credit', { precision: 10, scale: 2 }).notNull().default('0.00'),
  remainingCredit: decimal('remaining_credit', { precision: 10, scale: 2 })
    .notNull()
    .default('105.00'),
  isReset: boolean('is_reset').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Free booking vouchers table
export const freeBookingVouchers = pgTable('free_booking_vouchers', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  hoursAllocated: decimal('hours_allocated', { precision: 10, scale: 2 }).notNull(),
  hoursUsed: decimal('hours_used', { precision: 10, scale: 2 }).notNull().default('0.00'),
  expiryDate: date('expiry_date').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Credit transactions table (transaction-based credits with expiry)
export const creditTransactions = pgTable(
  'credit_transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
    usedAmount: decimal('used_amount', { precision: 10, scale: 2 }).notNull().default('0.00'),
    remainingAmount: decimal('remaining_amount', { precision: 10, scale: 2 }).notNull(),
    grantDate: date('grant_date').notNull(),
    expiryDate: date('expiry_date').notNull(),
    sourceType: creditSourceEnum('source_type').notNull(),
    sourceId: uuid('source_id'),
    description: text('description'),
    revoked: boolean('revoked').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('credit_transactions_user_id_idx').on(table.userId),
    expiryDateIdx: index('credit_transactions_expiry_date_idx').on(table.expiryDate),
    userSourceTypeIdIdx: index('credit_transactions_user_source_type_id_idx').on(
      table.userId,
      table.sourceType,
      table.sourceId
    ),
  })
);

// Documents table
export const documents = pgTable('documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  documentType: documentTypeEnum('document_type').notNull(),
  fileUrl: varchar('file_url', { length: 500 }).notNull(),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  expiryDate: date('expiry_date'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Clinical executors table
export const clinicalExecutors = pgTable('clinical_executors', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 50 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Kiosk logs table
export const kioskLogs = pgTable('kiosk_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id, { onDelete: 'cascade' }),
  action: kioskActionEnum('action').notNull(),
  actionTime: timestamp('action_time').notNull().defaultNow(),
  ipAddress: varchar('ip_address', { length: 45 }),
});

// Invoices table
export const invoices = pgTable('invoices', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  bookingId: uuid('booking_id').references(() => bookings.id, { onDelete: 'set null' }),
  invoiceNumber: varchar('invoice_number', { length: 100 }).notNull().unique(),
  amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
  invoiceDate: date('invoice_date').notNull(),
  fileUrl: varchar('file_url', { length: 500 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Email notifications table
export const emailNotifications = pgTable('email_notifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  notificationType: varchar('notification_type', { length: 100 }).notNull(),
  status: notificationStatusEnum('status').notNull().default('pending'),
  metadata: jsonb('metadata'),
  scheduledAt: timestamp('scheduled_at'),
  sentAt: timestamp('sent_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Password resets table
export const passwordResets = pgTable('password_resets', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: varchar('token', { length: 255 }).notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  used: boolean('used').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Email change requests table
export const emailChangeRequests = pgTable('email_change_requests', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  newEmail: varchar('new_email', { length: 255 }).notNull(),
  token: varchar('token', { length: 255 }).notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  verified: boolean('verified').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Relations
export const usersRelations = relations(users, ({ one, many }) => ({
  membership: one(memberships, {
    fields: [users.id],
    references: [memberships.userId],
  }),
  documents: many(documents),
  clinicalExecutor: one(clinicalExecutors, {
    fields: [users.id],
    references: [clinicalExecutors.userId],
  }),
  creditTransactions: many(creditTransactions),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  user: one(users, {
    fields: [memberships.userId],
    references: [users.id],
  }),
}));

export const documentsRelations = relations(documents, ({ one }) => ({
  user: one(users, {
    fields: [documents.userId],
    references: [users.id],
  }),
}));

export const clinicalExecutorsRelations = relations(clinicalExecutors, ({ one }) => ({
  user: one(users, {
    fields: [clinicalExecutors.userId],
    references: [users.id],
  }),
}));

export const creditTransactionsRelations = relations(creditTransactions, ({ one }) => ({
  user: one(users, {
    fields: [creditTransactions.userId],
    references: [users.id],
  }),
}));
