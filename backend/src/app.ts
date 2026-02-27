import dotenv from 'dotenv';
// Load environment variables first
dotenv.config();

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import authRoutes from './routes/auth.routes';
import practitionerRoutes from './routes/practitioner.routes';
import adminRoutes from './routes/admin.routes';
import cronRoutes from './routes/cron.routes';
import stripeWebhookRoutes from './routes/stripe-webhook.routes';
import kioskRoutes from './routes/kiosk.routes';
import { errorHandler } from './middleware/error.middleware';
import cron from 'node-cron';
import { cronController } from './controllers/cron.controller';
const app = express();
const PORT = process.env.PORT || 3000;

// Test database connection on startup
(async () => {
  try {
    const { Pool } = await import('pg');
    const testPool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
    await testPool.query('SELECT NOW()');
    await testPool.end();
    console.log('✅ Database connection verified');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
  }
})();

// Middleware
// CORS - Restrict in production, open in development
if (process.env.NODE_ENV === 'production') {
  const allowedOrigin = process.env.FRONTEND_URL;
  app.use(
    cors({
      origin: allowedOrigin ? [allowedOrigin] : '*',
      credentials: false,
    })
  );
} else {
  app.use(
    cors({
      origin: '*',
      credentials: false,
    })
  );
}

// HTTP request logger
app.use(
  morgan(
    process.env.NODE_ENV === 'production'
      ? 'combined' // Apache combined log format for production
      : 'dev' // Colored output for development
  )
);

// Stripe webhook must receive raw body for signature verification; mount before express.json()
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhookRoutes);

app.use(express.json({ limit: '15mb' })); // Increased limit for base64 image uploads (14MB max)
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Health check endpoint
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    database: 'unknown',
  };

  // Check database connection
  try {
    const { Pool } = await import('pg');
    const testPool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
    await testPool.query('SELECT NOW()');
    await testPool.end();
    health.database = 'connected';
  } catch (error) {
    health.database = 'disconnected';
    health.status = 'degraded';
  }

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/practitioner', practitionerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/cron', cronRoutes);
app.use('/api/kiosk', kioskRoutes);

// Error handling
app.use(errorHandler);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 CORS enabled for: all origins (*)`);
});

// Setup node-cron for Linux servers (only if not on Vercel)
// Vercel uses its own cron system via vercel.json
// Note: node-cron is optional - install with: npm install node-cron @types/node-cron
if (process.env.NODE_ENV === 'production' && !process.env.VERCEL) {
  (async () => {
    try {
      // Schedule reminder processing every day at midnight (document reminders + 48h booking reminders)
      cron.schedule('0 0 * * *', async () => {
        try {
          const docResult = await cronController.processRemindersInternal();
          const bookingResult = await cronController.processBookingRemindersInternal();
          const suspensionResult = await cronController.processSuspensionInternal();
          console.log('✅ Cron job executed successfully:', {
            documentReminders: docResult,
            bookingReminders: bookingResult,
            suspension: suspensionResult,
          });
        } catch (error) {
          console.error('❌ Cron job error:', error);
        }
      });

      console.log(
        '✅ node-cron scheduled for reminder + suspension (document + 48h booking + suspension, daily at midnight)'
      );
    } catch (error) {
      console.error('❌ Failed to setup node-cron:', error);
    }
  })();
}

export default app;
