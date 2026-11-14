import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "../lib/supabase";
import { fmtDate } from "../i18n/format";
import PhoneInput, { usePhoneField } from "../components/PhoneInput";
import { formatPhoneDisplay } from "../lib/phone";

// Business accounts, as the TAXI COMPANY sees them (mgcj-app
// .claude/notes/business-accounts-design.md, §2). The business runs its own
// people through its manager on corporate.vellon.ca; this page hosts the
// account: admins create, rename and pause it and name its managers, and any
// staff can look someone up or add a person on the business's behalf when the
// business phones in. Teams, approvals and the join link are the manager's and
// are not editable here. Every write is a ba_* function; the tables are
// read-only to clients.

interface Account {
  id: string;
  name: string;
  status: "active" | "suspended";
  created_at: string;
}

interface Member {
  id: string;
  status: "invited" | "requested" | "active";
  role: "rider" | "booker";
  team_id: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  pending_phone: string | null;
  pending_email: string | null;
  created_at: string;
}

interface Manager {
  id: string;
  email: string;
  created_at: string;
  last_sign_in_at: string | null;
}

interface Team {
  id: string;
  name: string;
}

interface Props {
  companyId: string;
  isAdmin: boolean;
  visible: boolean;
}

const STATUS_DOT: Record<Member["status"], string> = {
  active: "var(--c-green)",
  requested: "var(--c-amber)",
  invited: "var(--c-blue)",
};

export default function AccountsPage({ companyId, isAdmin, visible }: Props) {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [activeCounts, setActiveCounts] = useState<Record<string, number>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [managers, setManagers] = useState<Manager[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Bumped to reload; fetches set state only once they resolve.
  const [listVersion, setListVersion] = useState(0);
  const [detailVersion, setDetailVersion] = useState(0);

  const [creating, setCreating] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [managerEmail, setManagerEmail] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // ── account list
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    Promise.all([
      supabase.from("business_accounts").select("id, name, status, created_at").order("name"),
      supabase.from("account_members").select("account_id").eq("status", "active"),
    ]).then(([a, m]) => {
      if (!alive) return;
      if (a.error) {
        setError(t("accounts.errLoad"));
        return;
      }
      const list = (a.data ?? []) as Account[];
      const counts: Record<string, number> = {};
      for (const r of (m.data ?? []) as { account_id: string }[]) {
        counts[r.account_id] = (counts[r.account_id] ?? 0) + 1;
      }
      setAccounts(list);
      setActiveCounts(counts);
      setSelectedId((cur) => (cur && list.some((x) => x.id === cur) ? cur : (list[0]?.id ?? null)));
    });
    return () => {
      alive = false;
    };
  }, [visible, listVersion, companyId, t]);

  // ── the selected account's people, managers and teams
  useEffect(() => {
    if (!visible || !selectedId) return;
    let alive = true;
    Promise.all([
      supabase.rpc("ba_list_members", { p_account: selectedId }),
      supabase.rpc("ba_list_managers", { p_account: selectedId }),
      supabase.from("account_teams").select("id, name").eq("account_id", selectedId).order("name"),
    ]).then(([m, g, tm]) => {
      if (!alive) return;
      if (m.error || g.error || tm.error) {
        setError(t("accounts.errLoad"));
        return;
      }
      setMembers((m.data ?? []) as Member[]);
      setManagers((g.data ?? []) as Manager[]);
      setTeams((tm.data ?? []) as Team[]);
    });
    return () => {
      alive = false;
    };
  }, [visible, selectedId, detailVersion, t]);

  const account = accounts?.find((a) => a.id === selectedId) ?? null;
  const teamName = (id: string | null) => teams.find((x) => x.id === id)?.name ?? "—";

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const digits = q.replace(/\D/g, "");
    return (members ?? []).filter((m) => {
      if (!q) return true;
      const hay = [m.name, m.email, m.pending_email].filter(Boolean).join(" ").toLowerCase();
      const nums = [m.phone, m.pending_phone].filter(Boolean).join(" ").replace(/\D/g, "");
      return hay.includes(q) || (digits.length >= 3 && nums.includes(digits));
    });
  }, [members, search]);

  async function call(fn: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setError(null);
    const { data, error: e } = await supabase.rpc(fn, args);
    if (e) {
      setError(t("accounts.errGeneric"));
      return null;
    }
    return data as Record<string, unknown>;
  }

  async function createAccount() {
    const name = (creating ?? "").trim();
    if (!name) return;
    const r = await call("ba_create_account", { p_name: name });
    if (!r) return;
    if (!r.ok) {
      setError(r.reason === "name_taken" ? t("accounts.errNameTaken") : t("accounts.errGeneric"));
      return;
    }
    setCreating(null);
    setSelectedId(r.id as string);
    setListVersion((v) => v + 1);
  }

  async function rename() {
    if (!account) return;
    const name = (renaming ?? "").trim();
    if (!name || name === account.name) {
      setRenaming(null);
      return;
    }
    const r = await call("ba_update_account", { p_account: account.id, p_name: name });
    if (!r) return;
    if (!r.ok) {
      setError(r.reason === "name_taken" ? t("accounts.errNameTaken") : t("accounts.errGeneric"));
      return;
    }
    setRenaming(null);
    setListVersion((v) => v + 1);
  }

  async function setStatus(status: Account["status"]) {
    if (!account || account.status === status) return;
    if (status === "suspended" && !window.confirm(t("accounts.confirmSuspend", { name: account.name }))) return;
    const r = await call("ba_update_account", { p_account: account.id, p_status: status });
    if (r?.ok) setListVersion((v) => v + 1);
    else if (r) setError(t("accounts.errGeneric"));
  }

  async function addManager() {
    if (!account) return;
    const email = (managerEmail ?? "").trim();
    if (!email) return;
    const r = await call("ba_add_manager", { p_account: account.id, p_email: email });
    if (!r) return;
    if (!r.ok) {
      const key: Record<string, string> = {
        bad_email: "accounts.errBadEmail",
        email_unavailable: "accounts.errStaffEmail",
        already_manager: "accounts.errAlreadyManager",
      };
      setError(t(key[r.reason as string] ?? "accounts.errGeneric"));
      return;
    }
    setManagerEmail(null);
    setDetailVersion((v) => v + 1);
  }

  async function removeManager(m: Manager) {
    if (!window.confirm(t("accounts.confirmRemoveManager", { email: m.email }))) return;
    const r = await call("ba_remove_manager", { p_manager: m.id });
    if (r?.ok) setDetailVersion((v) => v + 1);
    else if (r) setError(t("accounts.errGeneric"));
  }

  return (
    <div className="ac-wrap">
      <style>{`
        .ac-wrap { display: flex; height: 100%; width: 100%; overflow: hidden; font-family: system-ui, -apple-system, sans-serif; }
        .ac-panel { width: 220px; background: var(--c-surface); border-right: 1px solid var(--c-border); display: flex; flex-direction: column; flex-shrink: 0; padding: 16px 0; overflow-y: auto; }
        .ac-panel-title { font-size: 10px; font-weight: 600; color: var(--c-text-2); letter-spacing: 0.09em; text-transform: uppercase; padding: 0 16px 10px; }
        .ac-acct { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 9px 16px; background: none; border: none; border-left: 2px solid transparent; text-align: left; cursor: pointer; font-family: system-ui, sans-serif; color: var(--c-text); }
        .ac-acct:hover { background: var(--c-hover); }
        .ac-acct.on { border-left-color: var(--c-brand); background: var(--c-surface-sel); }
        .ac-acct-name { font-size: 13px; font-weight: 600; }
        .ac-acct.on .ac-acct-name { color: var(--c-brand); }
        .ac-acct-sub { font-size: 11px; color: var(--c-text-2); display: flex; align-items: center; gap: 6px; }
        .ac-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
        .ac-new { margin: 12px 16px 0; padding: 8px 12px; border: 1px dashed var(--c-border-strong); border-radius: 8px; background: none; font-size: 12px; font-weight: 600; color: var(--c-brand); cursor: pointer; font-family: system-ui, sans-serif; }
        .ac-new-form { display: flex; flex-direction: column; gap: 6px; margin: 12px 16px 0; }
        .ac-content { flex: 1; overflow-y: auto; padding: 24px 32px; background: var(--c-bg); }
        .ac-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 18px; }
        .ac-title { font-size: 20px; font-weight: 700; color: var(--c-text); }
        .ac-sub { font-size: 13px; color: var(--c-text-2); margin-top: 4px; }
        .ac-grid { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 16px 20px; align-items: start; }
        .ac-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
        .ac-card { background: var(--c-surface); border: 1px solid var(--c-border-subtle); border-radius: 12px; padding: 16px 18px; }
        .ac-card-label { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 11px; font-weight: 600; color: var(--c-text-2); text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 12px; }
        .ac-ro { font-size: 11px; font-weight: 600; color: var(--c-text-2); border: 1px solid var(--c-border); border-radius: 6px; padding: 2px 7px; text-transform: none; letter-spacing: 0; }
        .ac-btn { padding: 8px 14px; border-radius: 8px; border: 1px solid var(--c-border); background: var(--c-surface); color: var(--c-text); font-size: 12px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; white-space: nowrap; }
        .ac-btn:hover { background: var(--c-hover); }
        .ac-btn-primary { background: var(--c-brand-fill); border-color: var(--c-brand-fill); color: var(--c-on-brand); }
        .ac-btn-primary:hover { background: var(--c-brand-fill-hover); }
        .ac-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .ac-linkbtn { background: none; border: none; padding: 0; color: var(--c-brand); font-size: 12px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; text-transform: none; letter-spacing: 0; }
        .ac-linkbtn.danger { color: var(--c-red); }
        .ac-input { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--c-border); background: var(--c-input); color: var(--c-text); font-size: 13px; font-family: system-ui, sans-serif; box-sizing: border-box; }
        .ac-input:focus { outline: none; border-color: var(--c-brand); }
        .ac-row-actions { display: flex; gap: 6px; }
        .ac-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .ac-table th { text-align: left; font-size: 10px; font-weight: 600; color: var(--c-text-2); text-transform: uppercase; letter-spacing: 0.06em; padding: 8px 8px 8px 0; border-bottom: 1px solid var(--c-border-subtle); }
        .ac-table td { padding: 9px 8px 9px 0; border-bottom: 1px solid var(--c-border-subtle); color: var(--c-text); vertical-align: middle; }
        .ac-table tr:last-child td { border-bottom: none; }
        .ac-muted { color: var(--c-text-2); }
        .ac-small { font-size: 12px; color: var(--c-text-2); line-height: 1.5; }
        .ac-li { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--c-border-subtle); font-size: 13px; color: var(--c-text); }
        .ac-li:last-of-type { border-bottom: none; }
        .ac-li-main { flex: 1; min-width: 0; word-break: break-all; }
        .ac-seg { display: flex; border: 1px solid var(--c-border); border-radius: 8px; overflow: hidden; }
        .ac-seg button { flex: 1; padding: 7px; background: none; border: none; font-size: 13px; color: var(--c-text-2); cursor: pointer; font-family: system-ui, sans-serif; }
        .ac-seg button.on { background: var(--c-surface-sel); box-shadow: inset 0 0 0 1.5px var(--c-brand); color: var(--c-brand); font-weight: 600; }
        .ac-seg button:disabled { cursor: default; }
        .ac-soon { border: 1px dashed var(--c-border-strong); border-radius: 12px; padding: 14px 16px; font-size: 12px; color: var(--c-text-2); line-height: 1.5; }
        .ac-error { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; font-size: 13px; color: var(--c-red); }
        .ac-empty { color: var(--c-text-2); font-size: 14px; text-align: center; padding: 60px 0; }
        @media (max-width: 1100px) { .ac-grid { grid-template-columns: minmax(0, 1fr); } }
      `}</style>

      <div className="ac-panel">
        <div className="ac-panel-title">{t("accounts.title")}</div>
        {(accounts ?? []).map((a) => (
          <button
            key={a.id}
            className={`ac-acct${a.id === selectedId ? " on" : ""}`}
            onClick={() => {
              setSelectedId(a.id);
              setRenaming(null);
              setManagerEmail(null);
              setSearch("");
            }}
          >
            <span className="ac-acct-name">{a.name}</span>
            <span className="ac-acct-sub">
              <span
                className="ac-dot"
                style={{ background: a.status === "active" ? "var(--c-green)" : "var(--c-amber)" }}
              />
              {a.status === "active"
                ? t("accounts.activePeople", { count: activeCounts[a.id] ?? 0 })
                : t("accounts.suspended")}
            </span>
          </button>
        ))}
        {isAdmin &&
          (creating === null ? (
            <button className="ac-new" onClick={() => setCreating("")}>
              {t("accounts.newAccount")}
            </button>
          ) : (
            <form
              className="ac-new-form"
              onSubmit={(e) => {
                e.preventDefault();
                createAccount();
              }}
            >
              <input
                className="ac-input"
                autoFocus
                maxLength={80}
                placeholder={t("accounts.namePlaceholder")}
                value={creating}
                onChange={(e) => setCreating(e.target.value)}
              />
              <div className="ac-row-actions">
                <button className="ac-btn ac-btn-primary" type="submit" disabled={!creating.trim()}>
                  {t("accounts.create")}
                </button>
                <button className="ac-btn" type="button" onClick={() => setCreating(null)}>
                  {t("common.cancel")}
                </button>
              </div>
            </form>
          ))}
      </div>

      <div className="ac-content">
        {error && <div className="ac-error">{error}</div>}
        {accounts === null ? (
          <div className="ac-empty">{t("common.loading")}</div>
        ) : !account ? (
          <div className="ac-empty">{isAdmin ? t("accounts.emptyAdmin") : t("accounts.emptyDispatcher")}</div>
        ) : (
          <>
            <div className="ac-head">
              <div style={{ flex: 1, minWidth: 0 }}>
                {renaming !== null ? (
                  <form
                    style={{ display: "flex", gap: 8, maxWidth: 480 }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      rename();
                    }}
                  >
                    <input
                      className="ac-input"
                      autoFocus
                      maxLength={80}
                      value={renaming}
                      onChange={(e) => setRenaming(e.target.value)}
                    />
                    <button className="ac-btn ac-btn-primary" type="submit">{t("common.save")}</button>
                    <button className="ac-btn" type="button" onClick={() => setRenaming(null)}>
                      {t("common.cancel")}
                    </button>
                  </form>
                ) : (
                  <div className="ac-title">{account.name}</div>
                )}
                <div className="ac-sub">{t("accounts.created", { date: fmtDate(account.created_at) })}</div>
              </div>
              {isAdmin && renaming === null && (
                <button className="ac-btn" onClick={() => setRenaming(account.name)}>
                  {t("accounts.rename")}
                </button>
              )}
            </div>

            <div className="ac-grid">
              <div className="ac-col">
                <div className="ac-card">
                  <div className="ac-card-label">
                    <span>{t("accounts.people")}</span>
                    <span className="ac-ro">{t("accounts.readOnly")}</span>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    <input
                      className="ac-input"
                      placeholder={t("accounts.searchPlaceholder")}
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <button className="ac-btn" onClick={() => setAdding(true)}>
                      {t("accounts.addOnBehalf")}
                    </button>
                  </div>
                  {members === null ? (
                    <div className="ac-small">{t("common.loading")}</div>
                  ) : shown.length === 0 ? (
                    <div className="ac-small" style={{ padding: "16px 0" }}>
                      {members.length === 0 ? t("accounts.noPeople") : t("accounts.noMatch")}
                    </div>
                  ) : (
                    <table className="ac-table">
                      <thead>
                        <tr>
                          <th>{t("accounts.colPerson")}</th>
                          <th>{t("accounts.colTeam")}</th>
                          <th>{t("accounts.colBooks")}</th>
                          <th>{t("accounts.colStatus")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((m) => (
                          <tr key={m.id}>
                            <td>
                              {m.status === "invited" ? (
                                <span className="ac-muted">{m.pending_phone ? formatPhoneDisplay(m.pending_phone) : m.pending_email}</span>
                              ) : (
                                <>
                                  <b>{m.name ?? "—"}</b>{" "}
                                  <span className="ac-muted">{m.phone ? formatPhoneDisplay(m.phone) : (m.email ?? "")}</span>
                                </>
                              )}
                            </td>
                            <td className="ac-muted">{teamName(m.team_id)}</td>
                            <td className={m.role === "booker" ? "" : "ac-muted"}>
                              {m.role === "booker" ? t("accounts.yes") : t("accounts.no")}
                            </td>
                            <td>
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                <span className="ac-dot" style={{ background: STATUS_DOT[m.status] }} />
                                {t(`accounts.status.${m.status}`)}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <div className="ac-small" style={{ marginTop: 10 }}>{t("accounts.peopleNote")}</div>
                </div>
              </div>

              <div className="ac-col">
                <div className="ac-card">
                  <div className="ac-card-label">
                    <span>{t("accounts.managers")}</span>
                    {isAdmin && managerEmail === null && (
                      <button className="ac-linkbtn" onClick={() => setManagerEmail("")}>
                        {t("accounts.addManager")}
                      </button>
                    )}
                  </div>
                  {managerEmail !== null && (
                    <form
                      style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}
                      onSubmit={(e) => {
                        e.preventDefault();
                        addManager();
                      }}
                    >
                      <input
                        className="ac-input"
                        type="email"
                        autoFocus
                        placeholder={t("accounts.managerPlaceholder")}
                        value={managerEmail}
                        onChange={(e) => setManagerEmail(e.target.value)}
                      />
                      <div className="ac-row-actions">
                        <button className="ac-btn ac-btn-primary" type="submit" disabled={!managerEmail.trim()}>
                          {t("accounts.add")}
                        </button>
                        <button className="ac-btn" type="button" onClick={() => setManagerEmail(null)}>
                          {t("common.cancel")}
                        </button>
                      </div>
                    </form>
                  )}
                  {managers.length === 0 ? (
                    <div className="ac-small">{t("accounts.noManagers")}</div>
                  ) : (
                    managers.map((m) => (
                      <div key={m.id} className="ac-li">
                        <div className="ac-li-main">
                          <b>{m.email}</b>
                          <div className="ac-small">
                            {m.last_sign_in_at
                              ? t("accounts.lastSignIn", { date: fmtDate(m.last_sign_in_at) })
                              : t("accounts.neverSignedIn")}
                          </div>
                        </div>
                        {isAdmin && (
                          <button className="ac-linkbtn danger" onClick={() => removeManager(m)}>
                            {t("accounts.remove")}
                          </button>
                        )}
                      </div>
                    ))
                  )}
                  <div className="ac-small" style={{ marginTop: 10 }}>{t("accounts.managersNote")}</div>
                </div>

                <div className="ac-card">
                  <div className="ac-card-label">
                    <span>{t("accounts.statusTitle")}</span>
                  </div>
                  <div className="ac-seg">
                    <button
                      className={account.status === "active" ? "on" : ""}
                      disabled={!isAdmin}
                      onClick={() => setStatus("active")}
                    >
                      {t("accounts.active")}
                    </button>
                    <button
                      className={account.status === "suspended" ? "on" : ""}
                      disabled={!isAdmin}
                      onClick={() => setStatus("suspended")}
                    >
                      {t("accounts.suspended")}
                    </button>
                  </div>
                  <div className="ac-small" style={{ marginTop: 8 }}>{t("accounts.suspendNote")}</div>
                </div>

                <div className="ac-soon">{t("accounts.billingSoon")}</div>
              </div>
            </div>
          </>
        )}
      </div>

      {adding && account && (
        <AddOnBehalf
          accountId={account.id}
          accountName={account.name}
          teams={teams}
          onClose={() => setAdding(false)}
          onAdded={() => setDetailVersion((v) => v + 1)}
        />
      )}
    </div>
  );
}

// The "hospital phoned in" case: one person, by phone or email, through the same
// ba_add_members the manager uses. They still get an invite and must accept.
function AddOnBehalf({
  accountId,
  accountName,
  teams,
  onClose,
  onAdded,
}: {
  accountId: string;
  accountName: string;
  teams: Team[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const { t } = useTranslation();
  const phone = usePhoneField();
  const [by, setBy] = useState<"phone" | "email">("phone");
  const [email, setEmail] = useState("");
  const [team, setTeam] = useState("");
  const [booker, setBooker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const ready = by === "phone" ? phone.valid : /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

  async function submit() {
    setBusy(true);
    setResult(null);
    const entry = {
      ...(by === "phone" ? { phone: phone.e164 } : { email: email.trim().toLowerCase() }),
      role: booker ? "booker" : "rider",
      ...(team ? { team_id: team } : {}),
    };
    const { data, error } = await supabase.rpc("ba_add_members", { p_account: accountId, p_entries: [entry] });
    setBusy(false);
    if (error || !data?.ok) {
      setResult("error");
      return;
    }
    const r = (data.results as string[])[0];
    setResult(r);
    if (r === "added") onAdded();
  }

  const RESULT_KEY: Record<string, string> = {
    added: "accounts.addAdded",
    already_member: "accounts.addAlready",
    bad_phone: "accounts.errBadPhone",
    bad_email: "accounts.errBadEmail",
  };

  return (
    <div className="ac-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <style>{`
        .ac-overlay { position: fixed; inset: 0; background: var(--c-scrim); display: flex; align-items: center; justify-content: center; z-index: 1000; backdrop-filter: blur(3px); }
        .ac-form { background: var(--c-surface); border-radius: 14px; padding: 24px; width: 100%; max-width: 420px; border: 1px solid var(--c-border); box-shadow: 0 20px 60px var(--c-shadow); font-family: system-ui, sans-serif; color: var(--c-text); }
        .ac-form-title { font-size: 17px; font-weight: 700; margin-bottom: 4px; }
        .ac-form-sub { font-size: 13px; color: var(--c-text-2); line-height: 1.5; margin-bottom: 16px; }
        .ac-field { margin-bottom: 14px; display: flex; flex-direction: column; gap: 6px; }
        .ac-label { font-size: 12px; color: var(--c-text-2); font-weight: 500; }
        .ac-check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; cursor: pointer; }
        .ac-check input { margin-top: 3px; }
        .ac-result { font-size: 13px; margin-top: 12px; display: flex; gap: 8px; align-items: center; }
      `}</style>
      <div className="ac-form">
        <div className="ac-form-title">{t("accounts.addTitle", { name: accountName })}</div>
        <div className="ac-form-sub">{t("accounts.addSub")}</div>
        <div className="ac-field">
          <div className="ac-seg">
            <button className={by === "phone" ? "on" : ""} onClick={() => setBy("phone")} type="button">
              {t("accounts.byPhone")}
            </button>
            <button className={by === "email" ? "on" : ""} onClick={() => setBy("email")} type="button">
              {t("accounts.byEmail")}
            </button>
          </div>
        </div>
        <div className="ac-field">
          {by === "phone" ? (
            <PhoneInput field={phone} variant="modal" autoFocus onEdit={() => setResult(null)} />
          ) : (
            <input
              className="ac-input"
              type="email"
              autoFocus
              placeholder={t("accounts.emailPlaceholder")}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setResult(null);
              }}
            />
          )}
        </div>
        <div className="ac-field">
          <label className="ac-label" htmlFor="ac-team">{t("accounts.colTeam")}</label>
          <select id="ac-team" className="ac-input" value={team} onChange={(e) => setTeam(e.target.value)}>
            <option value="">{t("accounts.noTeam")}</option>
            {teams.map((x) => (
              <option key={x.id} value={x.id}>{x.name}</option>
            ))}
          </select>
        </div>
        <label className="ac-check">
          <input type="checkbox" checked={booker} onChange={(e) => setBooker(e.target.checked)} />
          <span>{t("accounts.canBook")}</span>
        </label>
        {result && (
          <div className="ac-result">
            <span
              className="ac-dot"
              style={{ background: result === "added" ? "var(--c-green)" : result === "already_member" ? "var(--c-text-3)" : "var(--c-red)" }}
            />
            {t(RESULT_KEY[result] ?? "accounts.errGeneric")}
          </div>
        )}
        <div className="ac-row-actions" style={{ marginTop: 18 }}>
          <button className="ac-btn" style={{ flex: 1 }} onClick={onClose} type="button">
            {result === "added" ? t("common.close") : t("common.cancel")}
          </button>
          <button
            className="ac-btn ac-btn-primary"
            style={{ flex: 1 }}
            disabled={!ready || busy}
            onClick={submit}
            type="button"
          >
            {busy ? t("accounts.adding") : t("accounts.sendInvite")}
          </button>
        </div>
      </div>
    </div>
  );
}
