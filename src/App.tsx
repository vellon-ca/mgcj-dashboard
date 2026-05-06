import { useAuth } from './hooks/useAuth'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'

export default function App() {
  const { session, profile, loading } = useAuth()

  if (loading) return (
    <div style={{
      minHeight: '100vh', background: '#111827',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'system-ui, sans-serif', color: '#E8500A', fontSize: 16,
    }}>
      Loading…
    </div>
  )

  if (!session || !profile) return <LoginPage />

  if (profile.role !== 'admin') return (
    <div style={{
      minHeight: '100vh', background: '#111827',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{
        background: '#1E2A3A', borderRadius: 16, padding: '40px 36px',
        textAlign: 'center', border: '0.5px solid rgba(255,255,255,0.08)',
      }}>
        <div style={{ fontSize: 32, fontWeight: 700, color: '#E8500A', marginBottom: 8 }}>M&G C&J</div>
        <div style={{ color: '#F87171', marginBottom: 16 }}>Access denied. Staff only.</div>
        <button
          style={{ background: 'transparent', color: '#6B7280', border: 'none', cursor: 'pointer' }}
          onClick={() => import('./lib/supabase').then(({ supabase }) => supabase.auth.signOut())}
        >
          Sign out
        </button>
      </div>
    </div>
  )

  return (
    <DashboardPage
      profile={profile}
      onSignOut={() => import('./lib/supabase').then(({ supabase }) => supabase.auth.signOut())}
    />
  )
}
