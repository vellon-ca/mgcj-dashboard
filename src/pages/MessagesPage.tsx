import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "../lib/supabase";

interface DriverRow {
  id: string;
  name: string;
  avatar_url: string | null;
}

interface ChatMessage {
  id: string;
  driver_id: string;
  sender_id: string;
  sender_role: "admin" | "driver";
  body: string;
  created_at: string;
}

interface ThreadSummary {
  lastBody: string | null;
  lastAt: string | null;
  unread: boolean;
}

interface Props {
  companyId: string;
  adminId: string;
  isActive: boolean;
  onUnreadChange?: (hasUnread: boolean) => void;
}

export default function MessagesPage({ companyId, adminId, isActive, onUnreadChange }: Props) {
  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [threads, setThreads] = useState<Map<string, ThreadSummary>>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [threadLoading, setThreadLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  useEffect(() => {
    fetchAll();
  }, [companyId]);

  useEffect(() => {
    const hasUnread = [...threads.values()].some((t) => t.unread);
    onUnreadChange?.(hasUnread);
  }, [threads, onUnreadChange]);

  useEffect(() => {
    if (!companyId) return;
    const channel = supabase
      .channel("dispatch-driver-chat-" + companyId)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "driver_chat_messages",
          filter: `company_id=eq.${companyId}`,
        },
        (payload) => {
          const row = payload.new as ChatMessage;
          const isOpenThread = isActiveRef.current && selectedIdRef.current === row.driver_id;
          setThreads((prev) => {
            const next = new Map(prev);
            next.set(row.driver_id, {
              lastBody: row.body,
              lastAt: row.created_at,
              unread: row.sender_role === "driver" && !isOpenThread,
            });
            return next;
          });
          if (selectedIdRef.current === row.driver_id) {
            setMessages((prev) => [...prev, row]);
            if (row.sender_role === "driver" && isOpenThread) markRead(row.driver_id);
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [companyId]);

  const hasScrolledInitialRef = useRef(false);
  useEffect(() => {
    // Guard on threadLoading too: setMessages fires before the awaited markRead()
    // resolves and flips threadLoading false, so a plain [messages] dependency
    // fires while the thread is still showing the loading placeholder (wrong
    // scrollHeight) and never fires again once the real list renders.
    if (threadLoading || !scrollRef.current) return;
    scrollRef.current.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: hasScrolledInitialRef.current ? "smooth" : "auto",
    });
    hasScrolledInitialRef.current = true;
  }, [messages, threadLoading]);

  async function fetchAll() {
    setLoading(true);
    try {
      const { data: driverRows } = await supabase
        .from("drivers")
        .select("id")
        .order("id");
      const driverIds = (driverRows ?? []).map((d: any) => d.id);
      if (driverIds.length === 0) {
        setDrivers([]);
        setLoading(false);
        return;
      }

      const { data: profileRows } = await supabase
        .from("profiles")
        .select("id, name, avatar_url")
        .in("id", driverIds)
        .order("name");
      const driverList: DriverRow[] = (profileRows ?? []).map((p: any) => ({
        id: p.id,
        name: p.name ?? "Driver",
        avatar_url: p.avatar_url,
      }));
      setDrivers(driverList);

      const [{ data: recentMessages }, { data: stateRows }] = await Promise.all([
        supabase
          .from("driver_chat_messages")
          .select("driver_id, body, sender_role, created_at")
          .eq("company_id", companyId)
          .order("created_at", { ascending: false })
          .limit(500),
        supabase
          .from("driver_chat_state")
          .select("driver_id, last_read_by_admin_at")
          .eq("company_id", companyId),
      ]);

      const stateMap = new Map(
        (stateRows ?? []).map((s: any) => [s.driver_id, s.last_read_by_admin_at]),
      );
      const summary = new Map<string, ThreadSummary>();
      for (const m of recentMessages ?? []) {
        const existing = summary.get(m.driver_id);
        if (!existing) {
          const lastRead = stateMap.get(m.driver_id) ?? "1970-01-01";
          summary.set(m.driver_id, {
            lastBody: m.body,
            lastAt: m.created_at,
            unread: m.sender_role === "driver" && m.created_at > lastRead,
          });
        }
      }
      setThreads(summary);
    } finally {
      setLoading(false);
    }
  }

  async function openThread(driverId: string) {
    setSelectedId(driverId);
    setThreadLoading(true);
    hasScrolledInitialRef.current = false;
    try {
      const { data } = await supabase
        .from("driver_chat_messages")
        .select("id, driver_id, sender_id, sender_role, body, created_at")
        .eq("company_id", companyId)
        .eq("driver_id", driverId)
        .order("created_at", { ascending: true })
        .limit(300);
      setMessages(data ?? []);
      await markRead(driverId);
    } finally {
      setThreadLoading(false);
    }
  }

  async function markRead(driverId: string) {
    setThreads((prev) => {
      const next = new Map(prev);
      const existing = next.get(driverId);
      if (existing) next.set(driverId, { ...existing, unread: false });
      return next;
    });
    await supabase
      .from("driver_chat_state")
      .upsert(
        { driver_id: driverId, company_id: companyId, last_read_by_admin_at: new Date().toISOString() },
        { onConflict: "driver_id" },
      );
  }

  const sendMessage = useCallback(async () => {
    if (!selectedId || !draft.trim()) return;
    setSending(true);
    const body = draft.trim();
    setDraft("");
    try {
      const { error } = await supabase.from("driver_chat_messages").insert({
        company_id: companyId,
        driver_id: selectedId,
        sender_id: adminId,
        sender_role: "admin",
        body,
      });
      if (error) throw error;
      setThreads((prev) => {
        const next = new Map(prev);
        next.set(selectedId, { lastBody: body, lastAt: new Date().toISOString(), unread: false });
        return next;
      });
    } finally {
      setSending(false);
    }
  }, [selectedId, draft, companyId, adminId]);

  const sortedDrivers = [...drivers].sort((a, b) => {
    const aAt = threads.get(a.id)?.lastAt ?? "";
    const bAt = threads.get(b.id)?.lastAt ?? "";
    return bAt.localeCompare(aAt);
  });
  const selectedDriver = drivers.find((d) => d.id === selectedId) ?? null;

  return (
    <>
      <style>{`
        .mc-wrap { display: flex; height: 100%; overflow: hidden; font-family: system-ui, -apple-system, sans-serif; }

        .mc-list { width: 280px; flex-shrink: 0; background: #0F1723; border-right: 1px solid rgba(255,255,255,0.06); overflow-y: auto; }
        .mc-list-title { font-size: 10px; font-weight: 600; color: #6B7280; letter-spacing: 0.09em; text-transform: uppercase; padding: 16px 16px 10px; }
        .mc-driver-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 16px; background: none; border: none; border-left: 2px solid transparent; cursor: pointer; text-align: left; transition: background 0.12s, border-color 0.12s; }
        .mc-driver-row:hover { background: rgba(255,255,255,0.04); }
        .mc-driver-row.active { border-left-color: #E8500A; background: rgba(232,80,10,0.07); }
        .mc-avatar { width: 34px; height: 34px; border-radius: 17px; background: #1E3A5F; flex-shrink: 0; object-fit: cover; }
        .mc-avatar-fallback { width: 34px; height: 34px; border-radius: 17px; background: #1E3A5F; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: #93C5FD; }
        .mc-driver-info { flex: 1; min-width: 0; }
        .mc-driver-name-row { display: flex; align-items: center; gap: 6px; }
        .mc-driver-name { font-size: 13px; font-weight: 600; color: #E2E8F0; }
        .mc-unread-dot { width: 7px; height: 7px; border-radius: 3.5px; background: #E8500A; flex-shrink: 0; }
        .mc-driver-preview { font-size: 12px; color: #6B7280; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }

        .mc-thread { flex: 1; display: flex; flex-direction: column; background: #111827; min-width: 0; }
        .mc-thread-header { padding: 16px 24px; border-bottom: 1px solid rgba(255,255,255,0.06); font-size: 15px; font-weight: 700; color: #F1F5F9; flex-shrink: 0; }
        .mc-thread-empty { flex: 1; display: flex; align-items: center; justify-content: center; color: #6B7280; font-size: 14px; }
        .mc-thread-scroll { flex: 1; overflow-y: auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 10px; }

        .mc-bubble-row { display: flex; }
        .mc-bubble-row.admin { justify-content: flex-end; }
        .mc-bubble-row.driver { justify-content: flex-start; }
        .mc-bubble-col { display: inline-flex; flex-direction: column; max-width: 70%; }
        .mc-bubble { padding: 9px 13px; border-radius: 14px; font-size: 13px; line-height: 19px; word-break: break-word; }
        .mc-bubble.admin { background: rgba(232,80,10,0.16); color: #FDE4D3; border-bottom-right-radius: 4px; }
        .mc-bubble.driver { background: #1E2A3A; color: #E2E8F0; border-bottom-left-radius: 4px; }
        .mc-bubble-time { font-size: 10px; color: #6B7280; margin-top: 3px; }
        .mc-bubble-row.admin .mc-bubble-time { text-align: right; }

        .mc-input-row { display: flex; gap: 10px; padding: 14px 24px; border-top: 1px solid rgba(255,255,255,0.06); flex-shrink: 0; }
        .mc-input { flex: 1; background: #1E2A3A; border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 10px 14px; color: #E2E8F0; font-size: 13px; font-family: system-ui, sans-serif; }
        .mc-input:focus { outline: none; border-color: #E8500A; }
        .mc-send-btn { padding: 0 18px; border-radius: 10px; background: #E8500A; color: #fff; border: none; font-size: 13px; font-weight: 700; cursor: pointer; }
        .mc-send-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .mc-empty { color: #6B7280; font-size: 13px; text-align: center; padding: 30px 16px; }
        .mc-loading { color: #6B7280; text-align: center; padding: 40px; font-size: 14px; }
      `}</style>

      <div className="mc-wrap">
        <div className="mc-list">
          <div className="mc-list-title">Drivers</div>
          {loading ? (
            <div className="mc-loading">Loading…</div>
          ) : sortedDrivers.length === 0 ? (
            <div className="mc-empty">No drivers yet.</div>
          ) : (
            sortedDrivers.map((d) => {
              const thread = threads.get(d.id);
              const initials = d.name
                .split(" ")
                .map((n) => n[0])
                .join("")
                .slice(0, 2)
                .toUpperCase();
              return (
                <button
                  key={d.id}
                  className={`mc-driver-row${selectedId === d.id ? " active" : ""}`}
                  onClick={() => openThread(d.id)}
                >
                  {d.avatar_url ? (
                    <img src={d.avatar_url} className="mc-avatar" />
                  ) : (
                    <div className="mc-avatar-fallback">{initials}</div>
                  )}
                  <div className="mc-driver-info">
                    <div className="mc-driver-name-row">
                      <span className="mc-driver-name">{d.name}</span>
                      {thread?.unread && <span className="mc-unread-dot" />}
                    </div>
                    <div className="mc-driver-preview">
                      {thread?.lastBody ?? "No messages yet"}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div className="mc-thread">
          {!selectedDriver ? (
            <div className="mc-thread-empty">Select a driver to start messaging</div>
          ) : (
            <>
              <div className="mc-thread-header">{selectedDriver.name}</div>
              <div className="mc-thread-scroll" ref={scrollRef}>
                {threadLoading ? (
                  <div className="mc-loading">Loading…</div>
                ) : messages.length === 0 ? (
                  <div className="mc-empty">No messages yet — say hello.</div>
                ) : (
                  messages.map((m) => (
                    <div key={m.id} className={`mc-bubble-row ${m.sender_role}`}>
                      <div className="mc-bubble-col">
                        <div className={`mc-bubble ${m.sender_role}`}>{m.body}</div>
                        <div className="mc-bubble-time">
                          {new Date(m.created_at).toLocaleTimeString("en-CA", {
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
              <div className="mc-input-row">
                <input
                  className="mc-input"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !sending) sendMessage();
                  }}
                  placeholder="Type a message..."
                />
                <button
                  className="mc-send-btn"
                  disabled={sending || !draft.trim()}
                  onClick={sendMessage}
                >
                  Send
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
