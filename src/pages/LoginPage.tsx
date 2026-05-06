import { useState } from 'react'
import { supabase } from '../lib/supabase'

type Step = 'phone' | 'otp'

export default function LoginPage() {
  const [step, setStep] = useState<Step>('phone')
  const [phone, setPhone] = useState('')
  const [otp, setOtp] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  function toE164(raw: string) {
    const digits = raw.replace(/\D/g, '')
    if (digits.startsWith('1') && digits.length === 11) return `+${digits}`
    if (digits.length === 10) return `+1${digits}`
    return `+${digits}`
  }

  async function handleSendOTP(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const e164 = toE164(phone)
    if (e164.replace(/\D/g, '').length < 11) {
      setError('Please enter a valid 10-digit phone number.')
      return
    }
    setLoading(true)
    const { error } = await supabase.auth.signInWithOtp({ phone: e164 })
    setLoading(false)
    if (error) { setError(error.message); return }
    setPhone(e164)
    setStep('otp')
  }

  async function handleVerifyOTP(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { data, error } = await supabase.auth.verifyOtp({ phone, token: otp, type: 'sms' })
    setLoading(false)
    if (error) { setError('Incorrect code. Try again.'); return }

    // Check if admin
    if (data.user) {
      const { data: profile } = await supabase
        .from('profiles').select('role').eq('id', data.user.id).single()
      if (profile?.role !== 'admin') {
        await supabase.auth.signOut()
        setError('Access denied. This dashboard is for M&G C&J staff only.')
      }
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.logo}>M&G C&J</div>
        <div style={styles.subtitle}>Dispatch Dashboard</div>

        {step === 'phone' ? (
          <form onSubmit={handleSendOTP} style={styles.form}>
            <label style={styles.label}>Phone number</label>
            <div style={styles.phoneRow}>
              <span style={styles.prefix}>🇨🇦 +1</span>
              <input
                style={styles.input}
                type="tel"
                placeholder="(902) 555-1234"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                autoFocus
              />
            </div>
            {error && <div style={styles.error}>{error}</div>}
            <button style={styles.btn} type="submit" disabled={loading}>
              {loading ? 'Sending…' : 'Send verification code'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerifyOTP} style={styles.form}>
            <label style={styles.label}>Enter the 6-digit code sent to {phone}</label>
            <input
              style={{ ...styles.input, letterSpacing: '0.3em', fontSize: '22px', textAlign: 'center' }}
              type="tel"
              placeholder="000000"
              value={otp}
              onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              autoFocus
              maxLength={6}
            />
            {error && <div style={styles.error}>{error}</div>}
            <button style={styles.btn} type="submit" disabled={loading}>
              {loading ? 'Verifying…' : 'Verify & log in'}
            </button>
            <button
              type="button"
              style={styles.backBtn}
              onClick={() => { setStep('phone'); setError(''); setOtp('') }}
            >
              ← Back
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh', background: '#111827',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: 'system-ui, sans-serif',
  },
  card: {
    background: '#1E2A3A', borderRadius: 20, padding: '40px 36px',
    width: '100%', maxWidth: 400,
    border: '0.5px solid rgba(255,255,255,0.08)',
  },
  logo: {
    fontSize: 32, fontWeight: 700, color: '#E8500A',
    letterSpacing: 1, marginBottom: 4, textAlign: 'center',
  },
  subtitle: {
    fontSize: 14, color: '#6B7280', textAlign: 'center', marginBottom: 32,
  },
  form: { display: 'flex', flexDirection: 'column', gap: 12 },
  label: { fontSize: 12, color: '#9CA3AF', fontWeight: 500 },
  phoneRow: {
    display: 'flex', background: '#111827', borderRadius: 10,
    border: '0.5px solid rgba(255,255,255,0.1)', overflow: 'hidden',
  },
  prefix: {
    padding: '12px 14px', fontSize: 15, color: '#CBD5E1',
    borderRight: '0.5px solid rgba(255,255,255,0.1)',
    display: 'flex', alignItems: 'center',
  },
  input: {
    flex: 1, background: '#111827', border: 'none', outline: 'none',
    padding: '12px 14px', fontSize: 15, color: '#F1F5F9',
    borderRadius: 10,
  },
  btn: {
    background: '#E8500A', color: '#fff', border: 'none',
    borderRadius: 10, padding: '13px', fontSize: 15, fontWeight: 600,
    cursor: 'pointer', marginTop: 4,
  },
  backBtn: {
    background: 'transparent', color: '#6B7280', border: 'none',
    fontSize: 13, cursor: 'pointer', textAlign: 'center' as const, padding: 4,
  },
  error: {
    background: 'rgba(226,75,74,0.1)', color: '#F87171',
    borderRadius: 8, padding: '8px 12px', fontSize: 13,
    border: '0.5px solid rgba(226,75,74,0.25)',
  },
}
