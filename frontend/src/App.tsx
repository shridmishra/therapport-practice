import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Landing } from './pages/Landing';
import { Login } from './pages/auth/Login';
import { Signup } from './pages/auth/Signup';
import { ForgotPassword } from './pages/auth/ForgotPassword';
import { ResetPassword } from './pages/auth/ResetPassword';
import { VerifyEmailChange } from './pages/auth/VerifyEmailChange';
import { Dashboard } from './pages/Dashboard';
import { Bookings } from './pages/Bookings';
import { Subscription } from './pages/Subscription';
import { Profile } from './pages/Profile';
import { Finance } from './pages/Finance';
import { AdminDashboard } from './pages/admin/AdminDashboard';
import { PractitionerManagement } from './pages/admin/PractitionerManagement';
import { AdminCalendar } from './pages/admin/AdminCalendar';
import { AdminProfile } from './pages/admin/AdminProfile';
import { AdminKioskLogs } from './pages/admin/AdminKioskLogs';
import { AdminPrices } from './pages/admin/AdminPrices';
import { KioskPage } from './pages/kiosk/KioskPage';
import './styles/globals.css';

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/verify-email-change" element={<VerifyEmailChange />} />
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute practitionerOnly>
                  <Dashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/bookings"
              element={
                <ProtectedRoute practitionerOnly>
                  <Bookings />
                </ProtectedRoute>
              }
            />
            <Route
              path="/subscription"
              element={
                <ProtectedRoute practitionerOnly>
                  <Subscription />
                </ProtectedRoute>
              }
            />
            <Route
              path="/finance"
              element={
                <ProtectedRoute practitionerOnly>
                  <Finance />
                </ProtectedRoute>
              }
            />
            <Route
              path="/profile"
              element={
                <ProtectedRoute practitionerOnly>
                  <Profile />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin"
              element={
                <ProtectedRoute requiredRole="admin">
                  <AdminDashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/practitioners"
              element={
                <ProtectedRoute requiredRole="admin">
                  <PractitionerManagement />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/calendar"
              element={
                <ProtectedRoute requiredRole="admin">
                  <AdminCalendar />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/profile"
              element={
                <ProtectedRoute requiredRole="admin">
                  <AdminProfile />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/prices"
              element={
                <ProtectedRoute requiredRole="admin">
                  <AdminPrices />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/kiosk-logs"
              element={
                <ProtectedRoute requiredRole="admin">
                  <AdminKioskLogs />
                </ProtectedRoute>
              }
            />
            <Route path="/kiosk/pimlico" element={<KioskPage location="Pimlico" />} />
            <Route path="/kiosk/kensington" element={<KioskPage location="Kensington" />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
