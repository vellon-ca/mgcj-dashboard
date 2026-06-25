import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";

interface Props {
  companyId: string;
}

type Section = "pricing";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "pricing", label: "Pricing" },
];

export default function SettingsPage({ companyId }: Props) {
  const [section, setSection] = useState<Section>("pricing");

  // Pricing state
  const [baseFare, setBaseFare] = useState("");
  const [ratePerKm, setRatePerKm] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("companies")
      .select("base_fare, rate_per_km")
      .eq("id", companyId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setBaseFare(String(data.base_fare ?? 4));
          setRatePerKm(String(data.rate_per_km ?? 1.8));
        }
        setLoading(false);
      });
  }, [companyId]);

  async function save() {
    setError(null);
    setSaved(false);
    const base = parseFloat(baseFare);
    const rate = parseFloat(ratePerKm);
    if (isNaN(base) || base < 0) { setError("Base fare must be a valid number."); return; }
    if (isNaN(rate) || rate < 0) { setError("Rate per km must be a valid number."); return; }
    setSaving(true);
    const { error: err } = await supabase
      .from("companies")
      .update({ base_fare: base, rate_per_km: rate })
      .eq("id", companyId);
    setSaving(false);
    if (err) { setError(err.message); return; }
    setSaved(true);
  }

  return (
    <>
      <style>{`
        .st-wrap { display: flex; height: 100%; overflow: hidden; font-family: system-ui, -apple-system, sans-serif; }
        .st-panel { width: 200px; background: #0F1723; border-right: 1px solid rgba(255,255,255,0.06); display: flex; flex-direction: column; flex-shrink: 0; padding: 16px 0; }
        .st-panel-title { font-size: 10px; font-weight: 600; color: #374151; letter-spacing: 0.09em; text-transform: uppercase; padding: 0 16px 10px; }
        .st-section-btn { display: flex; align-items: center; width: 100%; height: 38px; padding: 0 16px; background: none; border: none; border-left: 2px solid transparent; font-size: 13px; font-weight: 500; color: #4B5563; cursor: pointer; text-align: left; transition: background 0.12s, color 0.12s, border-color 0.12s; font-family: system-ui, sans-serif; }
        .st-section-btn:hover { background: rgba(255,255,255,0.04); color: #9CA3AF; }
        .st-section-btn.active { border-left-color: #E8500A; background: rgba(232,80,10,0.07); color: #E8500A; }
        .st-content { flex: 1; overflow-y: auto; padding: 24px 32px; background: #111827; }
        .st-content::-webkit-scrollbar { width: 4px; }
        .st-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }

        .st-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; gap: 16px; }
        .st-title { font-size: 18px; font-weight: 700; color: #F1F5F9; margin-bottom: 4px; }
        .st-subtitle { font-size: 13px; color: #6B7280; line-height: 1.5; max-width: 480px; }

        .st-card { background: #1E2A3A; border-radius: 12px; padding: 20px; margin-bottom: 16px; border: 1px solid rgba(255,255,255,0.05); max-width: 520px; }
        .st-card-label { font-size: 11px; font-weight: 600; color: #4B5563; text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 16px; }

        .st-field-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
        .st-field-row:last-of-type { margin-bottom: 0; }
        .st-field-text { display: flex; flex-direction: column; gap: 2px; }
        .st-field-label { font-size: 14px; font-weight: 600; color: #E2E8F0; }
        .st-field-hint { font-size: 12px; color: #6B7280; }
        .st-input-wrap { display: flex; align-items: center; background: #111827; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; overflow: hidden; }
        .st-prefix { padding: 0 10px; font-size: 13px; font-weight: 600; color: #4B5563; border-right: 1px solid rgba(255,255,255,0.08); height: 36px; display: flex; align-items: center; }
        .st-suffix { padding: 0 10px; font-size: 12px; color: #4B5563; border-left: 1px solid rgba(255,255,255,0.08); height: 36px; display: flex; align-items: center; }
        .st-input { width: 80px; background: none; border: none; outline: none; color: #F1F5F9; font-size: 14px; font-weight: 600; padding: 0 10px; height: 36px; font-family: system-ui, sans-serif; text-align: right; }

        .st-divider { height: 1px; background: rgba(255,255,255,0.05); margin: 14px 0; }

        .st-save-btn { background: #E8500A; color: #fff; border: none; border-radius: 9px; padding: 10px 20px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s, opacity 0.12s; white-space: nowrap; }
        .st-save-btn:hover:not(:disabled) { background: #D6470B; }
        .st-save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .st-save-btn.st-saved { background: rgba(29,158,117,0.12); color: #1D9E75; }
        .st-error { font-size: 12px; color: #F87171; margin-top: 10px; }
      `}</style>

      <div className="st-wrap">
        <div className="st-panel">
          <p className="st-panel-title">Settings</p>
          {SECTIONS.map(s => (
            <button
              key={s.id}
              className={`st-section-btn${section === s.id ? " active" : ""}`}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="st-content">
          {section === "pricing" && (
            <>
              <div className="st-header">
                <div>
                  <div className="st-title">Pricing</div>
                  <div className="st-subtitle">
                    Fare estimates shown to passengers: <strong style={{ color: "#E2E8F0" }}>base fare + (km × rate)</strong>
                  </div>
                </div>
                <button
                  className={`st-save-btn${saved ? " st-saved" : ""}`}
                  onClick={save}
                  disabled={saving || loading}
                >
                  {saving ? "Saving…" : saved ? "Saved ✓" : "Save"}
                </button>
              </div>

              {loading ? (
                <div style={{ color: "#4B5563", fontSize: 14 }}>Loading…</div>
              ) : (
                <div className="st-card">
                  <p className="st-card-label">Fare formula</p>

                  <div className="st-field-row">
                    <div className="st-field-text">
                      <span className="st-field-label">Base fare</span>
                      <span className="st-field-hint">Flat fee at the start of every ride</span>
                    </div>
                    <div className="st-input-wrap">
                      <span className="st-prefix">$</span>
                      <input
                        className="st-input"
                        type="number"
                        min="0"
                        step="0.25"
                        value={baseFare}
                        onChange={e => { setBaseFare(e.target.value); setSaved(false); }}
                      />
                    </div>
                  </div>

                  <div className="st-divider" />

                  <div className="st-field-row">
                    <div className="st-field-text">
                      <span className="st-field-label">Rate per km</span>
                      <span className="st-field-hint">Applied to the routed distance</span>
                    </div>
                    <div className="st-input-wrap">
                      <span className="st-prefix">$</span>
                      <input
                        className="st-input"
                        type="number"
                        min="0"
                        step="0.05"
                        value={ratePerKm}
                        onChange={e => { setRatePerKm(e.target.value); setSaved(false); }}
                      />
                      <span className="st-suffix">/km</span>
                    </div>
                  </div>

                  {error && <p className="st-error">{error}</p>}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
