import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { supabase } from "../lib/supabase";

type Step = "email" | "otp";

export default function LoginPage() {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Deliberately loose. The authoritative check is email_is_dispatch() one line
  // below and GoTrue's own validation after it; this only catches a typed
  // fragment before it costs a round trip.
  function looksLikeEmail(value: string) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
  }

  async function handleSendOTP(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const address = email.trim().toLowerCase();
    if (!looksLikeEmail(address)) {
      setError(t("login.invalidEmail"));
      return;
    }
    setLoading(true);

    // Only send a code to addresses that belong to a dispatch account (admin or
    // dispatcher). email_is_dispatch() is SECURITY DEFINER so it works without a
    // session. If the check itself errors, fall through and send anyway — App.tsx
    // still gates access post-login, so we fail open rather than lock out staff.
    const { data: isDispatch, error: checkError } = await supabase.rpc(
      "email_is_dispatch",
      { p_email: address },
    );
    if (checkError) {
      console.error("[Login] dispatch check error:", checkError);
    } else if (!isDispatch) {
      setLoading(false);
      setError(t("login.notDispatch"));
      return;
    }

    // shouldCreateUser: false is load-bearing, not tidiness. Staff accounts are
    // provisioned by vellon-ops; letting the login screen mint one would create
    // an auth user with a bare profiles row and no company — the same half-made
    // account the four-week registration outage produced.
    const { error } = await supabase.auth.signInWithOtp({
      email: address,
      options: { shouldCreateUser: false },
    });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setEmail(address);
    setStep("otp");
  }

  async function handleVerifyOTP(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    // type "email" is the emailed-code channel. It is NOT interchangeable with
    // "magiclink" (that one takes the hashed token out of a link), even though
    // the same template can carry both.
    const { error } = await supabase.auth.verifyOtp({
      email,
      token: otp,
      type: "email",
    });
    setLoading(false);
    if (error) {
      setError(t("login.badCode"));
      return;
    }
    // Role gating happens in App.tsx via useAuth's profile fetch, which is
    // the single source of truth for this — no separate check needed here.
  }

  return (
    <>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Inter', system-ui, sans-serif; }

        .login-page {
          min-height: 100vh;
          background: var(--c-bg);
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
          /* Was an indigo glow, i.e. a wash. The card carries the page now. */
          background: none;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          pointer-events: none;
        }

        .login-card {
          position: relative;
          background: var(--c-surface);
          border-radius: 20px;
          padding: 44px 40px;
          width: 100%;
          max-width: 400px;
          border: 1px solid var(--c-border);
          box-shadow: 0 24px 64px var(--c-shadow);
        }

        .login-wordmark {
          display: flex;
          align-items: baseline;
          gap: 6px;
          justify-content: center;
          margin-bottom: 6px;
        }

        .login-brand {
          font-family: 'Rajdhani', system-ui, sans-serif;
          font-size: 40px;
          font-weight: 700;
          color: var(--c-text);
          letter-spacing: 0.1em;
          text-transform: uppercase;
        }

        .login-subtitle {
          font-size: 13px;
          color: var(--c-text-2);
          text-align: center;
          margin-bottom: 36px;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          font-weight: 500;
        }

        .login-rule {
          width: 40px;
          height: 1px;
          background: var(--c-border-strong);
          margin: 0 auto 36px;
        }

        .login-form {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }

        .login-label {
          font-size: 11px;
          color: var(--c-text-2);
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          margin-bottom: 6px;
          display: block;
        }

        .login-field {
          display: flex;
          background: var(--c-input);
          border-radius: 10px;
          border: 1px solid var(--c-border);
          overflow: hidden;
          transition: border-color 0.15s;
        }

        .login-field:focus-within {
          border-color: var(--c-brand);
        }

        .login-input {
          flex: 1;
          background: transparent;
          border: none;
          outline: none;
          padding: 13px 14px;
          font-size: 15px;
          color: var(--c-text);
          font-family: 'Inter', system-ui, sans-serif;
        }

        .login-input::placeholder { color: var(--c-text-3); }

        .login-otp-input {
          width: 100%;
          background: var(--c-input);
          border: 1px solid var(--c-border);
          border-radius: 10px;
          outline: none;
          padding: 16px;
          font-size: 28px;
          color: var(--c-text);
          font-family: 'Inter', system-ui, sans-serif;
          text-align: center;
          letter-spacing: 0.35em;
          font-weight: 600;
          transition: border-color 0.15s;
        }

        .login-otp-input:focus {
          border-color: var(--c-brand);
        }

        .login-hint {
          font-size: 12px;
          color: var(--c-text-2);
          text-align: center;
          line-height: 1.5;
        }

        .login-hint strong {
          color: var(--c-text-2);
          font-weight: 500;
        }

        .login-btn {
          background: var(--c-brand-fill);
          color: var(--c-on-brand);
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

        .login-btn:hover:not(:disabled) { background: var(--c-brand-fill-hover); }
        .login-btn:active:not(:disabled) { transform: scale(0.99); }
        .login-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .login-back-btn {
          background: transparent;
          color: var(--c-text-2);
          border: none;
          font-size: 13px;
          cursor: pointer;
          text-align: center;
          padding: 4px;
          font-family: 'Inter', system-ui, sans-serif;
          transition: color 0.15s;
        }

        .login-back-btn:hover { color: var(--c-text); }

        .login-error {
          background: var(--c-surface-alt);
          color: var(--c-red);
          border-radius: 8px;
          padding: 10px 14px;
          font-size: 13px;
          border: 1px solid var(--c-border);
          line-height: 1.4;
        }

        .login-footer {
          margin-top: 28px;
          padding-top: 20px;
          border-top: 1px solid var(--c-border);
          text-align: center;
          font-size: 12px;
          color: var(--c-text-2);
          letter-spacing: 0.04em;
        }
      `}</style>

      <div className="login-page">
        <div className="login-bg-glow" />
        <div className="login-card">
          <div className="login-wordmark">
            {/* A brand name is not copy; translating it is how a product
                acquires two names. */}
            {/* i18n-ok */}
            <span className="login-brand">Vellon</span>
          </div>
          <div className="login-subtitle">{t("login.subtitle")}</div>
          <div className="login-rule" />

          {step === "email" ? (
            <form onSubmit={handleSendOTP} className="login-form">
              <div>
                <label className="login-label">{t("login.emailLabel")}</label>
                <div className="login-field">
                  <input
                    className="login-input"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    placeholder={t("login.emailPlaceholder")}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoFocus
                  />
                </div>
              </div>
              {error && <div className="login-error">{error}</div>}
              <button className="login-btn" type="submit" disabled={loading}>
                {loading ? t("login.sending") : t("login.send")}
              </button>
            </form>
          ) : (
            <form onSubmit={handleVerifyOTP} className="login-form">
              <div>
                <label className="login-label">{t("login.codeLabel")}</label>
                <input
                  className="login-otp-input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
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
                {/* <Trans> rather than two interpolated halves: the bold span
                    is INSIDE the sentence, and French may not place it where
                    English does. Splitting the string around the markup bakes
                    English word order into the component. */}
                <Trans
                  i18nKey="login.codeSentTo"
                  values={{ email }}
                  components={{ s: <strong /> }}
                />
              </div>
              {error && <div className="login-error">{error}</div>}
              <button className="login-btn" type="submit" disabled={loading}>
                {loading ? t("login.verifying") : t("login.verify")}
              </button>
              <button
                type="button"
                className="login-back-btn"
                onClick={() => {
                  setStep("email");
                  setError("");
                  setOtp("");
                }}
              >
                {t("login.useDifferent")}
              </button>
            </form>
          )}

          <div className="login-footer">{t("login.footer")}</div>
        </div>
      </div>
    </>
  );
}
