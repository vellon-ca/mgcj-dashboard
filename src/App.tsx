import { useEffect, useState } from 'react'
import { useAuth } from './hooks/useAuth'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'

export default function App() {
  const { session, profile, companyName, loading, signOut } = useAuth()
  const [stuck, setStuck] = useState(false)

  useEffect(() => {
    if (!loading) {
      setStuck(false)
      return
    }
    const t = setTimeout(() => setStuck(true), 8000)
    return () => clearTimeout(t)
  }, [loading])

  if (loading) return (
    <div style={{
      minHeight: '100vh', background: '#0A1628',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      fontFamily: "'Inter', system-ui, sans-serif", color: '#E8500A', fontSize: 16, gap: 14,
    }}>
      <div>Loading…</div>
      {stuck && (
        <>
          <div style={{ color: '#6B7280', fontSize: 13 }}>Taking longer than usual.</div>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: '#E8500A', color: '#fff', border: 'none', borderRadius: 8,
              padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </>
      )}
    </div>
  )

  if (!session || !profile) return <LoginPage />

  if (profile.role !== 'admin' && profile.role !== 'dispatcher') return (
    <div style={{
      minHeight: '100vh', background: '#111827',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{
        background: '#1E2A3A', borderRadius: 16, padding: '40px 36px',
        textAlign: 'center', border: '0.5px solid rgba(255,255,255,0.08)',
      }}>
        <div style={{ fontSize: 32, fontWeight: 700, color: '#E8500A', marginBottom: 8 }}>{companyName ?? 'M&G C&J'}</div>
        <div style={{ color: '#F87171', marginBottom: 16 }}>Access denied. Staff only.</div>
        <button
          style={{ background: 'transparent', color: '#6B7280', border: 'none', cursor: 'pointer' }}
          onClick={() => signOut()}
        >
          Sign out
        </button>
      </div>
    </div>
  )

  if (!profile.is_active) return (
    <div style={{
      minHeight: '100vh', background: '#111827',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{
        background: '#1E2A3A', borderRadius: 16, padding: '40px 36px',
        textAlign: 'center', border: '0.5px solid rgba(255,255,255,0.08)', maxWidth: 360,
      }}>
        <div style={{ fontSize: 32, fontWeight: 700, color: '#E8500A', marginBottom: 8 }}>{companyName ?? 'M&G C&J'}</div>
        <div style={{ color: '#F87171', marginBottom: 4 }}>Your account has been deactivated.</div>
        <div style={{ color: '#6B7280', fontSize: 13, marginBottom: 16 }}>Contact an admin at your company to restore access.</div>
        <button
          style={{ background: 'transparent', color: '#6B7280', border: 'none', cursor: 'pointer' }}
          onClick={() => signOut()}
        >
          Sign out
        </button>
      </div>
    </div>
  )

  return (
    <DashboardPage
      profile={profile}
      companyName={companyName}
      onSignOut={() => signOut()}
    />
  )
}
