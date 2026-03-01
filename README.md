# Therapport Practice App

A practice management application for Therapport Limited, allowing practitioners to book meeting and therapy rooms, manage documents, and handle their practice operations.

## Project Structure

- `backend/` - Node.js/Express API server
- `frontend/` - React/Vite frontend application

Each can be deployed separately on Vercel.

## Tech Stack

### Backend
- Node.js with Express and TypeScript
- PostgreSQL with Drizzle ORM
- JWT authentication
- Nodemailer for email services

### Frontend
- React with TypeScript and Vite
- Tailwind CSS for styling
- React Router for navigation
- Light/Dark mode support

## Getting Started

### Backend Setup

1. Navigate to the backend directory:
```bash
cd backend
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file with the following variables:
```
DATABASE_URL=your_postgresql_connection_string
JWT_SECRET=your_jwt_secret
JWT_REFRESH_SECRET=your_refresh_secret
EMAIL_USER=your_gmail_address
EMAIL_PASSWORD=your_gmail_app_password
EMAIL_FROM=noreply@therapport.co.uk
FRONTEND_URL=http://localhost:5173
PORT=3000
```

4. Generate database migrations:
```bash
npm run db:generate
```

5. Run migrations:
```bash
npm run db:migrate
```

6. Start the development server:
```bash
npm run dev
```

### Frontend Setup

1. Navigate to the frontend directory:
```bash
cd frontend
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file:
```
VITE_API_URL=http://localhost:3000/api
```

4. Start the development server:
```bash
npm run dev
```

## Week 1 Deliverables

- ✅ Project structure (separate frontend and backend folders)
- ✅ Database schema with Drizzle ORM
- ✅ JWT-based authentication
- ✅ Password reset flow
- ✅ Email change with verification
- ✅ Role-based access control
- ✅ Practitioner signup with welcome email
- ✅ Responsive UI with light/dark mode
- ✅ Landing page
- ✅ Authentication pages (Login, Signup, Password Reset)

## Deployment

### Backend on Vercel
- Deploy from the `backend/` directory using the included `vercel.json`.
- Set environment variables in the Vercel dashboard (non‑exhaustive):
  - `DATABASE_URL`
  - `JWT_SECRET`
  - `JWT_REFRESH_SECRET`
  - `EMAIL_USER`, `EMAIL_PASSWORD`, `EMAIL_FROM`
  - `FRONTEND_URL` – the HTTPS URL of the deployed frontend (used for CORS).
- Build command: `npm run build`
- Start command: `npm start`

### Frontend on Vercel
- Deploy from the `frontend/` directory.
- Set environment variables (at minimum):
  - `VITE_API_URL` – the HTTPS URL of the backend API, e.g. `https://app.therapport.co.uk/api`.
- Vercel will auto‑detect the Vite configuration.

### Kiosk and Admin Presence

- **Kiosk URLs** (tablet‑friendly, no login required):
  - Pimlico kiosk: `/kiosk/pimlico`
  - Kensington kiosk: `/kiosk/kensington`
- **Admin “Who is in now”**:
  - Admin dashboard shows two boxes listing practitioners currently “In” at Pimlico and Kensington.
- **Kiosk Logs**:
  - Admin navigation includes “Kiosk Logs” with Kensington/Pimlico In‑Out tables backed by the `kiosk_logs` table.
- See `docs/kiosk-operations.md` for operational details.

## License

Proprietary - Therapport Limited.

_(Workflow test: small README edit.)_
