import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider } from './AuthContext'
import { useAuth } from './useAuth'
import { SiteHeader } from '../components/SiteHeader'
import { AdminPage } from '../pages/AdminPage'
import { AuthPage } from '../pages/AuthPage'
import { BookingPage } from '../pages/BookingPage'
import { DashboardPage } from '../pages/DashboardPage'
import { DirectoryPage } from '../pages/DirectoryPage'
import { HomePage } from '../pages/HomePage'
import { OnboardingPage } from '../pages/OnboardingPage'
import { TherapistPage } from '../pages/TherapistPage'
import { TherapistWorkspacePage } from '../pages/TherapistWorkspacePage'
import { isSupabaseConfigured } from '../lib/supabase'
import type { UserRole } from '../lib/types'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false },
  },
})

function BackendNotice() {
  return (
    <main className="setup-notice">
      <div className="setup-card">
        <span className="eyebrow">Setup required</span>
        <h1>Connect your MindBridge workspace</h1>
        <p>
          The application is ready, but the live backend has not been configured. Add your
          Supabase project URL and public anon key to <code>.env.local</code>, then apply the
          database migration.
        </p>
        <a className="button button-primary" href="/#getting-started">
          View setup guidance
        </a>
      </div>
    </main>
  )
}

function Protected({
  children,
  roles,
}: {
  children: React.ReactNode
  roles?: UserRole[]
}) {
  const { user, profile, loading, error, refreshProfile } = useAuth()
  const location = useLocation()
  if (!isSupabaseConfigured) return <BackendNotice />
  if (loading) return <div className="page-loading">Preparing your secure workspace…</div>
  if (!user) return <Navigate to="/sign-in" replace />
  if (error) {
    return (
      <main className="container section">
        <section className="setup-card">
          <span className="eyebrow">Account setup needs attention</span>
          <h1>We couldn't load your account.</h1>
          <p>
            The signed-in account is valid, but MindBridge could not read its profile from the
            database. If the platform database has not been installed, apply the migration
            described in the README, then try again.
          </p>
          <p className="form-error" role="alert">{error}</p>
          <button type="button" className="button button-primary" onClick={() => void refreshProfile()}>
            Retry account loading
          </button>
        </section>
      </main>
    )
  }
  if (!profile) return <Navigate to="/onboarding" replace />
  if (!profile.onboarding_completed && location.pathname !== '/onboarding') return <Navigate to="/onboarding" replace />
  if (roles && !roles.includes(profile.role)) return <Navigate to="/dashboard" replace />
  return <>{children}</>
}

function DashboardRoute() {
  const { profile } = useAuth()
  if (profile?.role === 'therapist') return <Navigate to="/therapist" replace />
  if (profile?.role === 'admin') return <Navigate to="/admin" replace />
  return <DashboardPage />
}

function ApplicationRoutes() {
  return (
    <>
      <SiteHeader />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/sign-in" element={isSupabaseConfigured ? <AuthPage /> : <BackendNotice />} />
        <Route path="/sign-up" element={isSupabaseConfigured ? <AuthPage /> : <BackendNotice />} />
        <Route
          path="/onboarding"
          element={
            <Protected>
              <OnboardingPage />
            </Protected>
          }
        />
        <Route
          path="/dashboard"
          element={
            <Protected>
              <DashboardRoute />
            </Protected>
          }
        />
        <Route
          path="/therapists"
          element={
            <Protected roles={['client']}>
              <DirectoryPage />
            </Protected>
          }
        />
        <Route
          path="/therapists/:therapistId"
          element={
            <Protected roles={['client']}>
              <TherapistPage />
            </Protected>
          }
        />
        <Route
          path="/book/:therapistId/:slotId"
          element={
            <Protected roles={['client']}>
              <BookingPage />
            </Protected>
          }
        />
        <Route
          path="/therapist"
          element={
            <Protected roles={['therapist']}>
              <TherapistWorkspacePage />
            </Protected>
          }
        />
        <Route
          path="/admin"
          element={
            <Protected roles={['admin']}>
              <AdminPage />
            </Protected>
          }
        />
        <Route path="*" element={<main className="container section"><h1>Page not found</h1><a href="/">Return home</a></main>} />
      </Routes>
    </>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <ApplicationRoutes />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
