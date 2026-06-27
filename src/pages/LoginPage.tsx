import { useState } from "react";
import { supabase } from "../lib/supabase";

type Step = "phone" | "otp";

export default function LoginPage() {
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function formatPhoneDisplay(value: string): string {
    const digits = value.replace(/\D/g, "").slice(0, 10);
    if (digits.length <= 3) return digits.length ? `(${digits}` : "";
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  function toE164(raw: string) {
    const digits = raw.replace(/\D/g, "");
    if (digits.startsWith("1") && digits.length === 11) return `+${digits}`;
    if (digits.length === 10) return `+1${digits}`;
    return `+${digits}`;
  }

  async function handleSendOTP(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const e164 = toE164(phone);
    if (e164.replace(/\D/g, "").length < 11) {
      setError("Enter a valid 10-digit phone number.");
      return;
    }
    setLoading(true);
    const { error } = await supabase.auth.signInWithOtp({ phone: e164 });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setPhone(e164);
    setStep("otp");
  }

  async function handleVerifyOTP(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const { data, error } = await supabase.auth.verifyOtp({
      phone,
      token: otp,
      type: "sms",
    });
    setLoading(false);
    if (error) {
      setError("Incorrect code. Try again.");
      return;
    }
    if (data.user) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", data.user.id)
        .single();
      if (profile?.role !== "admin") {
        await supabase.auth.signOut();
        setError("Access denied. This dashboard is for M&G C&J staff only.");
      }
    }
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Inter', system-ui, sans-serif; }

        .login-page {
          min-height: 100vh;
          background: #0A1628;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: 'Inter', system-ui, sans-serif;
          position: relative;
          overflow: hidden;
        }

        .login-bg-glow {
          position: absolute;
          width: 600px;
          height: 600px;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(232,80,10,0.06) 0%, transparent 70%);
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          pointer-events: none;
        }

        .login-card {
          position: relative;
          background: #0F1F35;
          border-radius: 20px;
          padding: 44px 40px;
          width: 100%;
          max-width: 400px;
          border: 1px solid rgba(255,255,255,0.06);
          box-shadow: 0 24px 64px rgba(0,0,0,0.4);
        }

        .login-wordmark {
          display: flex;
          align-items: baseline;
          gap: 6px;
          justify-content: center;
          margin-bottom: 6px;
        }

        .login-brand {
          font-size: 28px;
          font-weight: 700;
          color: #E8500A;
          letter-spacing: -0.5px;
        }

        .login-divider-dot {
          width: 4px;
          height: 4px;
          border-radius: 50%;
          background: rgba(232,80,10,0.4);
          margin-bottom: 3px;
        }

        .login-subtitle {
          font-size: 13px;
          color: #4A6080;
          text-align: center;
          margin-bottom: 36px;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          font-weight: 500;
        }

        .login-rule {
          width: 40px;
          height: 1px;
          background: rgba(232,80,10,0.3);
          margin: 0 auto 36px;
        }

        .login-form {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }

        .login-label {
          font-size: 11px;
          color: #4A6080;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          margin-bottom: 6px;
          display: block;
        }

        .login-field {
          display: flex;
          background: #0A1628;
          border-radius: 10px;
          border: 1px solid rgba(255,255,255,0.06);
          overflow: hidden;
          transition: border-color 0.15s;
        }

        .login-field:focus-within {
          border-color: rgba(232,80,10,0.4);
        }

        .login-prefix {
          padding: 13px 14px;
          font-size: 14px;
          color: #4A6080;
          border-right: 1px solid rgba(255,255,255,0.06);
          display: flex;
          align-items: center;
          gap: 6px;
          white-space: nowrap;
          font-weight: 500;
        }

        .login-input {
          flex: 1;
          background: transparent;
          border: none;
          outline: none;
          padding: 13px 14px;
          font-size: 15px;
          color: #F1F5F9;
          font-family: 'Inter', system-ui, sans-serif;
        }

        .login-input::placeholder { color: #2A3F58; }

        .login-otp-input {
          width: 100%;
          background: #0A1628;
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 10px;
          outline: none;
          padding: 16px;
          font-size: 28px;
          color: #F1F5F9;
          font-family: 'Inter', system-ui, sans-serif;
          text-align: center;
          letter-spacing: 0.35em;
          font-weight: 600;
          transition: border-color 0.15s;
        }

        .login-otp-input:focus {
          border-color: rgba(232,80,10,0.4);
        }

        .login-hint {
          font-size: 12px;
          color: #2A3F58;
          text-align: center;
          line-height: 1.5;
        }

        .login-hint strong {
          color: #4A6080;
          font-weight: 500;
        }

        .login-btn {
          background: #E8500A;
          color: #fff;
          border: none;
          border-radius: 10px;
          padding: 14px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          font-family: 'Inter', system-ui, sans-serif;
          letter-spacing: 0.01em;
          transition: opacity 0.15s, transform 0.1s;
          margin-top: 2px;
        }

        .login-btn:hover:not(:disabled) { opacity: 0.9; }
        .login-btn:active:not(:disabled) { transform: scale(0.99); }
        .login-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .login-back-btn {
          background: transparent;
          color: #4A6080;
          border: none;
          font-size: 13px;
          cursor: pointer;
          text-align: center;
          padding: 4px;
          font-family: 'Inter', system-ui, sans-serif;
          transition: color 0.15s;
        }

        .login-back-btn:hover { color: #94A3B8; }

        .login-error {
          background: rgba(226,75,74,0.08);
          color: #F87171;
          border-radius: 8px;
          padding: 10px 14px;
          font-size: 13px;
          border: 1px solid rgba(226,75,74,0.2);
          line-height: 1.4;
        }

        .login-footer {
          margin-top: 28px;
          padding-top: 20px;
          border-top: 1px solid rgba(255,255,255,0.04);
          text-align: center;
          font-size: 11px;
          color: #1E3352;
          letter-spacing: 0.04em;
        }
      `}</style>

      <div className="login-page">
        <div className="login-bg-glow" />
        <div className="login-card">
          <div className="login-wordmark">
            <span className="login-brand">M&amp;G</span>
            <div className="login-divider-dot" />
            <span className="login-brand">C&amp;J</span>
          </div>
          <div className="login-subtitle">Dispatch Dashboard</div>
          <div className="login-rule" />

          {step === "phone" ? (
            <form onSubmit={handleSendOTP} className="login-form">
              <div>
                <label className="login-label">Phone number</label>
                <div className="login-field">
                  <span className="login-prefix">🇨🇦 +1</span>
                  <input
                    className="login-input"
                    type="tel"
                    placeholder="(902) 555-1234"
                    value={phone}
                    onChange={(e) => setPhone(formatPhoneDisplay(e.target.value))}
                    autoFocus
                  />
                </div>
              </div>
              {error && <div className="login-error">{error}</div>}
              <button className="login-btn" type="submit" disabled={loading}>
                {loading ? "Sending…" : "Send verification code"}
              </button>
            </form>
          ) : (
            <form onSubmit={handleVerifyOTP} className="login-form">
              <div>
                <label className="login-label">Verification code</label>
                <input
                  className="login-otp-input"
                  type="tel"
                  placeholder="——————"
                  value={otp}
                  onChange={(e) =>
                    setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  autoFocus
                  maxLength={6}
                />
              </div>
              <div className="login-hint">
                Code sent to <strong>{phone}</strong>
              </div>
              {error && <div className="login-error">{error}</div>}
              <button className="login-btn" type="submit" disabled={loading}>
                {loading ? "Verifying…" : "Verify & sign in"}
              </button>
              <button
                type="button"
                className="login-back-btn"
                onClick={() => {
                  setStep("phone");
                  setError("");
                  setOtp("");
                }}
              >
                ← Use a different number
              </button>
            </form>
          )}

          <div className="login-footer">M&amp;G Cab Ltd · C&amp;J Taxi Ltd</div>
        </div>
      </div>
    </>
  );
}
