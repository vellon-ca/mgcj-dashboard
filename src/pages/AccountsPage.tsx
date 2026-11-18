import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "../lib/supabase";
import { fmtDate } from "../i18n/format";
import PhoneInput, { usePhoneField } from "../components/PhoneInput";
import { formatPhoneDisplay } from "../lib/phone";
import AccountStatements from "../components/AccountStatements";
import AccountApplication, { ApplicationLinkCard, type Application, type ApplicationSettings } from "../components/AccountApplication";

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
  // Phase 2a (mgcj-app 20261114030000). NULL billing_mode: no ride can be
  // billed to the account yet (validate_account_ride refuses it).
  billing_mode: "invoice" | "card" | null;
  company_monthly_limit_cents: number | null;
  company_ride_limit_cents: number | null;
  manager_monthly_limit_cents: number | null;
  manager_ride_limit_cents: number | null;
  // Stage 6 (mgcj-app 20261117000000): free text printed on statements.
  payment_terms: string | null;
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
  /** Given on their first portal visit; null until then. */
  name: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  /** When the invite email last went out; null for a manager added before invites. */
  invite_sent_at: string | null;
  /** Manages through the business's own record: not the taxi company's to remove or re-invite. */
  via_business: boolean;
}

interface Team {
  id: string;
  name: string;
}

interface Props {
  companyId: string;
  isAdmin: boolean;
  visible: boolean;
  // Pending applications, for the badge on the nav's Accounts icon.
  onPendingApplications?: (count: number) => void;
}

const STATUS_DOT: Record<Member["status"], string> = {
  active: "var(--c-green)",
  requested: "var(--c-amber)",
  invited: "var(--c-blue)",
};

export default function AccountsPage({ companyId, isAdmin, visible, onPendingApplications }: Props) {
  const { t, i18n } = useTranslation();
  const fmtMoney = (cents: number) =>
    new Intl.NumberFormat(i18n.language, { style: "currency", currency: "CAD", currencyDisplay: "narrowSymbol" }).format(cents / 100);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [activeCounts, setActiveCounts] = useState<Record<string, number>>({});
  const [owingCents, setOwingCents] = useState<Record<string, number>>({});
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
  // Managers whose invite was just asked for again: "Sent" in place of the link.
  const [resent, setResent] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  // Businesses applying through the company's link, and the link itself.
  const [applications, setApplications] = useState<Application[]>([]);
  const [appSettings, setAppSettings] = useState<ApplicationSettings | null>(null);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);

  // ── account list
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    Promise.all([
      supabase
        .from("business_accounts")
        .select(
          "id, name, status, created_at, billing_mode, company_monthly_limit_cents, company_ride_limit_cents, manager_monthly_limit_cents, manager_ride_limit_cents, payment_terms",
        )
        .order("name"),
      supabase.from("account_members").select("account_id").eq("status", "active"),
      supabase.rpc("ba_account_balances"),
      supabase.rpc("ba_list_applications"),
      supabase.rpc("ba_application_settings"),
    ]).then(([a, m, b, ap, st]) => {
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
      const owing: Record<string, number> = {};
      for (const r of (b.data ?? []) as { account_id: string; owing_cents: number }[]) {
        owing[r.account_id] = Number(r.owing_cents);
      }
      setAccounts(list);
      const apps = (ap.data ?? []) as Application[];
      setApplications(apps);
      onPendingApplications?.(apps.filter((x) => x.status === "pending").length);
      setAppSettings((st.data as ApplicationSettings | null) ?? null);
      setActiveCounts(counts);
      setOwingCents(owing);
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
  const pendingApps = applications.filter((a) => a.status === "pending");
  const selectedApp = applications.find((a) => a.id === selectedAppId) ?? null;
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
    if (status === "suspended") {
      // Booked rides on it will need another way to pay (mgcj-app
      // business-accounts-design.md §14).
      const { data } = await supabase.rpc("ba_exit_impact", { p_account: account.id });
      const n = (data ?? []).length;
      const extra = n > 0 ? "\n\n" + t("accounts.suspendRides", { count: n }) : "";
      if (!window.confirm(t("accounts.confirmSuspend", { name: account.name }) + extra)) return;
    }
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

  async function resendInvite(m: Manager) {
    const r = await call("ba_resend_manager_invite", { p_manager: m.id });
    if (!r) return;
    if (r.ok) setResent((s) => new Set(s).add(m.id));
    else if (r.reason === "too_soon") setError(t("accounts.errInviteTooSoon"));
    else if (r.reason === "signed_in") setDetailVersion((v) => v + 1);
    else setError(t("accounts.errGeneric"));
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
        .ac-opt-list { display: flex; flex-direction: column; gap: 8px; }
        .ac-opt { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--c-border); border-radius: 10px; cursor: default; }
        .ac-opt.on { box-shadow: inset 0 0 0 1.5px var(--c-brand); background: var(--c-surface-sel); }
        .ac-opt.off { opacity: 0.55; }
        .ac-opt input { margin: 2px 0 0; accent-color: var(--c-brand); }
        .ac-opt > span { display: flex; flex-direction: column; gap: 2px; }
        .ac-opt-title { font-size: 13px; font-weight: 600; color: var(--c-text); display: flex; align-items: center; gap: 6px; }
        .ac-limit-row { display: grid; grid-template-columns: 1fr 140px; gap: 10px; align-items: center; margin-top: 10px; font-size: 13px; color: var(--c-text); }
        .ac-money { display: flex; align-items: center; gap: 4px; border: 1px solid var(--c-border); border-radius: 8px; padding: 6px 10px; background: var(--c-input); }
        .ac-money span { color: var(--c-text-2); font-size: 13px; }
        .ac-money input { border: 0; outline: 0; background: transparent; color: var(--c-text); font-size: 13px; width: 100%; font-family: system-ui, sans-serif; }
        .ac-money:focus-within { border-color: var(--c-brand); }
        .ac-kv { display: flex; justify-content: space-between; font-size: 13px; color: var(--c-text); padding: 4px 0; }
        .ac-bar { height: 8px; border-radius: 4px; background: var(--c-surface-alt, var(--c-hover)); overflow: hidden; margin: 8px 0 6px; }
        .ac-bar div { height: 8px; background: var(--c-brand); }
        .ac-soon { border: 1px dashed var(--c-border-strong); border-radius: 12px; padding: 14px 16px; font-size: 12px; color: var(--c-text-2); line-height: 1.5; }
        .ac-error { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; font-size: 13px; color: var(--c-red); }
        .ac-empty { color: var(--c-text-2); font-size: 14px; text-align: center; padding: 60px 0; }
        /* Dialogs: shared by AddOnBehalf and the statement dialogs. */
        .ac-overlay { position: fixed; inset: 0; background: var(--c-scrim); display: flex; align-items: center; justify-content: center; z-index: 1000; backdrop-filter: blur(3px); }
        .ac-form { background: var(--c-surface); border-radius: 14px; padding: 24px; width: 100%; max-width: 420px; border: 1px solid var(--c-border); box-shadow: 0 20px 60px var(--c-shadow); font-family: system-ui, sans-serif; color: var(--c-text); }
        .ac-form-title { font-size: 17px; font-weight: 700; margin-bottom: 4px; }
        .ac-form-sub { font-size: 13px; color: var(--c-text-2); line-height: 1.5; margin-bottom: 16px; }
        .ac-field { margin-bottom: 14px; display: flex; flex-direction: column; gap: 6px; }
        .ac-label { font-size: 12px; color: var(--c-text-2); font-weight: 500; }
        .ac-check { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; cursor: pointer; }
        .ac-check input { margin-top: 3px; }
        .ac-result { font-size: 13px; margin-top: 12px; display: flex; gap: 8px; align-items: center; }
        .ac-count { background: var(--c-surface-sel); border-radius: 9px; padding: 0 7px; color: var(--c-text); letter-spacing: 0; margin-left: 4px; }
        .ac-applink.compact { margin: 0 16px; padding: 12px; border: 1px solid var(--c-border-subtle); border-radius: 10px; }
        .ac-applink.compact .ac-input { font-size: 11px; }
        .ac-switch { width: 34px; height: 20px; border-radius: 10px; border: none; background: var(--c-border-strong); position: relative; cursor: pointer; flex-shrink: 0; padding: 0; }
        .ac-switch::after { content: ""; position: absolute; left: 2px; top: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--c-surface); transition: left 0.15s; }
        .ac-switch.on { background: var(--c-brand-fill); }
        .ac-switch.on::after { left: 16px; }
        .ac-switch:disabled { cursor: default; opacity: 0.7; }
        @media (max-width: 1100px) { .ac-grid { grid-template-columns: minmax(0, 1fr); } }
      `}</style>

      <div className="ac-panel">
        {pendingApps.length > 0 && (
          <>
            <div className="ac-panel-title">
              {t("accounts.app.listTitle")} <span className="ac-count">{pendingApps.length}</span>
            </div>
            {pendingApps.map((ap) => (
              <button
                key={ap.id}
                className={`ac-acct${ap.id === selectedAppId ? " on" : ""}`}
                onClick={() => setSelectedAppId(ap.id)}
              >
                <span className="ac-acct-name">{ap.business_name}</span>
                <span className="ac-acct-sub">
                  <span className="ac-dot" style={{ background: "var(--c-amber)" }} />
                  {t("accounts.app.listSub", { date: fmtDate(ap.created_at), name: ap.submitted_by_name ?? ap.submitted_by_email })}
                </span>
              </button>
            ))}
            <div style={{ height: 14 }} />
          </>
        )}
        <div className="ac-panel-title">{t("accounts.title")}</div>
        {(accounts ?? []).map((a) => (
          <button
            key={a.id}
            className={`ac-acct${a.id === selectedId && !selectedApp ? " on" : ""}`}
            onClick={() => {
              setSelectedAppId(null);
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
                style={{
                  background:
                    a.status === "active" && a.billing_mode && !owingCents[a.id] ? "var(--c-green)" : "var(--c-amber)",
                }}
              />
              {a.status !== "active"
                ? t("accounts.suspended")
                : owingCents[a.id]
                  ? t("accounts.owingSub", { amount: fmtMoney(owingCents[a.id]) })
                  : a.billing_mode
                    ? t("accounts.activePeople", { count: activeCounts[a.id] ?? 0 })
                    : t("accounts.activeNoBilling")}
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
        <div style={{ marginTop: "auto", paddingTop: 16, display: selectedApp ? "none" : undefined }}>
          <ApplicationLinkCard
            compact
            settings={appSettings}
            isAdmin={isAdmin}
            onChanged={() => setListVersion((v) => v + 1)}
          />
        </div>
      </div>

      <div className="ac-content">
        {error && <div className="ac-error">{error}</div>}
        {selectedApp ? (
          <AccountApplication
            key={selectedApp.id}
            app={selectedApp}
            isAdmin={isAdmin}
            settings={appSettings}
            onSettings={() => setListVersion((v) => v + 1)}
            onDecided={(accountId) => {
              setSelectedAppId(null);
              if (accountId) setSelectedId(accountId);
              setListVersion((v) => v + 1);
            }}
          />
        ) : accounts === null ? (
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
                          {m.name ? (
                            <>
                              <b>{m.name}</b> <span className="ac-small">{m.email}</span>
                            </>
                          ) : (
                            <b>{m.email}</b>
                          )}
                          <div className="ac-small">
                            {m.via_business && <>{t("accounts.viaBusiness")} · </>}
                            {m.last_sign_in_at ? (
                              t("accounts.lastSignIn", { date: fmtDate(m.last_sign_in_at) })
                            ) : (
                              <>
                                {t("accounts.neverSignedIn")}
                                {m.invite_sent_at && ` · ${t("accounts.inviteSent", { date: fmtDate(m.invite_sent_at) })}`}
                                {isAdmin && !m.via_business && (
                                  <>
                                    {" · "}
                                    {resent.has(m.id) ? (
                                      t("accounts.inviteResent")
                                    ) : (
                                      <button className="ac-linkbtn" onClick={() => resendInvite(m)}>
                                        {t("accounts.sendAgain")}
                                      </button>
                                    )}
                                  </>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                        {isAdmin && !m.via_business && (
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

                <BillingCard
                  key={account.id}
                  account={account}
                  isAdmin={isAdmin}
                  onSaved={() => setListVersion((v) => v + 1)}
                />
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

// ── Billing: the mode and the taxi company's ceiling (phase 2a) ──────────────
// Admins set it (ba_set_billing); dispatchers see it. The business's managers
// can set their own limits in the portal, only ever lower: the strictest wins
// (ba_check_limits). Amounts are entered in dollars and stored in cents, the
// booking fee included. Corporate card is phase 2b: shown, not selectable.

function centsToField(c: number | null): string {
  return c == null ? "" : (c / 100).toFixed(2);
}

/** "" -> null (no limit); a positive amount -> cents; anything else -> undefined. */
function fieldToCents(v: string): number | null | undefined {
  const s = v.replace(/[,$\s]/g, "");
  if (s === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
  const c = Math.round(Number(s) * 100);
  return c > 0 ? c : undefined;
}

function BillingCard({
  account,
  isAdmin,
  onSaved,
}: {
  account: Account;
  isAdmin: boolean;
  onSaved: () => void;
}) {
  const { t, i18n } = useTranslation();
  const radioName = useId();
  const monthlyId = useId();
  const perRideId = useId();
  const termsId = useId();
  const [terms, setTerms] = useState(account.payment_terms ?? "");
  const [monthly, setMonthly] = useState(centsToField(account.company_monthly_limit_cents));
  const [perRide, setPerRide] = useState(centsToField(account.company_ride_limit_cents));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [usage, setUsage] = useState<{
    month: string;
    used_cents: number;
    monthly_limit_cents: number | null;
    ride_limit_cents: number | null;
  } | null>(null);
  const [usageVersion, setUsageVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    supabase.rpc("ba_account_usage", { p_account: account.id }).then(({ data }) => {
      if (!alive || !data?.ok) return;
      setUsage(data);
    });
    return () => {
      alive = false;
    };
  }, [account.id, usageVersion]);

  const money = (cents: number) =>
    new Intl.NumberFormat(i18n.language, { style: "currency", currency: "CAD", currencyDisplay: "narrowSymbol" }).format(cents / 100);
  // account_month is a calendar date: format it as one, never through a zone.
  const monthName = usage
    ? new Intl.DateTimeFormat(i18n.language, { month: "long", timeZone: "UTC" }).format(new Date(`${usage.month}T00:00:00Z`))
    : "";

  async function save() {
    const m = fieldToCents(monthly);
    const r = fieldToCents(perRide);
    if (m === undefined || r === undefined) {
      setMsg({ ok: false, text: t("accounts.errBadAmount") });
      return;
    }
    if (terms.trim().length > 120) {
      setMsg({ ok: false, text: t("accounts.errTermsLong") });
      return;
    }
    setBusy(true);
    setMsg(null);
    if (terms.trim() !== (account.payment_terms ?? "")) {
      const tr = await supabase.rpc("ba_set_payment_terms", { p_account: account.id, p_terms: terms.trim() });
      if (tr.error || !tr.data?.ok) {
        setBusy(false);
        setMsg({ ok: false, text: tr.data?.reason === "too_long" ? t("accounts.errTermsLong") : t("accounts.errGeneric") });
        return;
      }
    }
    const { data, error } = await supabase.rpc("ba_set_billing", {
      p_account: account.id,
      p_mode: "invoice",
      p_monthly_cents: m,
      p_ride_cents: r,
    });
    setBusy(false);
    if (error || !data?.ok) {
      setMsg({ ok: false, text: data?.reason === "bad_limit" ? t("accounts.errBadAmount") : t("accounts.errGeneric") });
      return;
    }
    setMsg({ ok: true, text: t("accounts.billingSaved") });
    setUsageVersion((v) => v + 1);
    onSaved();
  }

  const managerLower =
    (account.manager_monthly_limit_cents != null &&
      (account.company_monthly_limit_cents == null ||
        account.manager_monthly_limit_cents < account.company_monthly_limit_cents)) ||
    (account.manager_ride_limit_cents != null &&
      (account.company_ride_limit_cents == null ||
        account.manager_ride_limit_cents < account.company_ride_limit_cents));
  const usedPct =
    usage?.monthly_limit_cents ? Math.min(100, (usage.used_cents / usage.monthly_limit_cents) * 100) : 0;

  return (
    <>
      <div className="ac-card">
        <div className="ac-card-label">
          <span>{t("accounts.billingTitle")}</span>
        </div>
        <div className="ac-opt-list" role="radiogroup" aria-label={t("accounts.billingTitle")}>
          <label className={`ac-opt${account.billing_mode === "invoice" || isAdmin ? " on" : ""}`}>
            <input type="radio" name={radioName} checked readOnly disabled={!isAdmin} />
            <span>
              <span className="ac-opt-title">{t("accounts.billingInvoice")}</span>
              <span className="ac-small">{t("accounts.billingInvoiceNote")}</span>
            </span>
          </label>
          <label className="ac-opt off">
            <input type="radio" name={radioName} disabled />
            <span>
              <span className="ac-opt-title">
                {t("accounts.billingCard")} <span className="ac-ro">{t("accounts.comingSoon")}</span>
              </span>
              <span className="ac-small">{t("accounts.billingCardNote")}</span>
            </span>
          </label>
        </div>
        {!account.billing_mode && (
          <div className="ac-small" style={{ color: "var(--c-amber-text)", marginTop: 8 }}>
            {isAdmin ? t("accounts.noBillingAdmin") : t("accounts.noBillingDispatcher")}
          </div>
        )}

        <div className="ac-card-label" style={{ marginTop: 16, marginBottom: 2 }}>
          <span>{t("accounts.ceilingTitle")}</span>
        </div>
        <div className="ac-small">{t("accounts.ceilingNote")}</div>
        <div className="ac-limit-row">
          <label htmlFor={monthlyId}>{t("accounts.perMonth")}</label>
          <div className="ac-money">
            <span>$</span>
            <input
              id={monthlyId}
              inputMode="decimal"
              value={monthly}
              placeholder={t("accounts.noLimit")}
              disabled={!isAdmin}
              onChange={(e) => setMonthly(e.target.value)}
            />
          </div>
        </div>
        <div className="ac-limit-row">
          <label htmlFor={perRideId}>{t("accounts.perRide")}</label>
          <div className="ac-money">
            <span>$</span>
            <input
              id={perRideId}
              inputMode="decimal"
              value={perRide}
              placeholder={t("accounts.noLimit")}
              disabled={!isAdmin}
              onChange={(e) => setPerRide(e.target.value)}
            />
          </div>
        </div>
        <div className="ac-field" style={{ marginTop: 16, marginBottom: 0 }}>
          <label className="ac-card-label" htmlFor={termsId} style={{ marginBottom: 2 }}>
            <span>{t("accounts.termsLabel")}</span>
          </label>
          <input
            id={termsId}
            className="ac-input"
            maxLength={120}
            value={terms}
            placeholder={t("accounts.termsPlaceholder")}
            disabled={!isAdmin}
            onChange={(e) => setTerms(e.target.value)}
          />
          <div className="ac-small">{t("accounts.termsNote")}</div>
        </div>
        {msg && (
          <div className="ac-small" style={{ marginTop: 8, color: msg.ok ? "var(--c-green)" : "var(--c-red)" }}>
            {msg.text}
          </div>
        )}
        {isAdmin && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
            <button className="ac-btn ac-btn-primary" disabled={busy} onClick={save}>
              {t("accounts.saveBilling")}
            </button>
          </div>
        )}
      </div>

      {usage && (
        <div className="ac-card">
          <div className="ac-card-label">
            <span>{t("accounts.thisMonth", { month: monthName })}</span>
          </div>
          <div className="ac-kv">
            <span>{t("accounts.bookedSoFar")}</span>
            <b>{money(usage.used_cents)}</b>
          </div>
          {usage.monthly_limit_cents != null && (
            <div className="ac-bar" aria-hidden="true">
              <div style={{ width: `${usedPct}%` }} />
            </div>
          )}
          <div className="ac-small">
            {usage.monthly_limit_cents != null
              ? t("accounts.limitMonthly", { amount: money(usage.monthly_limit_cents) })
              : t("accounts.noMonthlyLimit")}
            {usage.ride_limit_cents != null && ` ${t("accounts.limitRide", { amount: money(usage.ride_limit_cents) })}`}
            {managerLower && ` ${t("accounts.managerLower")}`}
          </div>
        </div>
      )}

      {account.billing_mode === "invoice" && (
        <AccountStatements accountId={account.id} isAdmin={isAdmin} usage={usage} onChanged={onSaved} />
      )}
    </>
  );
}
