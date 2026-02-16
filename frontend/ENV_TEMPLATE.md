# Environment Variables Template

## Development

Create a `.env` file in the frontend directory:

```
VITE_API_URL=http://localhost:3000/api
VITE_STRIPE_PUBLISHABLE_KEY=pk_test_your-stripe-publishable-key
```

The Vite proxy in `vite.config.ts` will handle `/api` requests in development.

## Production (Vercel)

1. Go to your Vercel project settings
2. Navigate to "Environment Variables"
3. Add the following variables:
   - **Name**: `VITE_API_URL`
     - **Value**: Your deployed backend URL (e.g., `https://your-backend.vercel.app/api`)
     - **Environment**: Production, Preview, Development (as needed)
   - **Name**: `VITE_STRIPE_PUBLISHABLE_KEY`
     - **Value**: Your Stripe publishable key (e.g., `pk_test_...` for test mode or `pk_live_...` for production)
     - **Environment**: Production, Preview, Development (as needed)
     - **Note**: Must match the mode (test/live) of your backend `STRIPE_SECRET_KEY`

**Important**:

- The Vite proxy in `vite.config.ts` only works in development (`npm run dev`)
- In production on Vercel, the frontend makes direct API calls using `VITE_API_URL`
- Make sure your backend CORS settings allow requests from your frontend domain

## Stripe Setup

For payment processing (ad-hoc subscriptions and pay-the-difference bookings):

1. Get your **Publishable key** from the Stripe Dashboard (Developers → API keys)
2. Use the **Publishable key** (e.g., `pk_test_...` for test mode or `pk_live_...` for production) as `VITE_STRIPE_PUBLISHABLE_KEY`
3. **Important**: The publishable key mode (test/live) must match your backend `STRIPE_SECRET_KEY` mode
4. This key is used by the frontend to initialize Stripe.js for embedded payment forms (PaymentModal component)
