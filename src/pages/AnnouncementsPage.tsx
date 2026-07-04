import { useState, useEffect, useRef } from "react";
import { supabase } from "../lib/supabase";
import { logDispatchEvent } from "../lib/logDispatchEvent";

interface MessageRow {
  id: string;
  category: "announcement" | "offer";
  target_type: "all_passengers" | "all_drivers";
  display_mode: "inbox" | "interstitial";
  title: string;
  body: string;
  image_url: string | null;
  expires_at: string | null;
  created_at: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  announcement: "Announcement",
  offer: "Offer",
};
const CATEGORY_COLORS: Record<string, string> = {
  announcement: "#60A5FA",
  offer: "#E8500A",
};
const AUDIENCE_LABELS: Record<string, string> = {
  all_passengers: "Passengers",
  all_drivers: "Drivers",
};

const EMPTY_FORM = {
  audience: "all_passengers" as "all_passengers" | "all_drivers",
  category: "announcement" as "announcement" | "offer",
  display_mode: "inbox" as "inbox" | "interstitial",
  title: "",
  body: "",
  expires_at: "",
};

interface Props {
  companyId: string;
  adminId: string;
}

export default function AnnouncementsPage({ companyId, adminId }: Props) {
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [audienceFilter, setAudienceFilter] = useState<"all" | "all_passengers" | "all_drivers">("all");
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const interstitialLimit = imageFile ? 90 : 280;

  useEffect(() => {
    fetchMessages();
  }, [companyId]);

  async function fetchMessages() {
    setLoading(true);
    try {
      const { data } = await supabase
        .from("messages")
        .select("id, category, target_type, display_mode, title, body, image_url, expires_at, created_at")
        .eq("company_id", companyId)
        .in("target_type", ["all_passengers", "all_drivers"])
        .order("created_at", { ascending: false })
        .limit(100);
      setMessages(data ?? []);
    } finally {
      setLoading(false);
    }
  }

  function pickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
    if (form.display_mode === "interstitial") {
      setForm((f) => ({ ...f, body: f.body.slice(0, 90) }));
    }
  }

  function clearImage() {
    setImageFile(null);
    setImagePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function sendMessage() {
    if (!form.title.trim() || !form.body.trim()) {
      setError("Title and message are required.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      let imageUrl: string | null = null;
      if (imageFile) {
        const ext = imageFile.name.split(".").pop() ?? "jpg";
        const path = `${companyId}/${crypto.randomUUID()}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from("message-images")
          .upload(path, imageFile, { contentType: imageFile.type, upsert: true });
        if (uploadError) throw uploadError;
        imageUrl = supabase.storage.from("message-images").getPublicUrl(path).data.publicUrl;
      }

      const { error: insertError } = await supabase.from("messages").insert({
        company_id: companyId,
        sender_id: adminId,
        category: form.category,
        target_type: form.audience,
        display_mode: form.display_mode,
        title: form.title.trim(),
        body: form.body.trim(),
        image_url: imageUrl,
        expires_at: form.expires_at ? new Date(form.expires_at).toISOString() : null,
      });
      if (insertError) throw insertError;

      logDispatchEvent({
        companyId,
        dispatcherId: adminId,
        eventType: form.audience === "all_drivers" ? "announcement.drivers" : "announcement.passengers",
        details: {
          category: form.category,
          display_mode: form.display_mode,
          title: form.title.trim(),
          has_image: !!imageUrl,
        },
      });

      setForm((f) => ({ ...EMPTY_FORM, audience: f.audience }));
      clearImage();
      await fetchMessages();
    } catch (e: any) {
      setError(e.message ?? "Failed to send message.");
    } finally {
      setSending(false);
    }
  }

  const filteredMessages = messages.filter(
    (m) => audienceFilter === "all" || m.target_type === audienceFilter,
  );
  const groupedByDate: { date: string; items: MessageRow[] }[] = [];
  for (const m of filteredMessages) {
    const dateLabel = new Date(m.created_at).toLocaleDateString("en-CA", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    const lastGroup = groupedByDate[groupedByDate.length - 1];
    if (lastGroup && lastGroup.date === dateLabel) {
      lastGroup.items.push(m);
    } else {
      groupedByDate.push({ date: dateLabel, items: [m] });
    }
  }

  return (
    <>
      <style>{`
        .mp-wrap { display: flex; height: 100%; overflow: hidden; font-family: system-ui, -apple-system, sans-serif; }

        .mp-compose { width: 340px; flex-shrink: 0; background: #0F1723; border-right: 1px solid rgba(255,255,255,0.06); padding: 20px; overflow-y: auto; }
        .mp-compose-title { font-size: 14px; font-weight: 700; color: #F1F5F9; margin-bottom: 16px; }

        .mp-field { margin-bottom: 14px; }
        .mp-label { font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; display: block; }
        .mp-input, .mp-textarea { width: 100%; background: #1E2A3A; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 9px 11px; color: #E2E8F0; font-size: 13px; font-family: system-ui, sans-serif; }
        .mp-input:focus, .mp-textarea:focus { outline: none; border-color: #E8500A; }
        .mp-textarea { resize: vertical; min-height: 80px; }

        .mp-toggle-row { display: flex; gap: 8px; }
        .mp-toggle-btn { flex: 1; padding: 8px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; text-align: center; background: #1E2A3A; border: 1px solid rgba(255,255,255,0.08); color: #6B7280; transition: all 0.12s; }
        .mp-toggle-btn.active { background: rgba(232,80,10,0.12); border-color: #E8500A; color: #E8500A; }

        .mp-image-picker { border: 1px dashed rgba(255,255,255,0.15); border-radius: 8px; padding: 12px; text-align: center; cursor: pointer; }
        .mp-image-preview { width: 100%; border-radius: 8px; margin-bottom: 8px; max-height: 140px; object-fit: cover; }
        .mp-image-remove { font-size: 11px; color: #F87171; cursor: pointer; background: none; border: none; padding: 0; margin-top: 6px; }

        .mp-error { font-size: 12px; color: #F87171; margin-bottom: 10px; }
        .mp-char-count { font-size: 11px; color: #6B7280; margin-top: 6px; }
        .mp-char-count.over { color: #F59E0B; }

        .mp-send-btn { width: 100%; padding: 10px; border-radius: 8px; background: #E8500A; color: #fff; border: none; font-size: 13px; font-weight: 700; cursor: pointer; margin-top: 6px; }
        .mp-send-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .mp-content { flex: 1; overflow-y: auto; padding: 24px; background: #111827; }
        .mp-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
        .mp-title { font-size: 18px; font-weight: 700; color: #F1F5F9; }
        .mp-subtitle-text { font-size: 12px; color: #6B7280; }

        .mp-filter-row { display: flex; gap: 6px; margin-bottom: 20px; }
        .mp-filter-btn { padding: 5px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; cursor: pointer; background: #1E2A3A; border: 1px solid rgba(255,255,255,0.08); color: #6B7280; transition: all 0.12s; }
        .mp-filter-btn.active { background: rgba(232,80,10,0.12); border-color: #E8500A; color: #E8500A; }

        .mp-date-heading { font-size: 11px; font-weight: 700; color: #6B7280; text-transform: uppercase; letter-spacing: 0.06em; margin: 20px 0 10px; }
        .mp-date-heading:first-child { margin-top: 0; }

        .mp-card { background: #1E2A3A; border-radius: 12px; padding: 16px; margin-bottom: 8px; border: 1px solid rgba(255,255,255,0.05); }
        .mp-card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
        .mp-badges { display: flex; gap: 6px; flex-wrap: wrap; }
        .mp-badge { font-size: 10px; font-weight: 600; padding: 3px 8px; border-radius: 20px; white-space: nowrap; }
        .mp-badge-audience { background: rgba(168,85,247,0.1); color: #A855F7; }
        .mp-badge-mode { background: rgba(255,255,255,0.06); color: #9CA3AF; }
        .mp-badge-expired { background: rgba(248,113,113,0.1); color: #F87171; }
        .mp-card-date { font-size: 11px; color: #6B7280; }
        .mp-card-title { font-size: 14px; font-weight: 600; color: #E2E8F0; margin-bottom: 6px; }
        .mp-card-body { font-size: 13px; color: #6B7280; white-space: pre-wrap; }
        .mp-card-image { width: 100%; max-width: 280px; border-radius: 8px; margin-top: 10px; }
        .mp-card-expiry { font-size: 11px; color: #6B7280; margin-top: 8px; }

        .mp-empty { color: #6B7280; font-size: 14px; text-align: center; padding: 60px 0; }
        .mp-loading { color: #6B7280; text-align: center; padding: 60px; font-size: 14px; }
      `}</style>

      <div className="mp-wrap">
        <div className="mp-compose">
          <div className="mp-compose-title">New announcement</div>

          {error && <div className="mp-error">{error}</div>}

          <div className="mp-field">
            <label className="mp-label">Audience</label>
            <div className="mp-toggle-row">
              <button
                className={`mp-toggle-btn${form.audience === "all_passengers" ? " active" : ""}`}
                onClick={() => setForm((f) => ({ ...f, audience: "all_passengers" }))}
              >
                All passengers
              </button>
              <button
                className={`mp-toggle-btn${form.audience === "all_drivers" ? " active" : ""}`}
                onClick={() =>
                  setForm((f) => ({ ...f, audience: "all_drivers", category: "announcement" }))
                }
              >
                All drivers
              </button>
            </div>
          </div>

          {form.audience === "all_passengers" && (
            <div className="mp-field">
              <label className="mp-label">Category</label>
              <div className="mp-toggle-row">
                <button
                  className={`mp-toggle-btn${form.category === "announcement" ? " active" : ""}`}
                  onClick={() => setForm((f) => ({ ...f, category: "announcement" }))}
                >
                  📣 Announcement
                </button>
                <button
                  className={`mp-toggle-btn${form.category === "offer" ? " active" : ""}`}
                  onClick={() => setForm((f) => ({ ...f, category: "offer" }))}
                >
                  🏷️ Offer
                </button>
              </div>
            </div>
          )}

          <div className="mp-field">
            <label className="mp-label">Display style</label>
            <div className="mp-toggle-row">
              <button
                className={`mp-toggle-btn${form.display_mode === "inbox" ? " active" : ""}`}
                onClick={() => setForm((f) => ({ ...f, display_mode: "inbox" }))}
              >
                Inbox
              </button>
              <button
                className={`mp-toggle-btn${form.display_mode === "interstitial" ? " active" : ""}`}
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    display_mode: "interstitial",
                    body: f.body.slice(0, imageFile ? 90 : 280),
                  }))
                }
              >
                Interstitial (spotlighted once)
              </button>
            </div>
          </div>

          <div className="mp-field">
            <label className="mp-label">Title</label>
            <input
              className="mp-input"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="20% off rides this weekend"
              maxLength={80}
            />
          </div>

          <div className="mp-field">
            <label className="mp-label">Message</label>
            <textarea
              className="mp-textarea"
              value={form.body}
              onChange={(e) => {
                const value =
                  form.display_mode === "interstitial"
                    ? e.target.value.slice(0, interstitialLimit)
                    : e.target.value;
                setForm((f) => ({ ...f, body: value }));
              }}
              placeholder="Book any ride Fri–Sun and save 20%..."
              maxLength={form.display_mode === "interstitial" ? interstitialLimit : undefined}
            />
            {form.display_mode === "interstitial" && (
              <div className={`mp-char-count${form.body.length >= interstitialLimit ? " over" : ""}`}>
                {form.body.length} / {interstitialLimit}
                {form.body.length >= interstitialLimit &&
                  (imageFile
                    ? " · that's the limit for a photo message — switch to Inbox for more room"
                    : " · that's the limit — switch to Inbox mode for a longer message")}
              </div>
            )}
          </div>

          <div className="mp-field">
            <label className="mp-label">Expires (optional)</label>
            <input
              className="mp-input"
              type="datetime-local"
              value={form.expires_at}
              onChange={(e) => setForm((f) => ({ ...f, expires_at: e.target.value }))}
            />
          </div>

          <div className="mp-field">
            <label className="mp-label">Photo (optional)</label>
            {imagePreview ? (
              <div>
                <img className="mp-image-preview" src={imagePreview} />
                <button className="mp-image-remove" onClick={clearImage}>
                  Remove photo
                </button>
              </div>
            ) : (
              <div
                className="mp-image-picker"
                onClick={() => fileInputRef.current?.click()}
              >
                + Add a photo
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={pickImage}
            />
          </div>

          <button className="mp-send-btn" disabled={sending} onClick={sendMessage}>
            {sending ? "Sending…" : `Send to all ${AUDIENCE_LABELS[form.audience].toLowerCase()}`}
          </button>
        </div>

        <div className="mp-content">
          <div className="mp-header">
            <div className="mp-title">Sent announcements</div>
            <div className="mp-subtitle-text">
              {filteredMessages.length} sent
            </div>
          </div>

          <div className="mp-filter-row">
            <button
              className={`mp-filter-btn${audienceFilter === "all" ? " active" : ""}`}
              onClick={() => setAudienceFilter("all")}
            >
              All
            </button>
            <button
              className={`mp-filter-btn${audienceFilter === "all_passengers" ? " active" : ""}`}
              onClick={() => setAudienceFilter("all_passengers")}
            >
              Passengers
            </button>
            <button
              className={`mp-filter-btn${audienceFilter === "all_drivers" ? " active" : ""}`}
              onClick={() => setAudienceFilter("all_drivers")}
            >
              Drivers
            </button>
          </div>

          {loading ? (
            <div className="mp-loading">Loading…</div>
          ) : filteredMessages.length === 0 ? (
            <div className="mp-empty">Nothing sent yet.</div>
          ) : (
            groupedByDate.map((group) => (
              <div key={group.date}>
                <div className="mp-date-heading">{group.date}</div>
                {group.items.map((m) => (
                  <div key={m.id} className="mp-card">
                    <div className="mp-card-top">
                      <div className="mp-badges">
                        <span className="mp-badge mp-badge-audience">
                          {AUDIENCE_LABELS[m.target_type]}
                        </span>
                        <span
                          className="mp-badge"
                          style={{
                            background: CATEGORY_COLORS[m.category] + "18",
                            color: CATEGORY_COLORS[m.category],
                            border: `1px solid ${CATEGORY_COLORS[m.category]}30`,
                          }}
                        >
                          {CATEGORY_LABELS[m.category]}
                        </span>
                        <span className="mp-badge mp-badge-mode">
                          {m.display_mode === "interstitial" ? "Interstitial" : "Inbox"}
                        </span>
                        {m.expires_at && new Date(m.expires_at) < new Date() && (
                          <span className="mp-badge mp-badge-expired">Expired</span>
                        )}
                      </div>
                      <div className="mp-card-date">
                        {new Date(m.created_at).toLocaleTimeString("en-CA", {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </div>
                    </div>
                    <div className="mp-card-title">{m.title}</div>
                    <div className="mp-card-body">{m.body}</div>
                    {m.image_url && (
                      <img className="mp-card-image" src={m.image_url} />
                    )}
                    {m.expires_at && (
                      <div className="mp-card-expiry">
                        Expires{" "}
                        {new Date(m.expires_at).toLocaleString("en-CA", {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
