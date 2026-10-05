import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useSubView } from "../lib/viewPath";
import { formatRideRef } from "../lib/numbering";
import {
  AreaChart, Area, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import type { Ride } from "../types";
import { supabase } from "../lib/supabase";
import { logDispatchEvent } from "../lib/logDispatchEvent";
import i18next from "i18next";
import { useTranslation } from "react-i18next";
import { fmtDate, fmtDateTime, fmtMonthYear, fmtTime, monthShort, weekdayShort } from "../i18n/format";
import {
  CANCEL_REASON_KEYS,
  noShowEvidence,
  REFUND_REASON_KEYS,
  REPORT_REASON_KEYS,
  rideStatusLabel,
  SETTLEMENT_ROUTE_KEYS,
} from "../lib/labels";

// Module-scope wrappers, because half this file's label lookups live in
// non-component helpers (the CSV builders, the print-HTML builders, the
// activity-feed summariser) that cannot hold a hook. Each falls back to the
// raw column value, as the maps they replaced did.
const reportReasonLabel = (reason: string) =>
  REPORT_REASON_KEYS[reason] ? i18next.t(REPORT_REASON_KEYS[reason]) : reason;
const settlementRouteLabel = (route: string | null | undefined) =>
  route && SETTLEMENT_ROUTE_KEYS[route] ? i18next.t(SETTLEMENT_ROUTE_KEYS[route]) : (route ?? "—");
const refundReasonLabel = (reason: string) =>
  REFUND_REASON_KEYS[reason] ? i18next.t(REFUND_REASON_KEYS[reason]) : reason;
const cancelReasonLabel = (reason: string) =>
  CANCEL_REASON_KEYS[reason] ? i18next.t(CANCEL_REASON_KEYS[reason]) : reason;

const esc = (s: string | null | undefined) =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── Types ─────────────────────────────────────────────────────────────
interface DayRevenue {
  day: string;
  revenue: number;
  rides: number;
}
interface HourRevenue {
  label: string;
  revenue: number;
  rides: number;
}
interface DriverStat {
  id: string;
  name: string;
  avatarUrl: string | null;
  rides: number;
  ridesTotal: number;
  earnings: number;
  cashEarnings: number;
  cardEarnings: number;
  cancelRate: number;
  cancelled: number;
  avgFare: number;
  avgRating: number | null;
  ratingCount: number;
  recentReviews: { rating: number; comment: string; created_at: string }[];
}
interface HourStat {
  hour: number;
  label: string;
  rides: number;
}
interface DayStat {
  day: string;
  rides: number;
}
// Carries the whole rides row, not a hand-picked subset. The old version named
// ~20 columns explicitly and copied them one by one out of an `any`, so a column
// added to `rides` was silently absent here — undefined, no error, the UI just
// rendered nothing — until someone remembered to add it in both the interface
// and the map below. arrived_at/no_show_at were the ones that caught it. The
// three fields here are genuinely derived (joined lookups, not row columns).
interface RideRow extends Ride {
  passenger_name: string;
  driver_name: string;
  receipt_number: string | null;
}
interface ReviewRow {
  id: string;
  rating: number;
  comment: string | null;
  created_at: string;
  driver_name: string | null;
  passenger_name: string | null;
  pickup_address: string;
  dropoff_address: string;
  driver_id: string;
  reviewed_by_dispatch: boolean;
}
interface MonthGroup {
  key: string;
  label: string;
  rides: RideRow[];
  totalRevenue: number;
}
interface RideDetailModal {
  ride: RideRow;
  review: ReviewRow | null;
}
interface SettlementRideRow {
  id: string;
  // NOT NULL in the DB (20260774 backfills, then sets NOT NULL), so no display
  // site needs a fallback.
  ride_ref: string;
  completed_at: string | null;
  created_at: string;
  fare_final: number | null;
  // Net actually transferred out (after Vellon + Stripe fees), in cents --
  // the frozen capture-time snapshot. Used for the "to pay out" figure, which
  // is what the driver is actually owed, not the gross fare.
  transfer_amount_cents: number | null;
  driver_name: string;
  settlement_route: string;
  settlement_resolved_at: string | null;
  stripe_dispute_id: string | null;
}
interface EventRow {
  id: string;
  created_at: string;
  event_type: string;
  ride_id: string | null;
  details: Record<string, any>;
  dispatcher_name: string | null;
}
interface ReceiptRow {
  id: string;
  receipt_number: string;
  ride_id: string | null;
  passenger_name: string | null;
  driver_name: string | null;
  company_name: string | null;
  hst_number: string | null;
  pickup_address: string | null;
  dropoff_address: string | null;
  fare: number;
  pre_discount_fare: number | null;
  discount_amount: number | null;
  discount_label: string | null;
  payment_method: string | null;
  sent_at: string;
  // What was PRINTED on this receipt, snapshotted at send time
  // (20260930000000 + 20261001020000). NULL tax_rate_percent/tax_amount means
  // no tax line was printed — not a zero one. `select("*")` was already
  // returning all three; only this type and the math below were behind.
  // Typed loosely because PostgREST can hand back `numeric` as a string.
  tax_rate_percent: number | string | null;
  tax_amount: number | string | null;
  tax_label: string | null;
}

/**
 * The receipt's tax block, read off the row rather than recomputed.
 *
 * This replaces `fare / 1.15` in the two places the dashboard renders a
 * receipt. Three things were wrong with that, in increasing order of severity:
 *
 *  1. The rate. Nova Scotia moved to 14% on 2025-04-01, so `1.15` has been
 *     wrong since. `send-ride-receipt` fixed this by freezing the rate per
 *     ride; the dashboard kept the literal and so disagreed with the emailed
 *     receipt for the same ride.
 *  2. The gate. The split was drawn UNCONDITIONALLY, gating only the
 *     registration line on `hst_number`. A company under the $30k
 *     small-supplier threshold — ordinary for a Valley operator — got a
 *     dashboard receipt claiming tax it never collected and cannot remit, off
 *     which a passenger could claim an input tax credit.
 *  3. Recomputing at all. The amount printed was rounded once at send time and
 *     stored; deriving it again from fare and rate is how two copies of one
 *     figure disagree by a cent.
 *
 * So: no rate constant, and no arithmetic beyond `fare - tax_amount`. The
 * `taxed` gate is byte-for-byte the function's own (`taxRatePercent != null &&
 * taxAmount != null`), because the point is that the two documents agree.
 *
 * A receipt sent BEFORE those migrations has all three columns NULL and so
 * prints no tax line. That is deliberate and matches the function's choice: an
 * understated receipt is a lesser defect than one asserting uncollected tax.
 */
function receiptTax(r: ReceiptRow) {
  const num = (v: number | string | null) =>
    v == null || v === "" ? null : Number(v);
  const rate = num(r.tax_rate_percent);
  const amount = num(r.tax_amount);
  const taxed = rate != null && rate > 0 && amount != null && Number.isFinite(amount);
  return {
    taxed,
    subtotal: taxed ? r.fare - amount! : null,
    amount,
    // Matches the function's formatRate: 14.00 prints as "14", 14.50 as "14.5".
    rateText: rate == null ? "" : String(Number(rate.toFixed(2))),
    label: r.tax_label,
  };
}

// REASON_LABELS, STATUS_LABELS, CANCEL_REASON_LABELS, SETTLEMENT_ROUTE_LABELS,
// REFUND_REASON_LABELS and noShowEvidence() moved to src/lib/labels.ts when
// they became translation keys — all six were copy-pasted from DashboardPage
// verbatim. The COLOR maps and the terse SETTLEMENT_ROUTE_SHORT stay here:
// colors are styling, and the short labels have no second reader.

// Keys, not English. Resolved at the render site via eventLabel().
const EVENT_LABEL_KEYS: Record<string, string> = {
  "ride.created": "event.rideCreated",
  "ride.cancelled": "event.rideCancelled",
  "ride.assigned": "event.rideAssigned",
  "ride.reassigned": "event.rideReassigned",
  "ride.scheduled_modified": "event.rideScheduledModified",
  "ride.route_modified": "event.rideRouteModified",
  "ride.notes_added": "event.rideNotesAdded",
  "ride.fare_changed": "event.rideFareChanged",
  "driver.suspended": "event.driverSuspended",
  "driver.reactivated": "event.driverReactivated",
  "driver.deleted": "event.driverDeleted",
  "driver.vehicle_updated": "event.driverVehicleUpdated",
  "invite.created": "event.inviteCreated",
  "invite.revoked": "event.inviteRevoked",
  "discount.created": "event.discountCreated",
  "discount.deactivated": "event.discountDeactivated",
  "discount.deleted": "event.discountDeleted",
  "report.reviewed": "event.reportReviewed",
  "report.dismissed": "event.reportDismissed",
  "report.printed": "event.reportPrinted",
  "announcement.drivers": "event.announcementDrivers",
  "announcement.passengers": "event.announcementPassengers",
  "escalation.acknowledged": "event.escalationAcknowledged",
  "export.csv": "event.exportCsv",
  "export.pdf": "event.exportPdf",
  "invoice.printed": "event.invoicePrinted",
  "settings.pricing_updated": "event.settingsPricingUpdated",
  "settings.contact_updated": "event.settingsContactUpdated",
  "settings.numbering_updated": "event.settingsNumberingUpdated",
  "ride.flag_resolved": "event.rideFlagResolved",
  "settings.vehicle_class_created": "event.settingsVehicleClassCreated",
  "settings.vehicle_class_updated": "event.settingsVehicleClassUpdated",
  "settings.vehicle_class_status_changed": "event.settingsVehicleClassStatusChanged",
  "staff.created": "event.staffCreated",
  "staff.updated": "event.staffUpdated",
  "staff.deactivated": "event.staffDeactivated",
  "staff.reactivated": "event.staffReactivated",
  "dispatch_report.submitted": "event.dispatchReportSubmitted",
  "settlement.resolved": "event.settlementResolved",
  "driver.number_changed": "event.driverNumberChanged",
  "driver.car_number_changed": "event.driverCarNumberChanged",
};
const eventLabel = (ev: string) =>
  EVENT_LABEL_KEYS[ev] ? i18next.t(EVENT_LABEL_KEYS[ev]) : ev;
const EVENT_COLORS: Record<string, string> = {
  "ride.created": "#1D9E75",
  "ride.cancelled": "#E24B4A",
  "ride.assigned": "#4a9eff",
  "ride.reassigned": "#60A5FA",
  "ride.scheduled_modified": "#A855F7",
  "ride.route_modified": "#A855F7",
  "ride.notes_added": "#6B7280",
  "ride.fare_changed": "#F59E0B",
  "driver.suspended": "#F59E0B",
  "driver.reactivated": "#1D9E75",
  "driver.deleted": "#E24B4A",
  "driver.vehicle_updated": "#60A5FA",
  "invite.created": "#1D9E75",
  "invite.revoked": "#E24B4A",
  "discount.created": "#E8500A",
  "discount.deactivated": "#6B7280",
  "discount.deleted": "#E24B4A",
  "report.reviewed": "#60A5FA",
  "report.dismissed": "#6B7280",
  "report.printed": "#A855F7",
  "announcement.drivers": "#60A5FA",
  "announcement.passengers": "#60A5FA",
  "escalation.acknowledged": "#F59E0B",
  "export.csv": "#6B7280",
  "export.pdf": "#6B7280",
  "invoice.printed": "#A855F7",
  "settings.pricing_updated": "#F59E0B",
  "settings.contact_updated": "#F59E0B",
  "settings.numbering_updated": "#6B7280",
  "ride.flag_resolved": "#1D9E75",
  "settings.vehicle_class_created": "#1D9E75",
  "settings.vehicle_class_updated": "#60A5FA",
  "settings.vehicle_class_status_changed": "#6B7280",
  "staff.created": "#1D9E75",
  "staff.updated": "#60A5FA",
  "staff.deactivated": "#F59E0B",
  "staff.reactivated": "#1D9E75",
  "dispatch_report.submitted": "#A855F7",
  "settlement.resolved": "#1D9E75",
  "driver.number_changed": "#60A5FA",
  "driver.car_number_changed": "#60A5FA",
};

function formatEventDetails(type: string, details: any): string {
  if (!details) return "—";
  switch (type) {
    case "ride.created":
      return [
        details.passenger_name,
        details.pickup_address && details.dropoff_address
          ? `${details.pickup_address} → ${details.dropoff_address}`
          : null,
        details.fare != null ? `$${Number(details.fare).toFixed(2)}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "ride.cancelled":
      return [
        details.passenger_name,
        details.pickup_address && details.dropoff_address
          ? `${details.pickup_address} → ${details.dropoff_address}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "ride.assigned":
      return details.driver_name ?? "—";
    case "ride.reassigned":
      return `${details.from_driver_name ?? "?"} → ${details.to_driver_name ?? "?"}`;
    case "ride.fare_changed":
      return `$${Number(details.original_fare ?? 0).toFixed(2)} → $${Number(details.new_fare ?? 0).toFixed(2)}`;
    case "ride.scheduled_modified":
      return [
        details.pickup_address && details.dropoff_address
          ? `${details.pickup_address} → ${details.dropoff_address}`
          : null,
        details.fare != null ? `$${Number(details.fare).toFixed(2)}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "driver.suspended":
    case "driver.reactivated":
    case "driver.deleted":
      return details.driver_name ?? "—";
    case "driver.vehicle_updated": {
      const parts = [
        details.driver_name,
        [details.make, details.model, details.year].filter(Boolean).join(" ") || null,
        details.plate || null,
        details.vehicle_class || null,
      ].filter(Boolean);
      return parts.join(" · ") || "—";
    }
    case "invite.created":
      return `${i18next.t("activity.code")}: ${details.code}${details.name ? ` · ${details.name}` : ""}`;
    case "invite.revoked":
      return `${i18next.t("activity.code")}: ${details.code}${details.name ? ` (${details.name})` : ""}`;
    case "discount.created":
      return `${details.code}${details.label ? ` — ${details.label}` : ""} · ${
        details.amount_type === "percent"
          ? i18next.t("booking.percentOff", { n: details.amount })
          : i18next.t("booking.amountOff", { amount: details.amount })
      }`;
    case "discount.deactivated":
    case "discount.deleted":
      return `${details.code}${details.label ? ` — ${details.label}` : ""}`;
    case "report.reviewed":
    case "report.dismissed":
    case "report.printed":
      return [
        details.driver_name,
        details.reason ? (reportReasonLabel(details.reason as string)) : null,
      ].filter(Boolean).join(" · ");
    case "announcement.drivers":
    case "announcement.passengers":
      return details.title ?? "—";
    case "invoice.printed":
      return [
        details.receipt_number,
        details.passenger_name,
        details.fare != null ? `$${Number(details.fare).toFixed(2)}` : null,
      ].filter(Boolean).join(" · ");
    case "settings.pricing_updated":
      return [
        details.base_fare_from != null && details.base_fare_to != null
          ? i18next.t("activity.baseFareChange", {
              from: Number(details.base_fare_from).toFixed(2),
              to: Number(details.base_fare_to).toFixed(2),
            })
          : null,
        details.rate_per_km_from != null && details.rate_per_km_to != null
          ? i18next.t("activity.rateChange", {
              from: Number(details.rate_per_km_from).toFixed(2),
              to: Number(details.rate_per_km_to).toFixed(2),
            })
          : null,
      ].filter(Boolean).join(" · ");
    // Deliberately reports set/cleared rather than the values: this feed is
    // visible to every admin at the company, and a support address is fine there
    // but the row does not need to be a second copy of it.
    case "settings.contact_updated":
      return [
        details.phone_set ? i18next.t("activity.phoneSet") : i18next.t("activity.phoneCleared"),
        details.support_email_set
          ? i18next.t("activity.supportEmailSet")
          : i18next.t("activity.supportEmailCleared"),
      ].join(" · ");
    case "settings.numbering_updated":
      return [
        details.car_number_prefix != null || details.car_number_pad != null
          ? i18next.t("activity.carFormat", {
              format: `${details.car_number_prefix ?? ""}${"0".repeat(Number(details.car_number_pad ?? 0))}`,
            }) +
            (details.car_number_start != null
              ? ` ${i18next.t("activity.fromN", { n: details.car_number_start })}`
              : "")
          : null,
        details.driver_number_prefix != null || details.driver_number_pad != null
          ? i18next.t("activity.driverFormat", {
              format: `${details.driver_number_prefix ?? ""}${"0".repeat(Number(details.driver_number_pad ?? 0))}`,
            })
          : null,
      ].filter(Boolean).join(" · ") || "—";
    case "settings.vehicle_class_created":
      return `${details.name ?? "—"} · ${i18next.t("drivers.seats", {
        count: Number(details.capacity ?? 0),
      })} · +${details.surcharge_percent ?? 0}%`;
    case "settings.vehicle_class_updated": {
      const parts = [details.name];
      if (details.capacity_from != null && details.capacity_to != null && details.capacity_from !== details.capacity_to) {
        parts.push(i18next.t("activity.seatsChange", {
          from: details.capacity_from,
          to: details.capacity_to,
        }));
      }
      if (details.surcharge_percent_from != null && details.surcharge_percent_to != null && details.surcharge_percent_from !== details.surcharge_percent_to) {
        parts.push(i18next.t("activity.surchargeChange", {
          from: details.surcharge_percent_from,
          to: details.surcharge_percent_to,
        }));
      }
      if (details.name_from != null && details.name_to != null && details.name_from !== details.name_to) {
        parts[0] = `${details.name_from} → ${details.name_to}`;
      }
      return parts.filter(Boolean).join(" · ") || "—";
    }
    case "settings.vehicle_class_status_changed":
      return `${details.name ?? "—"} · ${
        details.is_active ? i18next.t("activity.activated") : i18next.t("common.deactivated")
      }`;
    case "staff.created":
      return [
        details.name,
        details.role
          ? i18next.t(details.role === "admin" ? "settings.role.admin" : "settings.role.dispatcher")
          : null,
      ].filter(Boolean).join(" · ") || "—";
    case "staff.updated": {
      const parts: string[] = [];
      if (details.name_from != null && details.name_to != null) {
        parts.push(`${details.name_from} → ${details.name_to}`);
      } else if (details.name) {
        parts.push(details.name);
      }
      if (details.phone_from != null && details.phone_to != null) {
        parts.push(`${details.phone_from} → ${details.phone_to}`);
      }
      return parts.join(" · ") || "—";
    }
    case "staff.deactivated":
    case "staff.reactivated":
      return details.name ?? "—";
    case "dispatch_report.submitted": {
      const categoryKeys: Record<string, string> = {
        bug: "activity.categoryBug",
        driver_issue: "settings.reportCategory.driverIssue",
        billing: "activity.categoryBilling",
        feature_request: "settings.reportCategory.featureRequest",
        other: "settings.reportCategory.other",
      };
      const cat = details.category as string | undefined;
      return cat ? (categoryKeys[cat] ? i18next.t(categoryKeys[cat]) : cat) : "—";
    }
    case "export.csv":
    case "export.pdf": {
      const sectionKeys: Record<string, string> = {
        revenue: "analytics.sections.revenue",
        ride_history: "analytics.sections.rides",
        drivers: "analytics.sections.drivers",
        reviews: "analytics.sections.reviews",
        activity_log: "analytics.sections.activity",
      };
      const sec = details.section as string | undefined;
      const sectionLabel = sec && sectionKeys[sec] ? i18next.t(sectionKeys[sec]) : (sec ?? "");
      const parts = [sectionLabel];
      if (details.period) parts.push(String(details.period));
      if (details.row_count != null)
        parts.push(i18next.t("activity.rowCount", { count: Number(details.row_count) }));
      return parts.filter(Boolean).join(" · ");
    }
    default:
      return "—";
  }
}

type Section = "revenue" | "rides" | "reviews" | "drivers" | "activity" | "receipts" | "settlements";
// Keys, not English — module scope runs before any language is active.
const SECTION_ITEMS: { id: Section; labelKey: string }[] = [
  { id: "revenue", labelKey: "analytics.sections.revenue" },
  { id: "rides", labelKey: "analytics.sections.rides" },
  { id: "settlements", labelKey: "analytics.sections.settlements" },
  { id: "reviews", labelKey: "analytics.sections.reviews" },
  { id: "drivers", labelKey: "analytics.sections.drivers" },
  { id: "activity", labelKey: "analytics.sections.activity" },
  { id: "receipts", labelKey: "analytics.sections.receipts" },
];
// Bound to /analytics/<section>. No section here is role-gated, so every id is
// reachable by anyone who can open Analytics at all.
const SECTION_IDS = SECTION_ITEMS.map(s => s.id);

// Needs a human to manually move money -- the only settlement_route values
// that ever warrant a "Mark resolved" action. transfer_reversed (dispute
// open or lost) is deliberately excluded: an open dispute resolves itself
// automatically via the stripe-webhook dispute.closed handler, and a LOST
// dispute's reversal is the correct final state -- nothing for dispatch to
// collect or send either way, it's Vellon's own P&L exposure, not theirs.
const SETTLEMENT_ACTIONABLE_ROUTES = [
  "platform_invoiced",
  "transfer_failed",
  "reversal_failed",
  "retransfer_failed",
] as const;

const SETTLEMENT_ACTION_HINT_KEYS: Record<string, string> = {
  platform_invoiced: "settlementHint.platformInvoiced",
  transfer_failed: "settlementHint.transferFailed",
  reversal_failed: "settlementHint.reversalFailed",
  retransfer_failed: "settlementHint.retransferFailed",
};
const STATUS_COLORS: Record<string, string> = {
  pending: "#F59E0B",
  assigned: "#4a9eff",
  driver_arriving: "#4a9eff",
  in_progress: "#E8500A",
  completed: "#1D9E75",
  cancelled: "#E24B4A",
  scheduled: "#A855F7",
};



// Terse labels for the dispatch-internal settlement tables/chips. The long
// SETTLEMENT_ROUTE_LABELS copy above reads as a sentence, which is right for
// a single ride-detail row or a printed receipt but unreadable as a table
// cell or a filter chip repeated eight times down a column.
const SETTLEMENT_ROUTE_SHORT_KEYS: Record<string, string> = {
  driver_transfer: "settlementShort.driverTransfer",
  company_transfer: "settlementShort.companyTransfer",
  platform_invoiced: "settlementShort.platformInvoiced",
  transfer_failed: "settlementShort.transferFailed",
  transfer_reversed: "settlementShort.transferReversed",
  refund_reversed: "settlementShort.refundReversed",
  refund_review: "settlementShort.refundReview",
  reversal_failed: "settlementShort.reversalFailed",
  retransfer_failed: "settlementShort.retransferFailed",
  unsettled: "settlementShort.unsettled",
};
const settlementShort = (route: string | null | undefined) =>
  route && SETTLEMENT_ROUTE_SHORT_KEYS[route]
    ? i18next.t(SETTLEMENT_ROUTE_SHORT_KEYS[route])
    : (route ?? "—");

const SETTLEMENT_ROUTE_COLORS: Record<string, string> = {
  driver_transfer: "#1D9E75",
  company_transfer: "#4a9eff",
  platform_invoiced: "#F59E0B",
  transfer_reversed: "#A855F7",
  refund_reversed: "#A855F7",
  refund_review: "#F59E0B",
  transfer_failed: "#E24B4A",
  reversal_failed: "#E24B4A",
  retransfer_failed: "#E24B4A",
  unsettled: "#6B7280",
};
const settlementColor = (route: string) => SETTLEMENT_ROUTE_COLORS[route] ?? "#6B7280";

// The dollar amount a needs-attention row actually concerns. For everything that
// is a driver payout being sent, re-sent, or clawed back (transfer_failed,
// retransfer_failed, reversal_failed) that's the driver's NET share -- paying or
// recovering the gross fare would be off by the Vellon + Stripe fee. Only
// platform_invoiced is genuinely gross: it's the full captured fare parked on
// Vellon's balance, to be collected and then paid out. Falls back to gross if
// the net snapshot is somehow missing.
const settlementOwedAmount = (r: {
  settlement_route: string;
  fare_final: number | null;
  transfer_amount_cents: number | null;
}): number => {
  if (r.settlement_route === "platform_invoiced") return r.fare_final ?? 0;
  return r.transfer_amount_cents != null
    ? r.transfer_amount_cents / 100
    : (r.fare_final ?? 0);
};

// Round a chart's y-max up to a clean tick (1/2/2.5/5/10 x a power of ten) so
// axis labels read as real dollar figures, not a fraction of the tallest bar.
const niceCeil = (n: number): number => {
  if (n <= 0) return 100;
  const mag = Math.pow(10, Math.floor(Math.log10(n)));
  const step = [1, 2, 2.5, 5, 10].find((s) => s >= n / mag) ?? 10;
  return step * mag;
};

// The four actionable routes are NOT the same kind of todo -- two are money
// dispatch has to collect, two are money they have to send. Summing them into
// one "$ outstanding" figure would net a receivable against a payable and
// show a number that means nothing, so the Needs Attention header splits them.
// Caveat on reversal_failed: it doesn't record which route the ride settled
// through originally, so "collect" is only strictly right when the money went
// to the driver (driver_transfer). If it had gone to the company's own Connect
// account, that money is owed *by* the company, not to it. Wording is kept
// direction-neutral ("needs collection") rather than claiming who owes whom.
const SETTLEMENT_DIRECTION: Record<string, "collect" | "payout"> = {
  platform_invoiced: "collect",
  reversal_failed: "collect",
  transfer_failed: "payout",
  retransfer_failed: "payout",
};

// Groupings for the period rollup tiles. Note these are gross fares by route
// over the selected period, INCLUDING rides already marked resolved -- the
// rollup answers "where did the card money go", not "what's outstanding".
// Anything outstanding comes from the all-time needsAttention list instead.
const ROLLUP_SETTLED_ROUTES = ["driver_transfer", "company_transfer"];
const ROLLUP_PROBLEM_ROUTES = [
  "transfer_failed",
  "transfer_reversed",
  "reversal_failed",
  "retransfer_failed",
];

// ── PDF / CSV helpers ─────────────────────────────────────────────────
// A function, not a constant: a module-scope template literal is evaluated at
// import time, which would freeze whatever language the tab booted in. Every
// call site reads it at render/print time instead.
const approvalBlock = () => `
  <div style="margin-top:36px;padding-top:18px;border-top:1px solid #e5e7eb;">
    <div style="font-size:10px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:18px;">${esc(i18next.t("reports.authorization"))}</div>
    <div style="display:flex;gap:40px;">
      <div>
        <div style="width:210px;border-bottom:1px solid #374151;height:26px;"></div>
        <div style="font-size:10px;color:#9ca3af;margin-top:4px;">${esc(i18next.t("reports.authorizedBy"))}</div>
      </div>
      <div>
        <div style="width:160px;border-bottom:1px solid #374151;height:26px;"></div>
        <div style="font-size:10px;color:#9ca3af;margin-top:4px;">${esc(i18next.t("reports.signature"))}</div>
      </div>
      <div>
        <div style="width:110px;border-bottom:1px solid #374151;height:26px;"></div>
        <div style="font-size:10px;color:#9ca3af;margin-top:4px;">${esc(i18next.t("reports.date"))}</div>
      </div>
    </div>
  </div>`;

function printReport(title: string, html: string, companyLabel = "M&G C&J") {
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(`<!DOCTYPE html><html><head>
    <title>${title}</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: -apple-system, system-ui, sans-serif; color: #111; padding: 40px; font-size: 13px; }
      h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
      .sub { color: #666; font-size: 12px; margin-bottom: 28px; }
      .kpi-row { display: flex; gap: 16px; margin-bottom: 28px; flex-wrap: wrap; }
      .kpi { border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px 18px; min-width: 120px; }
      .kpi-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; margin-bottom: 4px; }
      .kpi-value { font-size: 22px; font-weight: 700; }
      table { width: 100%; border-collapse: collapse; margin-top: 8px; }
      th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; text-align: left; padding: 8px 10px; border-bottom: 1px solid #e5e7eb; }
      td { font-size: 13px; padding: 9px 10px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
      tr:last-child td { border-bottom: none; }
      .section-title { font-size: 14px; font-weight: 600; margin: 24px 0 12px; color: #111; }
      .footer { margin-top: 40px; font-size: 11px; color: #9ca3af; border-top: 1px solid #f3f4f6; padding-top: 12px; }
      .month-section + .month-section { break-before: page; padding-top: 48px; }
      .month-heading-row { font-size: 14px; font-weight: 600; color: #111; margin-bottom: 10px; }
      thead { display: table-header-group; }
      tfoot { display: table-footer-group; }
      .pg-spacer td, .pg-spacer-sm td, .pg-spacer-foot td { border: none !important; padding: 0 !important; height: 0; }
      @page { margin: 0; }
      @media print {
        body { padding: 48px 56px; }
        .pg-spacer td, .pg-spacer-foot td { height: 48px; }
        .pg-spacer-sm td { height: 36px; }
      }
    </style>
  </head><body>${html}<div class="footer">${esc(
    i18next.t("analytics.printFooter", {
      company: companyLabel,
      when: fmtDateTime(new Date()),
    }),
  )}</div></body></html>`);
  win.document.close();
  setTimeout(() => {
    win.print();
  }, 400);
}

function downloadCSV(filename: string, headers: string[], rows: string[][]) {
  const escape = (v: string | null | undefined) => {
    const s = v ?? '';
    const safe = /^[=+\-@\t]/.test(s) ? `\t${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const csv = [headers, ...rows].map((r) => r.map(escape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Date helpers ──────────────────────────────────────────────────────
function getMonthKey(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function getMonthLabel(key: string) {
  const [year, month] = key.split("-");
  // fmtMonthYear, not a hardcoded tag: these headings are DERIVED from a
  // YYYY-MM key, so the English month names appear nowhere as a string and no
  // scanner of literals could ever have found them.
  return fmtMonthYear(Number(year), Number(month));
}
function getCurrentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// ── Main component ────────────────────────────────────────────────────
export default function AnalyticsPage({
  companyName,
  companyId,
  dispatcherId,
}: {
  companyName?: string | null;
  companyId: string;
  dispatcherId: string;
}) {
  const { t } = useTranslation();
  // These two are rendered AND compared against (the receipt's total row gets
  // emphasis, the settlement row gets a warning style). Comparing a rendered
  // label against a raw English literal is true in English and never true in
  // any other language, so both sides read the same t() call through one const.
  const totalLabel = t("receipt.total");
  const settlementLabel = t("rideDetail.settlement");
  const label = companyName ?? "M&G C&J";
  const [section, setSection] = useSubView<Section>("analytics", SECTION_IDS, "revenue");
  const [period, setPeriod] = useState<"today" | "week" | "month" | "year">(
    "month",
  );

  // Revenue
  const [dailyData, setDailyData] = useState<DayRevenue[]>([]);
  const [hourlyData, setHourlyData] = useState<HourRevenue[]>([]);
  const [driverStats, setDriverStats] = useState<DriverStat[]>([]);
  const [totals, setTotals] = useState({
    revenue: 0,
    rides: 0,
    avgFare: 0,
    cancelRate: 0,
    cashRevenue: 0,
    cardRevenue: 0,
    cashRides: 0,
    cardRides: 0,
    revenueToday: 0,
    revenueWeek: 0,
    revenueMonth: 0,
    revenueYear: 0,
  });
  const [revenueLoading, setRevenueLoading] = useState(true);

  // Ride history
  const [allRides, setAllRides] = useState<RideRow[]>([]);
  const [rideFilter, setRideFilter] = useState<string>("all");
  const [rideSearch, setRideSearch] = useState("");
  const [ridesLoading, setRidesLoading] = useState(true);
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(
    new Set([getCurrentMonthKey()]),
  );
  const [selectedYear, setSelectedYear] = useState<number>(
    new Date().getFullYear(),
  );
  const [rideDetail, setRideDetail] = useState<RideDetailModal | null>(null);
  const [driverDetail, setDriverDetail] = useState<DriverStat | null>(null);
  const [printingRide, setPrintingRide] = useState(false);

  // Reviews
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [reviewsLoading, setReviewsLoading] = useState(true);
  const [reviewDriverFilter, setReviewDriverFilter] = useState<string>("all");
  const [reviewStarFilter, setReviewStarFilter] = useState<number | null>(null);
  const [markingReviewed, setMarkingReviewed] = useState<string | null>(null);

  // Activity log
  const [activityEvents, setActivityEvents] = useState<EventRow[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityDateFrom, setActivityDateFrom] = useState<string>(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  });
  const [activityDateTo, setActivityDateTo] = useState<string>(() => {
    return new Date().toISOString().slice(0, 10);
  });
  const [activityTypeFilter, setActivityTypeFilter] = useState<string>("all");
  const [activityError, setActivityError] = useState<string | null>(null);
  const activityFetchId = useRef(0);
  const fetchActivityLogRef = useRef<(silent?: boolean) => void>(() => {});
  const ridesDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Receipts
  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [receiptsLoading, setReceiptsLoading] = useState(false);
  const [receiptSearch, setReceiptSearch] = useState("");
  const [selectedReceipt, setSelectedReceipt] = useState<ReceiptRow | null>(null);
  const receiptsFetchId = useRef(0);

  // Peak
  const [hourStats, setHourStats] = useState<HourStat[]>([]);
  const [dayStats, setDayStats] = useState<DayStat[]>([]);
  const [peakLoading, setPeakLoading] = useState(true);

  // Settlements
  const [settlementRollup, setSettlementRollup] = useState<
    { settlement_route: string; rides_count: number; total_fares: number; net_total: number }[]
  >([]);
  const [settlementRollupLoading, setSettlementRollupLoading] = useState(true);
  // Net | Gross display lens for the whole rollup (hero, donut, daily chart,
  // route table). Net default -- what actually reached driver/company accounts
  // after Vellon + Stripe fees, so the tab never overstates what was paid out.
  // The RPC returns BOTH totals in one call, so flipping this is pure client-side
  // (no refetch, no flicker). Gross = what passengers were charged.
  const [settlementBasis, setSettlementBasis] = useState<"net" | "gross">("net");
  // The company's payout model. The cash strip below only renders for
  // 'driver_direct' -- its "drivers keep" net framing is only true when the
  // driver owns the fare. company_settles cash is a different story (the company
  // owns the fare revenue) and gets its own framing later. Null until fetched.
  const [payoutModel, setPayoutModel] = useState<string | null>(null);
  // Cash lane: a single aggregate row (no settlement routes -- cash never touches
  // Stripe, the driver keeps it at the door). Gross = fares collected, net =
  // fares - the Vellon fee that accrues on cash and is billed to the company
  // monthly. Same period window as the card rollup.
  const [cashSettlement, setCashSettlement] = useState<{
    cash_rides: number;
    cash_fares: number;
    cash_fee_owed: number;
  } | null>(null);
  const [cashSettlementLoading, setCashSettlementLoading] = useState(true);
  // Card fee breakdown (company_settles view). Gross fares decomposed into what
  // the company kept (net) vs what Vellon and Stripe took, over settled rides.
  // Reconciles: gross = net + vellon_fee + stripe_fee. Only fetched/used when the
  // company is company_settles; driver_direct uses the route rollup instead.
  const [feeBreakdown, setFeeBreakdown] = useState<{
    paid_rides: number;
    gross_fares: number;
    vellon_fee: number;
    stripe_fee: number;
    net_total: number;
  } | null>(null);
  const [feeBreakdownLoading, setFeeBreakdownLoading] = useState(true);
  // Donut hover for the fee-composition chart: "net" | "vellon" | "stripe".
  const [feeHot, setFeeHot] = useState<string | null>(null);
  // Per-day settlement flow for the chart: paid-to-drivers vs held, either basis.
  const [settlementDaily, setSettlementDaily] = useState<
    { day: string; bucket: string; gross: number; net: number }[]
  >([]);
  // Donut hover: the route whose slice is emphasised (others dim, center follows).
  const [settleHotRoute, setSettleHotRoute] = useState<string | null>(null);
  // Chart entrance gate: false renders the donut/bars collapsed, then an effect
  // flips it true one frame later so the CSS transition draws them in. Reset only
  // on a full (non-silent) load — a period change re-draws, but a background
  // Realtime refetch or a Net/Gross flip morphs smoothly instead of redrawing.
  const [settleChartsReady, setSettleChartsReady] = useState(false);
  // Per-ride drilldown for the rollup -- period-scoped, covers EVERY
  // settlement_route (not just the actionable ones), so dispatch can see
  // exactly which ride/driver/amount makes up any bucket, including the
  // ones that already settled fine.
  const [settlementRides, setSettlementRides] = useState<SettlementRideRow[]>([]);
  const [settlementRidesLoading, setSettlementRidesLoading] = useState(true);
  const [settlementRouteFilter, setSettlementRouteFilter] = useState<string>("all");
  const [settlementStateFilter, setSettlementStateFilter] = useState<"all" | "open" | "resolved">("all");
  const [needsAttention, setNeedsAttention] = useState<SettlementRideRow[]>([]);
  const [needsAttentionLoading, setNeedsAttentionLoading] = useState(true);
  const [resolvingRideId, setResolvingRideId] = useState<string | null>(null);

  const revenueFetchId = useRef(0);
  const historyFetchId = useRef(0);
  const reviewsFetchId = useRef(0);
  const peakFetchId = useRef(0);
  const settlementFetchId = useRef(0);
  // scheduleRidesRefresh below only re-subscribes on companyId change, so it
  // would otherwise close over a stale `section` from mount -- same fix
  // pattern as fetchActivityLogRef further down.
  const sectionRef = useRef(section);
  useEffect(() => { sectionRef.current = section; }, [section]);

  useEffect(() => {
    fetchRevenue();
  }, [period]);

  useEffect(() => {
    fetchRideHistory();
    fetchReviews();
    fetchPeak();
  }, []);

  useEffect(() => {
    if (section === "activity") fetchActivityLog();
  }, [section, activityDateFrom, activityDateTo]);

  useEffect(() => {
    if (section === "receipts") fetchReceipts();
  }, [section]);

  useEffect(() => {
    if (section === "settlements") {
      fetchSettlementRollup();
      fetchSettlementDaily();
      fetchSettlementRides();
      fetchCashSettlement();
      fetchFeeBreakdown();
    }
  }, [section, period, companyId]);

  // Payout model drives whether the cash strip renders at all. Fetched once per
  // company, independent of the section/period churn above.
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("companies")
        .select("payout_model")
        .eq("id", companyId)
        .maybeSingle();
      if (cancelled) return;
      if (error) console.error("[payout_model]", error.message);
      else setPayoutModel(data?.payout_model ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  useEffect(() => {
    if (section === "settlements") fetchNeedsAttention();
  }, [section, companyId]);

  // Draw the charts in whenever the section opens or the period reloads. Skip
  // the animation entirely under reduced-motion. Deps intentionally exclude
  // settlementBasis (a Net/Gross flip should morph, not redraw) and the silent
  // Realtime refetches (they don't toggle settlementRollupLoading).
  useEffect(() => {
    if (section !== "settlements") {
      setSettleChartsReady(false);
      setSettleHotRoute(null);
      return;
    }
    // Stay collapsed while data loads. Without this, the rAF below fires behind
    // the loading spinner, so the charts would reveal already-full and only then
    // collapse+draw — a visible pop on every open/period change.
    if (settlementRollupLoading) {
      setSettleChartsReady(false);
      return;
    }
    if (
      typeof matchMedia !== "undefined" &&
      // i18n-ok — a CSS media query.
      matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setSettleChartsReady(true);
      return;
    }
    setSettleChartsReady(false);
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => setSettleChartsReady(true)),
    );
    return () => cancelAnimationFrame(id);
  }, [section, period, settlementRollupLoading]);

  // A route filter picked under one period is often meaningless under the
  // next (e.g. "Transfer failed" exists this year but not today), which would
  // otherwise strand the drilldown on an empty list with no chip highlighted
  // and no obvious way back. Drop back to "All" whenever the selected route
  // isn't present in the freshly-loaded rollup.
  useEffect(() => {
    if (settlementRouteFilter === "all" || settlementRollupLoading) return;
    if (!settlementRollup.some((r) => r.settlement_route === settlementRouteFilter)) {
      setSettlementRouteFilter("all");
    }
  }, [settlementRollup, settlementRollupLoading]);

  useEffect(() => {
    if (!companyId) return;

    function scheduleRidesRefresh() {
      if (ridesDebounceRef.current) clearTimeout(ridesDebounceRef.current);
      ridesDebounceRef.current = setTimeout(() => {
        fetchRevenue(true);
        fetchRideHistory(true);
        fetchPeak(true);
        if (sectionRef.current === "settlements") {
          fetchSettlementRollup(true);
          fetchSettlementDaily(true);
          fetchSettlementRides(true);
          fetchCashSettlement(true);
          fetchFeeBreakdown(true);
          fetchNeedsAttention(true);
        }
      }, 1200);
    }

    const ch = supabase
      .channel(`analytics_rt_${companyId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rides", filter: `company_id=eq.${companyId}` },
        scheduleRidesRefresh,
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "ride_receipts", filter: `company_id=eq.${companyId}` },
        () => {
          fetchRideHistory(true); // refreshes the receipt # column in ride history
          if (section === "receipts") fetchReceipts(true);
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "ride_reviews" },
        () => fetchReviews(true),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "ride_reviews" },
        () => { if (section === "reviews") fetchReviews(true); },
      )
      .subscribe();

    return () => { supabase.removeChannel(ch); };
  }, [companyId]);

  // Keep ref current so the realtime callback always calls the latest version
  useEffect(() => { fetchActivityLogRef.current = fetchActivityLog; });

  useEffect(() => {
    if (section !== "activity" || !companyId) return;
    const channel = supabase
      .channel(`dispatch_events_live_${companyId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "dispatch_events",
          filter: `company_id=eq.${companyId}`,
        },
        () => fetchActivityLogRef.current(true),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [section, companyId]);

  // ── Helpers ───────────────────────────────────────────────────────
  async function batchProfiles(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const { data } = await supabase
      .from("profiles")
      .select("id, name")
      .in("id", unique);
    const map = new Map<string, string>();
    data?.forEach((p: any) => map.set(p.id, p.name ?? "—"));
    return map;
  }

  // ── Fetchers ──────────────────────────────────────────────────────
  async function fetchRevenue(silent = false) {
    const fetchId = ++revenueFetchId.current;
    if (!silent) setRevenueLoading(true);
    try {
      const now = new Date();
      let startDate: Date;
      if (period === "today")
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      else if (period === "week")
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      else if (period === "month")
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      else startDate = new Date(now.getFullYear(), 0, 1);

      const todayStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      );
      const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const yearStart = new Date(now.getFullYear(), 0, 1);

      const [
        { data: allRidesData },
        { data: periodRides },
        { data: allReviews },
        { data: drivers },
      ] = await Promise.all([
        supabase
          .from("rides")
          .select("*")
          .gte("created_at", yearStart.toISOString()),
        supabase
          .from("rides")
          .select("*")
          .gte("created_at", startDate.toISOString())
          .order("created_at", { ascending: true }),
        supabase.from("ride_reviews").select("driver_id, rating, comment, created_at"),
        supabase.from("drivers").select("id"),
      ]);

      if (fetchId !== revenueFetchId.current) return;
      if (!allRidesData || !periodRides) return;

      const completed = (arr: any[]) =>
        arr.filter((r) => r.status === "completed");
      const sum = (arr: any[]) =>
        completed(arr).reduce(
          (s: number, r: any) => s + (r.fare_final ?? r.fare_estimate ?? 0),
          0,
        );
      const completedPeriod = completed(periodRides);

      setTotals({
        revenue: sum(periodRides),
        rides: completedPeriod.length,
        avgFare: completedPeriod.length
          ? sum(periodRides) / completedPeriod.length
          : 0,
        cancelRate: periodRides.length
          ? (periodRides.filter((r: any) => r.status === "cancelled").length /
              periodRides.length) *
            100
          : 0,
        cashRevenue: completed(periodRides)
          .filter((r: any) => r.payment_method === "cash")
          .reduce(
            (s: number, r: any) => s + (r.fare_final ?? r.fare_estimate ?? 0),
            0,
          ),
        cardRevenue: completed(periodRides)
          .filter((r: any) => r.payment_method !== "cash")
          .reduce(
            (s: number, r: any) => s + (r.fare_final ?? r.fare_estimate ?? 0),
            0,
          ),
        cashRides: completedPeriod.filter(
          (r: any) => r.payment_method === "cash",
        ).length,
        cardRides: completedPeriod.filter(
          (r: any) => r.payment_method !== "cash",
        ).length,
        revenueToday: sum(
          allRidesData.filter((r: any) => new Date(r.created_at) >= todayStart),
        ),
        revenueWeek: sum(
          allRidesData.filter((r: any) => new Date(r.created_at) >= weekStart),
        ),
        revenueMonth: sum(
          allRidesData.filter((r: any) => new Date(r.created_at) >= monthStart),
        ),
        revenueYear: sum(
          allRidesData.filter((r: any) => new Date(r.created_at) >= yearStart),
        ),
      });

      const dayMap = new Map<string, { revenue: number; rides: number }>();
      completedPeriod.forEach((r: any) => {
        const day = fmtDate(r.created_at, { month: "short", day: "numeric" });
        const ex = dayMap.get(day) ?? { revenue: 0, rides: 0 };
        dayMap.set(day, {
          revenue: ex.revenue + (r.fare_final ?? r.fare_estimate ?? 0),
          rides: ex.rides + 1,
        });
      });
      if (fetchId === revenueFetchId.current)
        setDailyData(
          Array.from(dayMap.entries()).map(([day, v]) => ({ day, ...v })),
        );

      if (period === "today") {
        const hourMap = new Map<number, { revenue: number; rides: number }>();
        completedPeriod.forEach((r: any) => {
          const h = new Date(r.created_at).getHours();
          const ex = hourMap.get(h) ?? { revenue: 0, rides: 0 };
          hourMap.set(h, {
            revenue: ex.revenue + (r.fare_final ?? r.fare_estimate ?? 0),
            rides: ex.rides + 1,
          });
        });
        const currentHour = new Date().getHours();
        if (fetchId === revenueFetchId.current)
          setHourlyData(
            Array.from({ length: currentHour + 1 }, (_, h) => ({
              label: fmtHour(h),
              revenue: hourMap.get(h)?.revenue ?? 0,
              rides: hourMap.get(h)?.rides ?? 0,
            })),
          );
      }

      if (drivers) {
        const driverIds = drivers.map((d: any) => d.id);
        const [profileMap, { data: avatarRows }] = await Promise.all([
          batchProfiles(driverIds),
          supabase.from("profiles").select("id, avatar_url").in("id", driverIds),
        ]);
        const avatarMap = new Map<string, string>();
        avatarRows?.forEach((p: any) => {
          if (p.avatar_url) avatarMap.set(p.id, p.avatar_url);
        });
        if (fetchId !== revenueFetchId.current) return;

        const stats: DriverStat[] = drivers.map((d: any) => {
          const dr = periodRides.filter((r: any) => r.driver_id === d.id);
          const comp = completed(dr);
          const canc = dr.filter((r: any) => r.status === "cancelled");
          const earn = comp.reduce(
            (s: number, r: any) => s + (r.fare_final ?? r.fare_estimate ?? 0),
            0,
          );
          const cashEarn = comp
            .filter((r: any) => r.payment_method === "cash")
            .reduce(
              (s: number, r: any) => s + (r.fare_final ?? r.fare_estimate ?? 0),
              0,
            );
          const cardEarn = comp
            .filter((r: any) => r.payment_method !== "cash")
            .reduce(
              (s: number, r: any) => s + (r.fare_final ?? r.fare_estimate ?? 0),
              0,
            );
          const driverReviews =
            allReviews?.filter((rv: any) => rv.driver_id === d.id) ?? [];
          const avgRating = driverReviews.length
            ? Math.round(
                (driverReviews.reduce(
                  (s: number, rv: any) => s + rv.rating,
                  0,
                ) /
                  driverReviews.length) *
                  10,
              ) / 10
            : null;
          return {
            id: d.id,
            name: profileMap.get(d.id) ?? t("common.unknown"),
            avatarUrl: avatarMap.get(d.id) ?? null,
            rides: comp.length,
            ridesTotal: dr.length,
            earnings: earn,
            cashEarnings: cashEarn,
            cardEarnings: cardEarn,
            cancelRate: dr.length ? (canc.length / dr.length) * 100 : 0,
            cancelled: canc.length,
            avgFare: comp.length ? earn / comp.length : 0,
            avgRating,
            ratingCount: driverReviews.length,
            recentReviews: driverReviews
              .filter((rv: any) => rv.comment && rv.comment.trim())
              .sort(
                (a: any, b: any) =>
                  new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
              )
              .slice(0, 5)
              .map((rv: any) => ({
                rating: rv.rating,
                comment: rv.comment,
                created_at: rv.created_at,
              })),
          };
        });
        if (fetchId === revenueFetchId.current)
          setDriverStats(
            stats
              .filter((d) => d.ridesTotal > 0)
              .sort((a, b) => b.earnings - a.earnings),
          );
      }
    } catch (e) {
      console.error(e);
    } finally {
      if (fetchId === revenueFetchId.current) setRevenueLoading(false);
    }
  }

  async function fetchRideHistory(silent = false) {
    const fetchId = ++historyFetchId.current;
    if (!silent) setRidesLoading(true);
    try {
      const { data: rides } = await supabase
        .from("rides")
        .select("*")
        .in("status", ["completed", "cancelled"])
        .order("created_at", { ascending: false })
        .limit(500);
      if (fetchId !== historyFetchId.current || !rides) return;

      const passengerIds = rides.map((r: any) => r.passenger_id);
      const driverIds = rides.map((r: any) => r.driver_id).filter(Boolean);
      const rideIds = rides.map((r: any) => r.id);
      const [profileMap, receiptResult] = await Promise.all([
        batchProfiles([...passengerIds, ...driverIds]),
        supabase.from("ride_receipts").select("ride_id, receipt_number").in("ride_id", rideIds),
      ]);
      if (fetchId !== historyFetchId.current) return;

      const receiptMap = new Map<string, string>();
      receiptResult.data?.forEach((inv: any) => receiptMap.set(inv.ride_id, inv.receipt_number));

      const enriched: RideRow[] = rides.map((r: any) => ({
        ...r,
        passenger_name: profileMap.get(r.passenger_id) ?? "—",
        driver_name: r.driver_id ? (profileMap.get(r.driver_id) ?? "—") : "—",
        receipt_number: receiptMap.get(r.id) ?? null,
      }));

      if (fetchId === historyFetchId.current) setAllRides(enriched);
    } catch (e) {
      console.error(e);
    } finally {
      if (fetchId === historyFetchId.current) setRidesLoading(false);
    }
  }

  // ── Settlements ──────────────────────────────────────────────────────
  async function fetchSettlementRollup(silent = false) {
    const fetchId = ++settlementFetchId.current;
    if (!silent) setSettlementRollupLoading(true);
    try {
      const now = new Date();
      let startDate: Date;
      if (period === "today")
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      else if (period === "week")
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      else if (period === "month")
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      else startDate = new Date(now.getFullYear(), 0, 1);

      const { data, error } = await supabase.rpc("company_settlement_rollup", {
        p_from: startDate.toISOString(),
        p_to: now.toISOString(),
      });
      if (fetchId !== settlementFetchId.current) return;
      if (error) {
        console.error("[fetchSettlementRollup]", error.message);
        setSettlementRollup([]);
      } else {
        setSettlementRollup(data ?? []);
      }
    } finally {
      if (fetchId === settlementFetchId.current) setSettlementRollupLoading(false);
    }
  }

  // Daily settlement flow for the chart. Shares the rollup's fetch-id guard so a
  // stale in-flight response (period changed mid-request) can't clobber fresh
  // data. Returns both gross and net per (day, bucket) so the Net|Gross toggle
  // switches instantly without a refetch.
  async function fetchSettlementDaily(silent = false) {
    const fetchId = settlementFetchId.current;
    try {
      const now = new Date();
      let startDate: Date;
      if (period === "today")
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      else if (period === "week")
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      else if (period === "month")
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      else startDate = new Date(now.getFullYear(), 0, 1);

      const { data, error } = await supabase.rpc("company_settlement_daily", {
        p_from: startDate.toISOString(),
        p_to: now.toISOString(),
      });
      if (fetchId !== settlementFetchId.current) return;
      if (error) {
        console.error("[fetchSettlementDaily]", error.message);
        setSettlementDaily([]);
      } else {
        setSettlementDaily(data ?? []);
      }
    } catch (e) {
      console.error("[fetchSettlementDaily]", e);
    }
    void silent;
  }

  // Cash lane aggregate. Same period window and fetch-id guard as the rollup so
  // a stale response can't clobber fresh data on a period change. The RPC returns
  // a single aggregate row (no GROUP BY) -- take the first, or zeros if empty.
  async function fetchCashSettlement(silent = false) {
    const fetchId = settlementFetchId.current;
    if (!silent) setCashSettlementLoading(true);
    try {
      const now = new Date();
      let startDate: Date;
      if (period === "today")
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      else if (period === "week")
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      else if (period === "month")
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      else startDate = new Date(now.getFullYear(), 0, 1);

      const { data, error } = await supabase.rpc("company_cash_settlement", {
        p_from: startDate.toISOString(),
        p_to: now.toISOString(),
      });
      if (fetchId !== settlementFetchId.current) return;
      if (error) {
        console.error("[fetchCashSettlement]", error.message);
        setCashSettlement(null);
      } else {
        const row = data?.[0];
        setCashSettlement({
          cash_rides: Number(row?.cash_rides ?? 0),
          cash_fares: Number(row?.cash_fares ?? 0),
          cash_fee_owed: Number(row?.cash_fee_owed ?? 0),
        });
      }
    } finally {
      if (fetchId === settlementFetchId.current) setCashSettlementLoading(false);
    }
  }

  // Card fee breakdown for the company_settles view. Same period window / fetch-id
  // guard as the rollup. Single aggregate row -> take the first, or zeros.
  async function fetchFeeBreakdown(silent = false) {
    const fetchId = settlementFetchId.current;
    if (!silent) setFeeBreakdownLoading(true);
    try {
      const now = new Date();
      let startDate: Date;
      if (period === "today")
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      else if (period === "week")
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      else if (period === "month")
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      else startDate = new Date(now.getFullYear(), 0, 1);

      const { data, error } = await supabase.rpc("company_settlement_fee_breakdown", {
        p_from: startDate.toISOString(),
        p_to: now.toISOString(),
      });
      if (fetchId !== settlementFetchId.current) return;
      if (error) {
        console.error("[fetchFeeBreakdown]", error.message);
        setFeeBreakdown(null);
      } else {
        const row = data?.[0];
        setFeeBreakdown({
          paid_rides: Number(row?.paid_rides ?? 0),
          gross_fares: Number(row?.gross_fares ?? 0),
          vellon_fee: Number(row?.vellon_fee ?? 0),
          stripe_fee: Number(row?.stripe_fee ?? 0),
          net_total: Number(row?.net_total ?? 0),
        });
      }
    } finally {
      if (fetchId === settlementFetchId.current) setFeeBreakdownLoading(false);
    }
  }

  // Deliberately NOT period-scoped -- these are outstanding todos, not
  // historical stats. A platform_invoiced ride from 3 months ago that never
  // got manually paid out shouldn't disappear because "this month" is selected.
  async function fetchNeedsAttention(silent = false) {
    if (!silent) setNeedsAttentionLoading(true);
    try {
      const { data: rides, error } = await supabase
        .from("rides")
        .select("id, ride_ref, completed_at, created_at, fare_final, transfer_amount_cents, driver_id, settlement_route, settlement_resolved_at, stripe_dispute_id")
        .eq("company_id", companyId)
        .eq("payment_method", "card")
        .in("settlement_route", SETTLEMENT_ACTIONABLE_ROUTES as unknown as string[])
        .is("settlement_resolved_at", null)
        .order("completed_at", { ascending: true });

      if (error) console.error("[fetchNeedsAttention]", error.message);

      if (!rides) {
        setNeedsAttention([]);
        return;
      }

      const driverIds = rides.map((r: any) => r.driver_id).filter(Boolean);
      const profileMap = await batchProfiles(driverIds);

      setNeedsAttention(
        rides.map((r: any) => ({
          id: r.id,
          ride_ref: r.ride_ref,
          completed_at: r.completed_at,
          created_at: r.created_at,
          fare_final: r.fare_final,
          transfer_amount_cents: r.transfer_amount_cents,
          driver_name: r.driver_id ? (profileMap.get(r.driver_id) ?? "—") : "—",
          settlement_route: r.settlement_route,
          settlement_resolved_at: r.settlement_resolved_at,
          stripe_dispute_id: r.stripe_dispute_id,
        })),
      );
    } finally {
      setNeedsAttentionLoading(false);
    }
  }

  // Period-scoped drilldown -- EVERY completed card ride in the period (any
  // route, not just the actionable ones, and resolved ones included), so every
  // rollup bucket can be traced back to specific rides/drivers/amounts. Kept
  // deliberately in lockstep with company_settlement_rollup's WHERE clause;
  // if the two diverge, a rollup row stops reconciling with its own drilldown.
  async function fetchSettlementRides(silent = false) {
    if (!silent) setSettlementRidesLoading(true);
    try {
      const now = new Date();
      let startDate: Date;
      if (period === "today")
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      else if (period === "week")
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      else if (period === "month")
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      else startDate = new Date(now.getFullYear(), 0, 1);

      const { data: rides, error } = await supabase
        .from("rides")
        .select("id, ride_ref, completed_at, created_at, fare_final, transfer_amount_cents, driver_id, settlement_route, settlement_resolved_at, stripe_dispute_id")
        .eq("company_id", companyId)
        .eq("payment_method", "card")
        .eq("status", "completed")
        .gte("completed_at", startDate.toISOString())
        .lt("completed_at", now.toISOString())
        .order("completed_at", { ascending: false });

      if (error) console.error("[fetchSettlementRides]", error.message);

      if (!rides) {
        setSettlementRides([]);
        return;
      }

      const driverIds = rides.map((r: any) => r.driver_id).filter(Boolean);
      const profileMap = await batchProfiles(driverIds);

      setSettlementRides(
        rides.map((r: any) => ({
          id: r.id,
          ride_ref: r.ride_ref,
          completed_at: r.completed_at,
          created_at: r.created_at,
          fare_final: r.fare_final,
          transfer_amount_cents: r.transfer_amount_cents,
          driver_name: r.driver_id ? (profileMap.get(r.driver_id) ?? "—") : "—",
          // Mirror the RPC's coalesce -- it buckets a null route as
          // 'unsettled', so the drilldown has to as well or the "Unsettled"
          // chip would show a count the ride list can never produce.
          settlement_route: r.settlement_route ?? "unsettled",
          settlement_resolved_at: r.settlement_resolved_at,
          stripe_dispute_id: r.stripe_dispute_id,
        })),
      );
    } finally {
      setSettlementRidesLoading(false);
    }
  }

  async function resolveSettlement(row: SettlementRideRow) {
    setResolvingRideId(row.id);
    try {
      // .select() is required here, not cosmetic -- a Supabase update that
      // matches zero rows under RLS returns success with an empty result,
      // not an error. Without this we'd log a "resolved" audit event and
      // optimistically clear the row for a write that never actually
      // happened, and it would silently reappear on the next fetch.
      const { data, error } = await supabase
        .from("rides")
        .update({
          settlement_resolved_at: new Date().toISOString(),
          settlement_resolved_by: dispatcherId,
        })
        .eq("id", row.id)
        .select("id");

      if (error) {
        console.error("[resolveSettlement]", error.message);
        return;
      }
      if (!data || data.length === 0) {
        console.error("[resolveSettlement] update matched no rows (RLS or already resolved) for ride", row.id);
        return;
      }

      await logDispatchEvent({
        companyId,
        dispatcherId,
        eventType: "settlement.resolved",
        rideId: row.id,
        details: {
          settlement_route: row.settlement_route,
          fare_final: row.fare_final,
        },
      });

      const resolvedAt = new Date().toISOString();
      setNeedsAttention((prev) => prev.filter((r) => r.id !== row.id));
      setSettlementRides((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, settlement_resolved_at: resolvedAt } : r)),
      );
    } finally {
      setResolvingRideId(null);
    }
  }

  // ── Settlement derived views ─────────────────────────────────────────
  // Period rollup aggregates. Gross fares by route, resolved rides included --
  // this block is "where the card money went this period", nothing here is a
  // measure of what's still outstanding.
  // The Net|Gross toggle picks which per-row amount every rollup figure reads.
  // Net = transfer_amount_cents (after fees), gross = fare_final. One accessor,
  // applied everywhere below, is what guarantees the hero, donut, daily chart
  // and route table can never disagree about the basis.
  const settlementAmt = useCallback(
    (r: { total_fares: number; net_total: number }) =>
      settlementBasis === "net" ? Number(r.net_total) : Number(r.total_fares),
    [settlementBasis],
  );

  const settlementTotals = useMemo(() => {
    const sumOf = (routes: string[]) =>
      settlementRollup
        .filter((r) => routes.includes(r.settlement_route))
        .reduce((a, r) => a + settlementAmt(r), 0);
    const countOf = (routes: string[]) =>
      settlementRollup
        .filter((r) => routes.includes(r.settlement_route))
        .reduce((a, r) => a + r.rides_count, 0);

    const grand = settlementRollup.reduce((a, r) => a + settlementAmt(r), 0);
    const rides = settlementRollup.reduce((a, r) => a + r.rides_count, 0);
    return {
      grand,
      rides,
      settled: sumOf(ROLLUP_SETTLED_ROUTES),
      settledRides: countOf(ROLLUP_SETTLED_ROUTES),
      held: sumOf(["platform_invoiced"]),
      heldRides: countOf(["platform_invoiced"]),
      problem: sumOf(ROLLUP_PROBLEM_ROUTES),
      problemRides: countOf(ROLLUP_PROBLEM_ROUTES),
    };
  }, [settlementRollup, settlementAmt]);

  // Rollup sorted biggest-bucket-first (in the active basis) so the composition
  // donut and the table below it read in the same order.
  const settlementRollupSorted = useMemo(
    () => [...settlementRollup].sort((a, b) => settlementAmt(b) - settlementAmt(a)),
    [settlementRollup, settlementAmt],
  );

  // Payout-model-driven framing for the settlement hero + cash strip. The
  // underlying numbers are identical across models -- only the words and the
  // lead accent change. driver_direct: money/fares belong to the DRIVER (green);
  // company_settles: money/fares belong to the COMPANY's own account (blue).
  // payoutModel is null until fetched; treat unknown as driver_direct framing
  // (the card rollup renders before the fetch resolves, so this is just the
  // brief-flash default, not a real classification).
  const isCompanySettles = payoutModel === "company_settles";
  const leadAccent = isCompanySettles
    ? { main: "#4a9eff", bright: "#6cb2ff", cls: " paid-company" }
    : { main: "#1D9E75", bright: "#2fce9a", cls: "" };
  const leadPaidLabel = isCompanySettles
    ? settlementBasis === "net" ? t("settle.paidToYourAccount") : t("settle.routedToYourAccount")
    : settlementBasis === "net" ? t("settle.paidToDrivers") : t("settle.routedToDrivers");
  const leadPaidSub = isCompanySettles ? t("settle.toYourStripe") : t("settle.toDriversCompany");
  // Cash strip labels (the driver-owns vs company-owns distinction).
  const cashLeadNetLabel = isCompanySettles ? t("settle.yourCashNet") : t("settle.driversKeep");
  const cashLeadGrossLabel = isCompanySettles ? t("settle.cashCollectedByDrivers") : t("settle.cashFaresCollected");
  const cashGrossShort = isCompanySettles ? t("settle.cashCollected") : t("settle.cashFares");
  const cashGrossTail = isCompanySettles ? t("settle.collectedByDrivers") : t("settle.collectedAtDoor");
  const cashScopeNote = isCompanySettles
    ? t("settle.cashScopeCompany")
    : t("settle.cashScopeDriver");

  // Flow chart series: paid-to-drivers vs held, in the active basis. The RPC
  // returns sparse per-(day, bucket) rows; we pivot to a dense, ordered series.
  // A year of daily bars would be 365 unreadable slivers, so "year" rolls up to
  // months; everything shorter stays daily. Labels are derived from the key
  // parsed as parts (never `new Date("YYYY-MM-DD")`, which is UTC-parsed and
  // shifts a day back in Halifax time).
  const settlementDailyChart = useMemo(() => {
    const val = (r: { gross: number; net: number }) =>
      settlementBasis === "net" ? Number(r.net) : Number(r.gross);
    const byMonth = period === "year";
    const keyOf = (day: string) => (byMonth ? day.slice(0, 7) : day);
    const map = new Map<string, { paid: number; held: number }>();
    for (const r of settlementDaily) {
      const k = keyOf(r.day);
      const slot = map.get(k) ?? { paid: 0, held: 0 };
      if (r.bucket === "paid") slot.paid += val(r);
      else if (r.bucket === "held") slot.held += val(r);
      // 'problem' is intentionally left off the flow chart -- it lives in the
      // hero's "Failed or reversed" tile and the Needs-attention list instead.
      map.set(k, slot);
    }
    const label = (k: string) => {
      if (byMonth) return monthShort(Number(k.slice(5, 7))) || k;
      const [y, m, d] = k.split("-").map(Number);
      if (period === "week")
        return weekdayShort(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
      return String(d); // today / month → day-of-month
    };
    const buckets = [...map.entries()]
      .map(([k, v]) => ({ key: k, label: label(k), ...v }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const max = buckets.reduce((m, b) => Math.max(m, b.paid + b.held), 0);
    // Net-only axis for the company_settles daily chart (renders b.paid alone).
    const maxNet = buckets.reduce((m, b) => Math.max(m, b.paid), 0);
    return { buckets, max, niceMax: niceCeil(max), niceMaxNet: niceCeil(maxNet) };
  }, [settlementDaily, settlementBasis, period]);

  // Donut composition: each route's slice of the period total, in the active
  // basis, biggest first. Precomputed stroke geometry (a shared circumference,
  // per-segment arc length + offset) keeps the SVG in the JSX declarative.
  const settlementDonut = useMemo(() => {
    const C = 2 * Math.PI * 46;
    const grand = settlementTotals.grand || 1;
    let acc = 0;
    const segs = settlementRollupSorted
      .filter((r) => settlementAmt(r) > 0)
      .map((r) => {
        const amt = settlementAmt(r);
        const len = (amt / grand) * C;
        const seg = {
          route: r.settlement_route,
          color: settlementColor(r.settlement_route),
          amt,
          pct: (amt / grand) * 100,
          len,
          offset: -acc,
        };
        acc += len;
        return seg;
      });
    return { C, segs, top: segs[0] ?? null };
  }, [settlementRollupSorted, settlementTotals.grand, settlementAmt]);

  // Fee-composition donut for the company_settles view: each dollar of gross
  // fares split into Net to you / Vellon fee / Stripe fee. Slices sum to gross by
  // construction (vellon = gross - stripe - net), so the ring is always full.
  const feeDonut = useMemo(() => {
    const C = 2 * Math.PI * 46;
    const gross = feeBreakdown?.gross_fares || 1;
    const parts = feeBreakdown
      ? [
          { key: "net", name: "Net to you", color: "#4a9eff", amt: feeBreakdown.net_total },
          { key: "vellon", name: "Vellon fee", color: "#E8500A", amt: feeBreakdown.vellon_fee },
          { key: "stripe", name: "Stripe fee", color: "#8B93A7", amt: feeBreakdown.stripe_fee },
        ]
      : [];
    let acc = 0;
    const segs = parts
      .filter((p) => p.amt > 0)
      .map((p) => {
        const len = (p.amt / gross) * C;
        const seg = { ...p, pct: (p.amt / gross) * 100, len, offset: -acc };
        acc += len;
        return seg;
      });
    return { C, segs, top: segs[0] ?? null };
  }, [feeBreakdown]);

  // Outstanding work, split by direction of money. All-time and unresolved --
  // deliberately a different scope from the rollup above it.
  const attentionSplit = useMemo(() => {
    const acc = {
      collect: { count: 0, amount: 0 },
      payout: { count: 0, amount: 0 },
    };
    for (const r of needsAttention) {
      const dir = SETTLEMENT_DIRECTION[r.settlement_route];
      if (!dir) continue;
      acc[dir].count += 1;
      acc[dir].amount += settlementOwedAmount(r);
    }
    return acc;
  }, [needsAttention]);

  const filteredSettlementRides = useMemo(() => {
    return settlementRides.filter((r) => {
      if (settlementRouteFilter !== "all" && r.settlement_route !== settlementRouteFilter)
        return false;
      if (settlementStateFilter === "all") return true;
      const actionable = (SETTLEMENT_ACTIONABLE_ROUTES as readonly string[]).includes(
        r.settlement_route,
      );
      if (settlementStateFilter === "resolved") return !!r.settlement_resolved_at;
      // "open" = needs a human and hasn't been dealt with yet
      return actionable && !r.settlement_resolved_at;
    });
  }, [settlementRides, settlementRouteFilter, settlementStateFilter]);

  function exportSettlementsCSV() {
    logDispatchEvent({
      companyId,
      dispatcherId,
      eventType: "export.csv",
      details: {
        section: "settlements",
        period,
        route: settlementRouteFilter,
        row_count: filteredSettlementRides.length,
      },
    });
    downloadCSV(
      // i18n-ok — a filename.
      `settlements-${period}-${settlementRouteFilter}.csv`,
      [t("csv.date"), t("csv.rideRef"), t("csv.rideId"), t("csv.driver"), t("csv.fare"),
       t("csv.settlementRoute"), t("csv.dispute"), t("csv.resolvedAt")],
      filteredSettlementRides.map((r) => [
        fmtDate(r.completed_at ?? r.created_at),
        r.ride_ref,
        r.id,
        r.driver_name,
        r.fare_final != null ? r.fare_final.toFixed(2) : "",
        settlementShort(r.settlement_route),
        r.stripe_dispute_id ?? "",
        r.settlement_resolved_at ? fmtDate(r.settlement_resolved_at) : "",
      ]),
    );
  }

  async function fetchReviews(silent = false) {
    const fetchId = ++reviewsFetchId.current;
    if (!silent) setReviewsLoading(true);
    try {
      const { data: rows } = await supabase
        .from("ride_reviews")
        .select(
          "id, ride_id, rating, comment, created_at, driver_id, passenger_id, reviewed_by_dispatch",
        )
        .order("created_at", { ascending: false })
        .limit(500);
      if (fetchId !== reviewsFetchId.current || !rows) return;

      const driverIds = rows.map((rv: any) => rv.driver_id);
      const passengerIds = rows.map((rv: any) => rv.passenger_id);
      const profileMap = await batchProfiles([...driverIds, ...passengerIds]);

      const rideIds = [
        ...new Set(rows.map((rv: any) => rv.ride_id).filter(Boolean)),
      ];
      const { data: ridesData } = rideIds.length
        ? await supabase
            .from("rides")
            .select("id, pickup_address, dropoff_address")
            .in("id", rideIds)
        : { data: [] };
      const rideMap = new Map<
        string,
        { pickup_address: string; dropoff_address: string }
      >();
      ridesData?.forEach((r: any) =>
        rideMap.set(r.id, {
          pickup_address: r.pickup_address,
          dropoff_address: r.dropoff_address,
        }),
      );

      if (fetchId !== reviewsFetchId.current) return;

      const enriched: ReviewRow[] = rows.map((rv: any) => ({
        id: rv.id,
        rating: rv.rating,
        comment: rv.comment,
        created_at: rv.created_at,
        driver_id: rv.driver_id,
        driver_name: profileMap.get(rv.driver_id) ?? null,
        passenger_name: profileMap.get(rv.passenger_id) ?? null,
        pickup_address: rideMap.get(rv.ride_id)?.pickup_address ?? "—",
        dropoff_address: rideMap.get(rv.ride_id)?.dropoff_address ?? "—",
        reviewed_by_dispatch: rv.reviewed_by_dispatch ?? false,
      }));

      if (fetchId === reviewsFetchId.current) setReviews(enriched);
    } catch (e) {
      console.error(e);
    } finally {
      if (fetchId === reviewsFetchId.current) setReviewsLoading(false);
    }
  }

  async function fetchPeak(silent = false) {
    const fetchId = ++peakFetchId.current;
    if (!silent) setPeakLoading(true);
    try {
      const { data: rides } = await supabase
        .from("rides")
        .select("created_at")
        .gte(
          "created_at",
          new Date(new Date().getFullYear(), 0, 1).toISOString(),
        );
      if (fetchId !== peakFetchId.current || !rides) return;
      const hourMap = new Map<number, number>();
      // Bucketed by day INDEX, not by name: the name was doing double duty as
      // the Map key and the rendered axis label, so localising it would have
      // re-keyed the buckets as a side effect.
      const dayMap = new Map<number, number>();
      rides.forEach((r: any) => {
        const d = new Date(r.created_at);
        hourMap.set(d.getHours(), (hourMap.get(d.getHours()) ?? 0) + 1);
        dayMap.set(d.getDay(), (dayMap.get(d.getDay()) ?? 0) + 1);
      });
      if (fetchId === peakFetchId.current) {
        setHourStats(
          Array.from({ length: 24 }, (_, i) => ({
            hour: i,
            label: fmtHour(i),
            rides: hourMap.get(i) ?? 0,
          })),
        );
        setDayStats(
          Array.from({ length: 7 }, (_, i) => ({
            day: weekdayShort(i),
            rides: dayMap.get(i) ?? 0,
          })),
        );
      }
    } catch (e) {
      console.error(e);
    } finally {
      if (fetchId === peakFetchId.current) setPeakLoading(false);
    }
  }

  async function fetchActivityLog(silent = false) {
    const fetchId = ++activityFetchId.current;
    if (!silent) setActivityLoading(true);
    try {
      const { data, error } = await supabase
        .from("dispatch_events")
        .select("id, created_at, event_type, ride_id, details, dispatcher_id")
        .gte("created_at", activityDateFrom + "T00:00:00")
        .lte("created_at", activityDateTo + "T23:59:59")
        .order("created_at", { ascending: false })
        .limit(500);
      if (fetchId !== activityFetchId.current) return;
      if (error) {
        console.error("[fetchActivityLog]", error.code, error.message);
        setActivityError(t("analytics.fetchError", { message: error.message, code: error.code }));
        return;
      }
      setActivityError(null);
      const dispatcherIds = [...new Set((data ?? []).map((r: any) => r.dispatcher_id).filter(Boolean))];
      const profileMap = dispatcherIds.length ? await batchProfiles(dispatcherIds) : new Map<string, string>();
      const rows: EventRow[] = (data ?? []).map((r: any) => ({
        id: r.id,
        created_at: r.created_at,
        event_type: r.event_type,
        ride_id: r.ride_id ?? null,
        details: r.details ?? {},
        dispatcher_name: profileMap.get(r.dispatcher_id) ?? null,
      }));
      setActivityEvents(rows);
    } catch (e) {
      console.error(e);
    } finally {
      if (fetchId === activityFetchId.current) setActivityLoading(false);
    }
  }

  async function fetchReceipts(silent = false) {
    const fetchId = ++receiptsFetchId.current;
    if (!silent) setReceiptsLoading(true);
    try {
      const { data } = await supabase
        .from("ride_receipts")
        .select("*")
        .order("sent_at", { ascending: false })
        .limit(500);
      if (fetchId !== receiptsFetchId.current || !data) return;
      setReceipts(data as ReceiptRow[]);
    } catch (e) {
      console.error(e);
    } finally {
      if (fetchId === receiptsFetchId.current) setReceiptsLoading(false);
    }
  }

  function printReceipt(
    inv: ReceiptRow,
    opts?: { extraHtml?: string; footerHtml?: string },
  ) {
    logDispatchEvent({
      companyId,
      dispatcherId,
      eventType: "invoice.printed",
      details: {
        receipt_number: inv.receipt_number,
        passenger_name: inv.passenger_name,
        fare: inv.fare,
      },
    });
    const tax = receiptTax(inv);
    // The company's own wording, as written. The fallback covers a receipt sent
    // between 20260930000000 and 20261001020000, which has a rate but no label.
    const taxLabel = tax.label || t("receipt.hst");
    const hasDiscount = !!(inv.discount_amount && inv.pre_discount_fare != null);
    const date = fmtDateTime(inv.sent_at, {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
    const html = `
      <div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
        <div style="text-align: center; padding: 24px 0;">
          <h1 style="font-size: 20px; margin: 0; color: #1a1a1a;">${esc(inv.company_name) || esc(t("receipt.fallbackCompany"))}</h1>
          <p style="color: #6B7280; font-size: 13px; margin-top: 4px;">${esc(t("receipt.title"))} · ${esc(inv.receipt_number)}</p>
        </div>
        <div style="background: #f7f7f7; border-radius: 12px; padding: 20px; margin-bottom: 16px;">
          ${hasDiscount ? `
          <p style="margin: 0 0 4px; font-size: 13px; color: #6B7280;">${esc(t("receipt.originalFare"))}</p>
          <p style="margin: 0 0 8px; font-size: 15px; color: #9CA3AF; text-decoration: line-through;">$${inv.pre_discount_fare!.toFixed(2)}</p>
          <p style="margin: 0 0 4px; font-size: 13px; color: #6B7280;">${esc(t("receipt.discount"))}${inv.discount_label ? ` — ${esc(inv.discount_label)}` : ""}</p>
          <p style="margin: 0 0 12px; font-size: 15px; color: #1D9E75;">-$${inv.discount_amount!.toFixed(2)}</p>
          ` : ""}
          <p style="margin: 0 0 4px; font-size: 13px; color: #6B7280;">${esc(t("receipt.totalFare"))}</p>
          <p style="margin: 0; font-size: 32px; font-weight: 700; color: #1a1a1a;">$${inv.fare.toFixed(2)}</p>
          <p style="margin: 4px 0 0; font-size: 13px; color: #6B7280;">${esc(
            t("receipt.paidBy", {
              method: inv.payment_method
                ? t(inv.payment_method === "cash" ? "rideDetail.cash" : "rideDetail.card")
                : "—",
            }),
          )}</p>
        </div>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
          <tr><td style="padding: 8px 0; color: #6B7280; font-size: 13px; width: 110px;">${esc(t("receipt.date"))}</td><td style="padding: 8px 0; font-size: 13px;">${esc(date)}</td></tr>
          <tr><td style="padding: 8px 0; color: #6B7280; font-size: 13px; vertical-align: top;">${esc(t("reports.pickup"))}</td><td style="padding: 8px 0; font-size: 13px;">${esc(inv.pickup_address) || "—"}</td></tr>
          <tr><td style="padding: 8px 0; color: #6B7280; font-size: 13px; vertical-align: top;">${esc(t("reports.dropoff"))}</td><td style="padding: 8px 0; font-size: 13px;">${esc(inv.dropoff_address) || "—"}</td></tr>
          <tr><td style="padding: 8px 0; color: #6B7280; font-size: 13px;">${esc(t("rideDetail.passenger"))}</td><td style="padding: 8px 0; font-size: 13px;">${esc(inv.passenger_name) || "—"}</td></tr>
          <tr><td style="padding: 8px 0; color: #6B7280; font-size: 13px;">${esc(t("rideDetail.driver"))}</td><td style="padding: 8px 0; font-size: 13px;">${esc(inv.driver_name) || "—"}</td></tr>
          ${tax.taxed && inv.hst_number ? `<tr><td style="padding: 8px 0; color: #6B7280; font-size: 13px;">${esc(t("receipt.taxRegLabel", { taxLabel }))}</td><td style="padding: 8px 0; font-size: 13px;">${esc(inv.hst_number)}</td></tr>` : ""}
          ${tax.taxed ? `<tr><td style="padding: 8px 0; color: #6B7280; font-size: 13px;">${esc(t("receipt.subtotalBefore", { taxLabel }))}</td><td style="padding: 8px 0; font-size: 13px;">$${tax.subtotal!.toFixed(2)}</td></tr>` : ""}
          ${tax.taxed ? `<tr><td style="padding: 8px 0; color: #6B7280; font-size: 13px;">${esc(t("receipt.taxLine", { taxLabel, rate: tax.rateText }))}</td><td style="padding: 8px 0; font-size: 13px;">$${tax.amount!.toFixed(2)}</td></tr>` : ""}
        </table>
        ${opts?.extraHtml ?? ""}
        <p style="font-size: 12px; color: #9CA3AF; text-align: center; margin-top: 24px; border-top: 1px solid #f3f4f6; padding-top: 16px;">
          ${inv.passenger_name
            ? esc(t("receipt.thanksNamed", { name: inv.passenger_name }))
            : esc(t("receipt.thanks"))}<br/>
          ${esc(inv.company_name) || esc(t("receipt.fallbackCompany"))}
        </p>
        ${opts?.footerHtml ?? ""}
      </div>
    `;
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head>
      <title>${inv.receipt_number}</title>
      <style>* { box-sizing: border-box; } body { margin: 0; padding: 40px; background: #fff; } @page { margin: 0; } @media print { body { padding: 60px 56px; } }</style>
    </head><body>${html}</body></html>`);
    win.document.close();
    setTimeout(() => win.print(), 300);
  }

  async function openRideDetail(ride: RideRow) {
    // Fetch review for this ride if any
    const { data: rv } = await supabase
      .from("ride_reviews")
      .select(
        "id, rating, comment, created_at, driver_id, passenger_id, reviewed_by_dispatch",
      )
      .eq("ride_id", ride.id)
      .maybeSingle();
    let review: ReviewRow | null = null;
    if (rv) {
      const [{ data: driver }, { data: passenger }] = await Promise.all([
        supabase
          .from("profiles")
          .select("name")
          .eq("id", rv.driver_id)
          .maybeSingle(),
        supabase
          .from("profiles")
          .select("name")
          .eq("id", rv.passenger_id)
          .maybeSingle(),
      ]);
      review = {
        ...rv,
        driver_name: driver?.name ?? null,
        passenger_name: passenger?.name ?? null,
        pickup_address: ride.pickup_address,
        dropoff_address: ride.dropoff_address,
        reviewed_by_dispatch: rv.reviewed_by_dispatch ?? false,
      };
    }
    setRideDetail({ ride, review });
  }

  // Print the receipt for a ride opened from Ride History. Builds on the same
  // receipt document as the Receipts tab (receipt #, HST reg, discount breakdown)
  // but augments it with the review when one exists and an "Authorized by" footer
  // — matching the provenance line on the revenue/PDF exports. Only offered when
  // the ride actually has a receipt (receipt_number set).
  async function printRideReceipt(ride: RideRow, review: ReviewRow | null) {
    setPrintingRide(true);
    try {
      const { data, error } = await supabase
        .from("ride_receipts")
        .select("*")
        .eq("ride_id", ride.id)
        .maybeSingle();
      if (error || !data) {
        console.error("[printRideReceipt]", error?.message);
        return;
      }

      // Review section (stars + comment) with a low-rating flag for 1–2 stars.
      const extraHtml = review
        ? `
        <div style="margin-bottom: 16px;">
          <p style="font-size: 13px; font-weight: 600; color: #1a1a1a; margin: 0 0 8px;">
            ${esc(t("receipt.review"))}${review.rating <= 2 ? ` <span style="font-weight: 600; color: #B45309; background: #FEF3C7; border-radius: 4px; padding: 1px 6px; font-size: 11px;">⚠ ${esc(t("receipt.lowRating"))}</span>` : ""}
          </p>
          <div style="background: #f7f7f7; border-radius: 10px; padding: 14px;">
            <p style="margin: 0 0 ${review.comment ? "6px" : "0"}; font-size: 16px; color: #F59E0B; letter-spacing: 2px;">
              ${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)}
              <span style="font-size: 12px; color: #6B7280; letter-spacing: 0;"> ${review.rating}/5</span>
            </p>
            ${review.comment ? `<p style="margin: 0; font-size: 13px; color: #374151; font-style: italic;">"${esc(review.comment)}"</p>` : ""}
          </div>
        </div>`
        : "";

      // Settlement breakdown — internal to dispatch, not part of the
      // passenger-facing receipt document (same printReceipt() is used by
      // the Receipts tab for the customer copy, which never passes this).
      const settlementHtml =
        ride.payment_method === "card" && ride.settlement_route
          ? `
        <div style="margin-bottom: 16px; background: #FFF7ED; border: 1px dashed #FDBA74; border-radius: 10px; padding: 14px;">
          <p style="font-size: 11px; font-weight: 600; color: #9A3412; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.04em;">${esc(t("receipt.internalSettlement"))}</p>
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 3px 0; color: #78350F; font-size: 12px;">${esc(t("rideDetail.vellonFee"))}</td><td style="padding: 3px 0; font-size: 12px; text-align: right;">${
              ride.fare_final != null && ride.platform_fee_percent_at_completion != null
                ? `$${(ride.fare_final * (ride.platform_fee_percent_at_completion / 100)).toFixed(2)} (${ride.platform_fee_percent_at_completion}%)`
                : "—"
            }</td></tr>
            <tr><td style="padding: 3px 0; color: #78350F; font-size: 12px;">${esc(t("rideDetail.cardFee"))}</td><td style="padding: 3px 0; font-size: 12px; text-align: right;">${
              ride.stripe_fee != null ? `$${ride.stripe_fee.toFixed(2)}` : esc(t("rideDetail.pending"))
            }</td></tr>
            <tr><td style="padding: 3px 0; color: #78350F; font-size: 12px; font-weight: 700;">${esc(t("rideDetail.netSettled"))}</td><td style="padding: 3px 0; font-size: 12px; text-align: right; font-weight: 700;">${
              ride.fare_final != null &&
              ride.platform_fee_percent_at_completion != null &&
              ride.stripe_fee != null
                ? `$${(
                    ride.fare_final -
                    ride.fare_final * (ride.platform_fee_percent_at_completion / 100) -
                    ride.stripe_fee
                  ).toFixed(2)}`
                : "—"
            }</td></tr>
          </table>
          <p style="font-size: 11px; color: #9A3412; margin: 8px 0 0;">${esc(
            settlementRouteLabel(ride.settlement_route),
          )}</p>
        </div>`
          : "";

      const footerHtml = `
        <p style="font-size: 11px; color: #9CA3AF; text-align: center; margin-top: 16px; border-top: 1px solid #f3f4f6; padding-top: 12px;">
          ${esc(t("analytics.printFooter", { company: label, when: fmtDateTime(new Date()) }))}
        </p>`;

      printReceipt(data as ReceiptRow, { extraHtml: extraHtml + settlementHtml, footerHtml });
    } finally {
      setPrintingRide(false);
    }
  }

  async function markReviewReviewed(reviewId: string) {
    setMarkingReviewed(reviewId);
    const { error } = await supabase
      .from("ride_reviews")
      .update({ reviewed_by_dispatch: true })
      .eq("id", reviewId);
    if (!error) {
      setReviews((prev) =>
        prev.map((rv) =>
          rv.id === reviewId ? { ...rv, reviewed_by_dispatch: true } : rv,
        ),
      );
      if (rideDetail?.review?.id === reviewId) {
        setRideDetail((prev) =>
          prev
            ? {
                ...prev,
                review: prev.review
                  ? { ...prev.review, reviewed_by_dispatch: true }
                  : null,
              }
            : null,
        );
      }
    }
    setMarkingReviewed(null);
  }

  // ── PDF generators ────────────────────────────────────────────────
  function buildRevenueSVG(): string {
    const isToday = period === "today";
    const data: { label?: string; day?: string; revenue: number }[] = isToday ? hourlyData : dailyData;
    if (data.length === 0) return "";

    const W = 560, H = 180;
    const PL = 52, PR = 12, PT = 12, PB = 28;
    const cW = W - PL - PR;
    const cH = H - PT - PB;
    const maxRev = Math.max(...data.map((d) => d.revenue), 1);

    // nice Y-axis ticks
    const rawStep = maxRev / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
    const niceStep = Math.ceil(rawStep / mag) * mag || 1;
    const yTicks = Array.from({ length: 5 }, (_, i) => i * niceStep).filter((v) => v <= maxRev * 1.15);
    const yMax = yTicks[yTicks.length - 1] || maxRev;
    const yPos = (v: number) => PT + cH - (v / yMax) * cH;

    let inner = "";

    // grid lines + Y labels
    yTicks.forEach((v) => {
      const y = yPos(v).toFixed(1);
      inner += `<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" stroke="#e5e7eb" stroke-width="0.5"/>`;
      inner += `<text x="${PL - 5}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="9" fill="#6b7280">$${v.toFixed(v < 1 ? 2 : 0)}</text>`;
    });

    if (isToday) {
      const n = data.length;
      const slotW = cW / Math.max(n, 1);
      const barW = Math.min(slotW * 0.65, 20);
      data.forEach((d, i) => {
        const x = PL + i * slotW + (slotW - barW) / 2;
        const barH = Math.max((d.revenue / yMax) * cH, 0);
        inner += `<rect x="${x.toFixed(1)}" y="${(yPos(d.revenue)).toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="#E8500A" rx="2"/>`;
      });
      const interval = Math.max(1, Math.floor(n / 8));
      data.forEach((d, i) => {
        if (i % interval !== 0 && i !== n - 1) return;
        const x = PL + i * slotW + slotW / 2;
        inner += `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="#6b7280">${d.label ?? ""}</text>`;
      });
    } else {
      if (data.length === 1) {
        inner += `<circle cx="${(PL + cW / 2).toFixed(1)}" cy="${yPos(data[0].revenue).toFixed(1)}" r="4" fill="#E8500A"/>`;
      } else {
        const pts = data.map((d, i) => ({
          x: PL + (i / (data.length - 1)) * cW,
          y: yPos(d.revenue),
        }));
        const linePts = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
        const areaPts = [
          `${pts[0].x.toFixed(1)},${(PT + cH).toFixed(1)}`,
          ...pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`),
          `${pts[pts.length - 1].x.toFixed(1)},${(PT + cH).toFixed(1)}`,
        ].join(" ");
        inner += `<polyline fill="rgba(232,80,10,0.12)" stroke="none" points="${areaPts}"/>`;
        inner += `<polyline fill="none" stroke="#E8500A" stroke-width="1.75" stroke-linejoin="round" points="${linePts}"/>`;
        pts.forEach((p) => {
          inner += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#E8500A"/>`;
        });
        const interval = Math.max(1, Math.floor(data.length / 7));
        data.forEach((d, i) => {
          if (i % interval !== 0 && i !== data.length - 1) return;
          const x = PL + (i / (data.length - 1)) * cW;
          inner += `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="#6b7280">${d.day ?? ""}</text>`;
        });
      }
    }

    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
  }

  function downloadRevenueReport() {
    logDispatchEvent({ companyId, dispatcherId, eventType: "export.pdf", details: { section: "revenue", period } });
    const rows = driverStats
      .map(
        (d) =>
          `<tr><td>${esc(d.name)}</td><td>${d.rides}</td><td>$${d.earnings.toFixed(2)}</td><td>$${d.cashEarnings.toFixed(2)}</td><td>$${d.cardEarnings.toFixed(2)}</td><td>$${d.avgFare.toFixed(2)}</td><td>${d.cancelRate.toFixed(1)}%</td><td>${d.avgRating?.toFixed(1) ?? "—"}</td></tr>`,
      )
      .join("");
    const periodLabel = t(`analytics.period.${period}`);
    const chartSVG = buildRevenueSVG();
    printReport(
      t("analytics.revenueReportTitle", { company: label }),
      `
      <h1>${esc(t("analytics.revenueReportHeading", { company: label }))}</h1>
      <p class="sub">${esc(periodLabel)} · ${esc(t("analytics.generatedOn", { when: fmtDate(new Date(), { dateStyle: "long" }) }))}</p>
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-label">${esc(t("stats.today"))}</div><div class="kpi-value">$${totals.revenueToday.toFixed(2)}</div></div>
        <div class="kpi"><div class="kpi-label">${esc(t("analytics.thisWeek"))}</div><div class="kpi-value">$${totals.revenueWeek.toFixed(2)}</div></div>
        <div class="kpi"><div class="kpi-label">${esc(t("analytics.thisMonth"))}</div><div class="kpi-value">$${totals.revenueMonth.toFixed(2)}</div></div>
        <div class="kpi"><div class="kpi-label">${esc(t("analytics.thisYear"))}</div><div class="kpi-value">$${totals.revenueYear.toFixed(2)}</div></div>
        <div class="kpi"><div class="kpi-label">${esc(t("analytics.cashRides"))}</div><div class="kpi-value">$${totals.cashRevenue.toFixed(2)}</div></div>
        <div class="kpi"><div class="kpi-label">${esc(t("analytics.cardRides"))}</div><div class="kpi-value">$${totals.cardRevenue.toFixed(2)}</div></div>
      </div>
      ${chartSVG ? `<div class="section-title">${esc(t("analytics.revenueOverTime"))}${period === "today" ? ` · ${esc(t("analytics.byHour"))}` : ""}</div><div style="margin-bottom:24px">${chartSVG}</div>` : ""}
      <div class="section-title">${esc(t("analytics.driverEarningsFor", { period: periodLabel }))}</div>
      <table><thead><tr class="pg-spacer"><td colspan="8"></td></tr><tr><th>${esc(t("csv.driver"))}</th><th>${esc(t("csv.rides"))}</th><th>${esc(t("csv.earnings"))}</th><th>${esc(t("rideDetail.cash"))}</th><th>${esc(t("rideDetail.card"))}</th><th>${esc(t("csv.avgFare"))}</th><th>${esc(t("csv.cancelRate"))}</th><th>${esc(t("csv.avgRating"))}</th></tr></thead>
      <tbody>${rows || `<tr><td colspan='8' style='color:#9ca3af'>${esc(t("analytics.noDataPeriod"))}</td></tr>`}</tbody>
      <tfoot><tr class="pg-spacer-foot"><td colspan="8"></td></tr></tfoot></table>
      ${approvalBlock()}
    `,
      label,
    );
  }

  function downloadMonthReport(group: MonthGroup) {
    // `group.key` (YYYY-MM), not `group.label`: the label is now rendered in
    // the exporter's language, and an audit row that reads "octobre 2026" for
    // one dispatcher and "October 2026" for another is not groupable and not
    // comparable. Same principle as `completed_at` and
    // `platform_fee_percent_at_completion` in mgcj-app — a recorded fact must
    // not be stored in whoever-was-looking's language.
    logDispatchEvent({ companyId, dispatcherId, eventType: "export.pdf", details: { section: "ride_history", period: group.key, row_count: group.rides.length } });
    const rows = group.rides
      .map(
        (r) => `
      <tr>
        <td>${esc(fmtDate(r.created_at, { month: "short", day: "numeric" }))}</td>
        <td style="font-family:monospace;font-size:11px">${esc(formatRideRef(r.ride_ref))}</td>
        <td>${esc(r.passenger_name)}</td><td>${esc(r.driver_name)}</td>
        <td style="font-size:11px">${esc(r.pickup_address)}</td>
        <td style="font-size:11px">${esc(r.dropoff_address)}</td>
        <td>${r.fare_final ? `$${r.fare_final.toFixed(2)}` : r.fare_estimate ? `$${r.fare_estimate.toFixed(2)}` : "—"}</td>
        <td>${rideStatusLabel(r.status)}</td>
        <td>${esc(r.payment_method)}</td>
        <td style="font-family:monospace;font-size:11px">${esc(r.receipt_number) || "—"}</td>
      </tr>`,
      )
      .join("");
    const completed = group.rides.filter((r) => r.status === "completed");
    printReport(
      t("analytics.rideHistoryTitle", { period: group.label, company: label }),
      `
      <h1>${esc(t("analytics.rideHistoryHeading", { company: label }))}</h1>
      <p class="sub">${esc(group.label)} · ${esc(t("analytics.generatedOn", { when: fmtDate(new Date(), { dateStyle: "long" }) }))}</p>
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-label">${esc(t("analytics.totalRides"))}</div><div class="kpi-value">${group.rides.length}</div></div>
        <div class="kpi"><div class="kpi-label">${esc(t("rideStatus.completed"))}</div><div class="kpi-value">${completed.length}</div></div>
        <div class="kpi"><div class="kpi-label">${esc(t("stats.revenue"))}</div><div class="kpi-value">$${group.totalRevenue.toFixed(2)}</div></div>
      </div>
      <table><thead><tr class="pg-spacer"><td colspan="10"></td></tr><tr><th>${esc(t("csv.date"))}</th><th>${esc(t("csv.ride"))}</th><th>${esc(t("rideDetail.passenger"))}</th><th>${esc(t("csv.driver"))}</th><th>${esc(t("reports.pickup"))}</th><th>${esc(t("reports.dropoff"))}</th><th>${esc(t("csv.fare"))}</th><th>${esc(t("common.status"))}</th><th>${esc(t("rideDetail.payment"))}</th><th>${esc(t("csv.receiptNo"))}</th></tr></thead>
      <tbody>${rows || `<tr><td colspan='10' style='color:#9ca3af'>${esc(t("analytics.noRides"))}</td></tr>`}</tbody>
      <tfoot><tr class="pg-spacer-foot"><td colspan="10"></td></tr></tfoot></table>
      ${approvalBlock()}
    `,
      label,
    );
  }

  function downloadYearReport(year: number, groups: MonthGroup[]) {
    logDispatchEvent({ companyId, dispatcherId, eventType: "export.pdf", details: { section: "ride_history", period: String(year), row_count: groups.flatMap((g) => g.rides).length } });
    const allYearRides = groups.flatMap((g) => g.rides);
    const completed = allYearRides.filter((r) => r.status === "completed");
    const totalRevenue = completed.reduce(
      (s, r) => s + (r.fare_final ?? r.fare_estimate ?? 0),
      0,
    );
    const cancelled = allYearRides.filter((r) => r.status === "cancelled");
    const monthSections = groups
      .map((group) => {
        const rows = group.rides
          .map(
            (r) => `
        <tr>
          <td>${esc(fmtDate(r.created_at, { month: "short", day: "numeric" }))}</td>
          <td style="font-family:monospace;font-size:11px">${esc(formatRideRef(r.ride_ref))}</td>
          <td>${esc(r.passenger_name)}</td><td>${esc(r.driver_name)}</td>
          <td style="font-size:11px">${esc(r.pickup_address)}</td>
          <td style="font-size:11px">${esc(r.dropoff_address)}</td>
          <td>${r.fare_final ? `$${r.fare_final.toFixed(2)}` : r.fare_estimate ? `$${r.fare_estimate.toFixed(2)}` : "—"}</td>
          <td>${rideStatusLabel(r.status)}</td>
          <td>${esc(r.payment_method)}</td>
          <td style="font-family:monospace;font-size:11px">${esc(r.receipt_number) || "—"}</td>
        </tr>`,
          )
          .join("");
        return `<div class="month-section">
        <div class="month-heading-row">${esc(group.label)} · ${esc(t("analytics.ridesCount", { count: group.rides.length }))} · $${group.totalRevenue.toFixed(2)}</div>
        <table><thead>
          <tr class="pg-spacer-sm"><td colspan="10"></td></tr>
          <tr><th>${esc(t("csv.date"))}</th><th>${esc(t("csv.ride"))}</th><th>${esc(t("rideDetail.passenger"))}</th><th>${esc(t("csv.driver"))}</th><th>${esc(t("reports.pickup"))}</th><th>${esc(t("reports.dropoff"))}</th><th>${esc(t("csv.fare"))}</th><th>${esc(t("common.status"))}</th><th>${esc(t("rideDetail.payment"))}</th><th>${esc(t("csv.receiptNo"))}</th></tr>
        </thead>
        <tbody>${rows || `<tr><td colspan='10' style='color:#9ca3af'>${esc(t("analytics.noRides"))}</td></tr>`}</tbody>
        <tfoot><tr class="pg-spacer-foot"><td colspan="10"></td></tr></tfoot>
        </table>
        ${approvalBlock()}
        </div>`;
      })
      .join("");
    printReport(
      t("analytics.rideHistoryTitle", { period: String(year), company: label }),
      `
      <h1>${esc(t("analytics.rideHistoryYearHeading", { company: label, year }))}</h1>
      <p class="sub">${esc(t("analytics.fullYear"))} · ${esc(t("analytics.generatedOn", { when: fmtDate(new Date(), { dateStyle: "long" }) }))}</p>
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-label">${esc(t("analytics.totalRides"))}</div><div class="kpi-value">${allYearRides.length}</div></div>
        <div class="kpi"><div class="kpi-label">${esc(t("rideStatus.completed"))}</div><div class="kpi-value">${completed.length}</div></div>
        <div class="kpi"><div class="kpi-label">${esc(t("rideStatus.cancelled"))}</div><div class="kpi-value">${cancelled.length}</div></div>
        <div class="kpi"><div class="kpi-label">${esc(t("stats.revenue"))}</div><div class="kpi-value">$${totalRevenue.toFixed(2)}</div></div>
      </div>
      ${monthSections}
    `,
      label,
    );
  }

  // ── CSV exporters ─────────────────────────────────────────────────
  function exportRidesCSV(rides: RideRow[], filename: string) {
    logDispatchEvent({ companyId, dispatcherId, eventType: "export.csv", details: { section: "ride_history", row_count: rides.length } });
    downloadCSV(
      filename,
      [
        t("csv.date"),
        t("csv.rideRef"),
        t("rideDetail.passenger"),
        t("csv.driver"),
        t("reports.pickup"),
        t("reports.dropoff"),
        t("csv.fare"),
        t("common.status"),
        t("rideDetail.payment"),
        t("csv.receiptNo"),
      ],
      rides.map((r) => [
        fmtDate(r.created_at),
        r.ride_ref,
        r.passenger_name,
        r.driver_name,
        r.pickup_address,
        r.dropoff_address,
        r.fare_final
          ? `$${r.fare_final.toFixed(2)}`
          : r.fare_estimate
            ? `$${r.fare_estimate.toFixed(2)}`
            : "",
        rideStatusLabel(r.status),
        r.payment_method,
        r.receipt_number ?? "",
      ]),
    );
  }

  function exportDriverStatsCSV() {
    logDispatchEvent({ companyId, dispatcherId, eventType: "export.csv", details: { section: "drivers", period, row_count: driverStats.length } });
    downloadCSV(
      // i18n-ok — a FILENAME. Kept in the code's own vocabulary ("today",
      // "week") rather than translated: these land in a shared Downloads
      // folder and get sorted and re-sent, so a stable name is worth more
      // than a localised one.
      // i18n-ok — a filename.
      `driver-performance-${period}.csv`,
      [
        t("csv.driver"),
        t("csv.rides"),
        t("csv.earnings"),
        t("rideDetail.cash"),
        t("rideDetail.card"),
        t("csv.avgFare"),
        t("csv.cancelRate"),
        t("csv.avgRating"),
        t("csv.ratingsCount"),
      ],
      driverStats.map((d) => [
        d.name,
        String(d.rides),
        `$${d.earnings.toFixed(2)}`,
        `$${d.cashEarnings.toFixed(2)}`,
        `$${d.cardEarnings.toFixed(2)}`,
        `$${d.avgFare.toFixed(2)}`,
        `${d.cancelRate.toFixed(1)}%`,
        d.avgRating?.toFixed(1) ?? "",
        String(d.ratingCount),
      ]),
    );
  }

  function exportReviewsCSV() {
    logDispatchEvent({ companyId, dispatcherId, eventType: "export.csv", details: { section: "reviews", row_count: filteredReviews.length } });
    downloadCSV(
      "reviews.csv",
      [
        t("csv.date"),
        t("csv.driver"),
        t("rideDetail.passenger"),
        t("csv.rating"),
        t("csv.comment"),
        t("csv.reviewedByDispatch"),
      ],
      filteredReviews.map((rv) => [
        fmtDate(rv.created_at),
        rv.driver_name ?? "",
        rv.passenger_name ?? "",
        String(rv.rating),
        rv.comment ?? "",
        // i18n-ok — a CSV CELL. Money and CSV stay in the code's own language
        // by decision (see format.ts); a localised boolean here would break a
        // spreadsheet filter that a dispatcher built against "Yes".
        rv.reviewed_by_dispatch ? "Yes" : "No",
      ]),
    );
  }

  function exportActivityCSV(rows: EventRow[]) {
    logDispatchEvent({
      companyId,
      dispatcherId,
      eventType: "export.csv",
      details: {
        section: "activity_log",
        date_from: activityDateFrom,
        date_to: activityDateTo,
        event_type_filter: activityTypeFilter,
        row_count: rows.length,
      },
    });
    downloadCSV(
      // i18n-ok — a filename.
      `activity-log-${activityDateFrom}-${activityDateTo}.csv`,
      [t("csv.dateTime"), t("settings.role.dispatcher"), t("csv.event"), t("csv.details"), t("csv.rideId")],
      rows.map((e) => [
        fmtDateTime(e.created_at, { dateStyle: "short", timeStyle: "short" }),
        e.dispatcher_name ?? "—",
        eventLabel(e.event_type),
        formatEventDetails(e.event_type, e.details),
        e.ride_id ?? "",
      ]),
    );
  }

  function exportActivityPDF(rows: EventRow[]) {
    logDispatchEvent({
      companyId,
      dispatcherId,
      eventType: "export.pdf",
      details: {
        section: "activity_log",
        date_from: activityDateFrom,
        date_to: activityDateTo,
        event_type_filter: activityTypeFilter,
        row_count: rows.length,
      },
    });
    let lastDateKey = "";
    const tableRows = rows.map((e) => {
      const dateKey = fmtDate(e.created_at, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
      const timeStr = fmtTime(e.created_at, { hour: "numeric", minute: "2-digit" });
      let sep = "";
      if (dateKey !== lastDateKey) {
        lastDateKey = dateKey;
        sep = `<tr><td colspan="4" style="background:#f3f4f6;font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.07em;padding:10px 10px 6px;border-bottom:1px solid #e5e7eb">${dateKey}</td></tr>`;
      }
      return sep + `<tr>
        <td style="white-space:nowrap;color:#6b7280">${timeStr}</td>
        <td>${e.dispatcher_name ?? "—"}</td>
        <td><span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;background:${EVENT_COLORS[e.event_type] ?? "#6B7280"}22;color:${EVENT_COLORS[e.event_type] ?? "#6B7280"}">${eventLabel(e.event_type)}</span></td>
        <td>${formatEventDetails(e.event_type, e.details)}</td>
      </tr>`;
    }).join("");
    const cancels = rows.filter((e) => e.event_type === "ride.cancelled").length;
    const driverActions = rows.filter((e) => e.event_type.startsWith("driver.")).length;
    const announcements = rows.filter((e) => e.event_type.startsWith("announcement.")).length;
    printReport(
      t("analytics.activityLogTitle", { company: label }),
      `
      <h1>${esc(t("analytics.activityLogHeading", { company: label }))}</h1>
      <p class="sub">${esc(t("analytics.dateRange", { from: activityDateFrom, to: activityDateTo }))} · ${esc(t("analytics.generatedOn", { when: fmtDate(new Date(), { dateStyle: "long" }) }))}</p>
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-label">${esc(t("analytics.totalEvents"))}</div><div class="kpi-value">${rows.length}</div></div>
        <div class="kpi"><div class="kpi-label">${esc(t("analytics.cancellations"))}</div><div class="kpi-value">${cancels}</div></div>
        <div class="kpi"><div class="kpi-label">${esc(t("analytics.driverActions"))}</div><div class="kpi-value">${driverActions}</div></div>
        <div class="kpi"><div class="kpi-label">${esc(t("nav.announcements"))}</div><div class="kpi-value">${announcements}</div></div>
      </div>
      <table>
        <thead><tr class="pg-spacer"><td colspan="4"></td></tr><tr><th>${esc(t("csv.time"))}</th><th>${esc(t("settings.role.dispatcher"))}</th><th>${esc(t("csv.event"))}</th><th>${esc(t("csv.details"))}</th></tr></thead>
        <tbody>${tableRows || `<tr><td colspan='4' style='color:#9ca3af'>${esc(t("analytics.noEvents"))}</td></tr>`}</tbody>
        <tfoot><tr class="pg-spacer-foot"><td colspan="4"></td></tr></tfoot>
      </table>
      ${approvalBlock()}
    `,
      label,
    );
  }

  function exportReviewsPDF() {
    logDispatchEvent({ companyId, dispatcherId, eventType: "export.pdf", details: { section: "reviews", row_count: filteredReviews.length } });
    const driverLabel = reviewDriverFilter === "all" ? t("reports.allDrivers") : (reviewDriverOptions.find((d) => d.id === reviewDriverFilter)?.name ?? t("common.unknown"));
    const starLabel = reviewStarFilter !== null ? ` · ${reviewStarFilter}★` : "";
    const avg = filteredReviews.length
      ? (filteredReviews.reduce((s, rv) => s + rv.rating, 0) / filteredReviews.length).toFixed(1)
      : "—";
    const tableRows = filteredReviews.map((rv) => `
      <tr>
        <td style="white-space:nowrap">${esc(fmtDate(rv.created_at, { month: "short", day: "numeric", year: "numeric" }))}</td>
        <td>${rv.driver_name ?? "—"}</td>
        <td>${rv.passenger_name ?? "—"}</td>
        <td style="font-weight:700;letter-spacing:0.05em">${"★".repeat(rv.rating)}${"☆".repeat(5 - rv.rating)}</td>
        <td style="font-size:12px">${rv.comment ?? "—"}</td>
        <td>${rv.reviewed_by_dispatch ? esc(t("common.yes")) : "—"}</td>
      </tr>`).join("");
    printReport(t("analytics.reviewsReportTitle", { company: label }), `
      <h1>${esc(t("analytics.reviewsReportHeading", { company: label }))}</h1>
      <p class="sub">${esc(driverLabel)}${esc(starLabel)} · ${esc(t("analytics.generatedOn", { when: fmtDate(new Date(), { dateStyle: "long" }) }))}</p>
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-label">${esc(t("analytics.sections.reviews"))}</div><div class="kpi-value">${filteredReviews.length}</div></div>
        <div class="kpi"><div class="kpi-label">${esc(t("drivers.avgRating"))}</div><div class="kpi-value">${avg}</div></div>
        <div class="kpi"><div class="kpi-label">${esc(t("analytics.flaggedLow"))}</div><div class="kpi-value">${filteredReviews.filter((rv) => rv.rating <= 2).length}</div></div>
      </div>
      <table>
        <thead><tr class="pg-spacer"><td colspan="6"></td></tr><tr><th>${esc(t("csv.date"))}</th><th>${esc(t("csv.driver"))}</th><th>${esc(t("rideDetail.passenger"))}</th><th>${esc(t("csv.rating"))}</th><th>${esc(t("csv.comment"))}</th><th>${esc(t("csv.reviewed"))}</th></tr></thead>
        <tbody>${tableRows || `<tr><td colspan='6' style='color:#9ca3af'>${esc(t("analytics.noReviews"))}</td></tr>`}</tbody>
        <tfoot><tr class="pg-spacer-foot"><td colspan="6"></td></tr></tfoot>
      </table>
      ${approvalBlock()}
    `, label);
  }

  function exportDriversPDF() {
    logDispatchEvent({ companyId, dispatcherId, eventType: "export.pdf", details: { section: "drivers", period, row_count: driverStats.length } });
    const pl = t(`analytics.period.${period}`);
    const totalEarnings = driverStats.reduce((s, d) => s + d.earnings, 0);
    const totalRides = driverStats.reduce((s, d) => s + d.rides, 0);
    const tableRows = driverStats.map((d) => `
      <tr>
        <td>${d.name}</td>
        <td>${d.rides}</td>
        <td style="color:#15803d;font-weight:600">$${d.earnings.toFixed(2)}</td>
        <td>$${d.cashEarnings.toFixed(2)}</td>
        <td>$${d.cardEarnings.toFixed(2)}</td>
        <td>$${d.avgFare.toFixed(2)}</td>
        <td>${d.cancelRate.toFixed(1)}%</td>
        <td>${d.avgRating?.toFixed(1) ?? "—"}</td>
      </tr>`).join("");
    printReport(t("analytics.driversReportTitle", { company: label }), `
      <h1>${esc(t("analytics.driversReportHeading", { company: label }))}</h1>
      <p class="sub">${esc(pl)} · ${esc(t("analytics.generatedOn", { when: fmtDate(new Date(), { dateStyle: "long" }) }))}</p>
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-label">${esc(t("nav.drivers"))}</div><div class="kpi-value">${driverStats.length}</div></div>
        <div class="kpi"><div class="kpi-label">${esc(t("analytics.totalRides"))}</div><div class="kpi-value">${totalRides}</div></div>
        <div class="kpi"><div class="kpi-label">${esc(t("analytics.totalEarnings"))}</div><div class="kpi-value">$${totalEarnings.toFixed(2)}</div></div>
      </div>
      <table>
        <thead><tr class="pg-spacer"><td colspan="8"></td></tr><tr><th>${esc(t("csv.driver"))}</th><th>${esc(t("csv.rides"))}</th><th>${esc(t("csv.earnings"))}</th><th>${esc(t("rideDetail.cash"))}</th><th>${esc(t("rideDetail.card"))}</th><th>${esc(t("csv.avgFare"))}</th><th>${esc(t("csv.cancelPct"))}</th><th>${esc(t("csv.avgRating"))}</th></tr></thead>
        <tbody>${tableRows || `<tr><td colspan='8' style='color:#9ca3af'>${esc(t("analytics.noDataPeriod"))}</td></tr>`}</tbody>
        <tfoot><tr class="pg-spacer-foot"><td colspan="8"></td></tr></tfoot>
      </table>
      ${approvalBlock()}
    `, label);
  }

  function exportReceiptsPDF() {
    logDispatchEvent({ companyId, dispatcherId, eventType: "export.pdf", details: { section: "receipts", row_count: filteredReceipts.length } });
    const total = filteredReceipts.reduce((s, inv) => s + inv.fare, 0);
    const tableRows = filteredReceipts.map((inv) => `
      <tr>
        <td style="font-family:monospace;font-size:11px;font-weight:700">${inv.receipt_number}</td>
        <td style="white-space:nowrap">${esc(fmtDate(inv.sent_at, { month: "short", day: "numeric", year: "numeric" }))}</td>
        <td>${inv.passenger_name ?? "—"}</td>
        <td>${inv.driver_name ?? "—"}</td>
        <td style="font-size:11px">${inv.pickup_address && inv.dropoff_address ? `${inv.pickup_address} → ${inv.dropoff_address}` : inv.pickup_address ?? "—"}</td>
        <td style="color:#15803d;font-weight:600">$${inv.fare.toFixed(2)}</td>
        <td>${inv.payment_method ? esc(t(inv.payment_method === "cash" ? "rideDetail.cash" : "rideDetail.card")) : "—"}</td>
      </tr>`).join("");
    printReport(t("analytics.receiptsReportTitle", { company: label }), `
      <h1>${esc(t("analytics.receiptsReportHeading", { company: label }))}</h1>
      <p class="sub">${esc(t("analytics.generatedOn", { when: fmtDate(new Date(), { dateStyle: "long" }) }))}</p>
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-label">${esc(t("analytics.sections.receipts"))}</div><div class="kpi-value">${filteredReceipts.length}</div></div>
        <div class="kpi"><div class="kpi-label">${esc(t("reports.total"))}</div><div class="kpi-value">$${total.toFixed(2)}</div></div>
      </div>
      <table>
        <thead><tr class="pg-spacer"><td colspan="7"></td></tr><tr><th>${esc(t("csv.receiptNo"))}</th><th>${esc(t("csv.date"))}</th><th>${esc(t("rideDetail.passenger"))}</th><th>${esc(t("csv.driver"))}</th><th>${esc(t("csv.route"))}</th><th>${esc(t("csv.amount"))}</th><th>${esc(t("rideDetail.payment"))}</th></tr></thead>
        <tbody>${tableRows || `<tr><td colspan='7' style='color:#9ca3af'>${esc(t("analytics.noReceipts"))}</td></tr>`}</tbody>
        <tfoot><tr class="pg-spacer-foot"><td colspan="7"></td></tr></tfoot>
      </table>
      ${approvalBlock()}
    `, label);
  }

  function exportReceiptsCSV() {
    logDispatchEvent({ companyId, dispatcherId, eventType: "export.csv", details: { section: "receipts", row_count: filteredReceipts.length } });
    downloadCSV(
      "receipts.csv",
      [t("csv.receiptNo"), t("csv.date"), t("rideDetail.passenger"), t("csv.driver"),
       t("reports.pickup"), t("reports.dropoff"), t("csv.amount"), t("rideDetail.payment")],
      filteredReceipts.map((inv) => [
        inv.receipt_number,
        fmtDate(inv.sent_at),
        inv.passenger_name ?? "",
        inv.driver_name ?? "",
        inv.pickup_address ?? "",
        inv.dropoff_address ?? "",
        `$${inv.fare.toFixed(2)}`,
        inv.payment_method ?? "",
      ]),
    );
  }

  // ── Derived ───────────────────────────────────────────────────────
  const availableYears = Array.from(
    new Set(allRides.map((r) => new Date(r.created_at).getFullYear())),
  ).sort((a, b) => b - a);

  const filteredReceipts = receiptSearch.trim()
    ? receipts.filter((inv) =>
        inv.receipt_number.toLowerCase().includes(receiptSearch.toLowerCase()) ||
        (inv.passenger_name ?? "").toLowerCase().includes(receiptSearch.toLowerCase()),
      )
    : receipts;
  const filteredRides = (
    rideFilter === "all"
      ? allRides
      : allRides.filter((r) => r.status === rideFilter)
  ).filter((r) => {
    if (!rideSearch.trim()) return true;
    const q = rideSearch.toLowerCase();
    return (
      (r.passenger_name ?? "").toLowerCase().includes(q) ||
      (r.driver_name ?? "").toLowerCase().includes(q) ||
      (r.pickup_address ?? "").toLowerCase().includes(q) ||
      (r.dropoff_address ?? "").toLowerCase().includes(q) ||
      (r.receipt_number ?? "").toLowerCase().includes(q)
    );
  });

  const monthGroups: MonthGroup[] = (() => {
    const map = new Map<string, RideRow[]>();
    filteredRides
      .filter((r) => new Date(r.created_at).getFullYear() === selectedYear)
      .forEach((r) => {
        const key = getMonthKey(r.created_at);
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(r);
      });
    return Array.from(map.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, rides]) => ({
        key,
        label: getMonthLabel(key),
        rides,
        totalRevenue: rides
          .filter((r) => r.status === "completed")
          .reduce((s, r) => s + (r.fare_final ?? r.fare_estimate ?? 0), 0),
      }));
  })();

  function toggleMonth(key: string) {
    setExpandedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const peakHour = hourStats.length
    ? hourStats.reduce((a, b) => (b.rides > a.rides ? b : a))
    : null;
  const peakDay = dayStats.length
    ? dayStats.reduce((a, b) => (b.rides > a.rides ? b : a))
    : null;
  function fmtHour(h: number) {
    if (h === 0) return "12am";
    if (h < 12) return `${h}am`;
    if (h === 12) return "12pm";
    return `${h - 12}pm`;
  }

  const reviewDriverOptions = Array.from(
    reviews
      .reduce((map, rv) => {
        if (!map.has(rv.driver_id))
          map.set(rv.driver_id, rv.driver_name ?? t("common.unknown"));
        return map;
      }, new Map<string, string>())
      .entries(),
  )
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const filteredReviews = reviews.filter((rv) => {
    if (reviewDriverFilter !== "all" && rv.driver_id !== reviewDriverFilter)
      return false;
    if (reviewStarFilter !== null && rv.rating !== reviewStarFilter)
      return false;
    return true;
  });

  const selectedDriverReviews =
    reviewDriverFilter !== "all"
      ? reviews.filter((rv) => rv.driver_id === reviewDriverFilter)
      : [];
  const selectedDriverAvg = selectedDriverReviews.length
    ? Math.round(
        (selectedDriverReviews.reduce((s, rv) => s + rv.rating, 0) /
          selectedDriverReviews.length) *
          10,
      ) / 10
    : null;
  const selectedDriverFlagged = selectedDriverReviews.filter(
    (rv) => rv.rating <= 2,
  ).length;


  // The mid-sentence form, as its OWN key rather than periodLabel.toLowerCase().
  // Lowercasing a label to drop it into a sentence is an English-only trick:
  // French needs an article and agreement ("ce mois-ci", "cette année"), and
  // some languages do not case-fold at all.
  const periodPhrase = t(`analytics.periodPhrase.${period}`);

  function RevenueTooltip({ active, payload, label }: any) {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
      <div style={{
        background: "#1E2A3A",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 8,
        padding: "10px 14px",
        fontSize: 12,
        boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
      }}>
        <div style={{ color: "#9CA3AF", marginBottom: 5 }}>{label}</div>
        <div style={{ fontSize: 17, fontWeight: 700, color: "#E8500A" }}>
          ${payload[0].value.toFixed(2)}
        </div>
        <div style={{ color: "#6B7280", marginTop: 3 }}>
          {t("analytics.ridesCount", { count: d.rides })}
        </div>
      </div>
    );
  }

  function PeakTooltip({ active, payload }: any) {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    const lbl = d.label ?? d.day;
    const count = d.rides;
    return (
      <div style={{
        background: "#1E2A3A",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 8,
        padding: "10px 14px",
        fontSize: 12,
        boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
      }}>
        <div style={{ color: "#9CA3AF", marginBottom: 4 }}>{lbl}</div>
        <div style={{ fontSize: 17, fontWeight: 700, color: "#E8500A" }}>
          {t("analytics.ridesCount", { count })}
        </div>
      </div>
    );
  }

  return (
    <>
      <style>{`
        .an-wrap { display: flex; height: 100%; overflow: hidden; font-family: system-ui, -apple-system, sans-serif; }
        .an-panel { width: 200px; background: #0F1723; border-right: 1px solid rgba(255,255,255,0.06); display: flex; flex-direction: column; flex-shrink: 0; padding: 16px 0; }
        .an-panel-title { font-size: 10px; font-weight: 600; color: #6B7280; letter-spacing: 0.09em; text-transform: uppercase; padding: 0 16px 10px; }
        .an-section-btn { display: flex; align-items: center; width: 100%; height: 38px; padding: 0 16px; background: none; border: none; border-left: 2px solid transparent; font-size: 13px; font-weight: 500; color: #6B7280; cursor: pointer; text-align: left; transition: background 0.12s, color 0.12s, border-color 0.12s; font-family: system-ui, sans-serif; }
        .an-section-btn:hover { background: rgba(255,255,255,0.04); color: #9CA3AF; }
        .an-section-btn.active { border-left-color: #E8500A; background: rgba(232,80,10,0.07); color: #E8500A; }
        .an-content { flex: 1; overflow-y: auto; padding: 24px; background: #111827; }
        .an-content::-webkit-scrollbar { width: 4px; }
        .an-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }
        .an-section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 10px; }
        .an-section-title { font-size: 18px; font-weight: 700; color: #F1F5F9; }
        .an-controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        .an-period-btns { display: flex; background: #1E2A3A; border: 1px solid rgba(255,255,255,0.07); border-radius: 8px; padding: 3px; gap: 2px; }
        .an-period-btn { background: transparent; border: none; border-radius: 6px; padding: 5px 12px; font-size: 12px; font-weight: 500; color: #6B7280; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s, color 0.12s; }
        .an-period-btn.active { background: #111827; color: #F1F5F9; }
        .an-download-btn { background: rgba(29,158,117,0.1); color: #1D9E75; border: 1px solid rgba(29,158,117,0.25); border-radius: 7px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; white-space: nowrap; }
        .an-download-btn:hover { background: rgba(29,158,117,0.18); }
        .an-download-btn-sm { background: rgba(29,158,117,0.08); color: #1D9E75; border: 1px solid rgba(29,158,117,0.2); border-radius: 6px; padding: 4px 10px; font-size: 11px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; white-space: nowrap; }
        .an-download-btn-sm:hover { background: rgba(29,158,117,0.15); }
        .an-csv-btn { background: rgba(74,158,255,0.08); color: #4a9eff; border: 1px solid rgba(74,158,255,0.2); border-radius: 7px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; white-space: nowrap; }
        .an-csv-btn:hover { background: rgba(74,158,255,0.15); }
        .an-kpi-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 10px; margin-bottom: 20px; }
        .an-kpi-card { background: #1E2A3A; border-radius: 12px; padding: 16px; border: 1px solid rgba(255,255,255,0.05); }
        .an-kpi-label { font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
        .an-kpi-value { font-size: 24px; font-weight: 700; color: #F1F5F9; line-height: 1; }
        .an-kpi-sub { font-size: 11px; color: #6B7280; margin-top: 4px; }
        .an-revenue-strip { display: grid; grid-template-columns: repeat(4,1fr); gap: 10px; margin-bottom: 20px; }
        .an-revenue-mini { background: #1E2A3A; border-radius: 10px; padding: 12px 14px; border: 1px solid rgba(255,255,255,0.05); }
        .an-revenue-mini-label { font-size: 10px; color: #6B7280; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; margin-bottom: 5px; }
        .an-revenue-mini-value { font-size: 18px; font-weight: 700; color: #F1F5F9; }
        /* ── Settlements ── */
        .an-attn-badge { font-size: 11px; font-weight: 700; color: #E24B4A; background: rgba(226,75,74,0.14); border-radius: 999px; padding: 2px 9px; line-height: 1.5; }
        .an-scope-note { font-size: 11px; color: #6B7280; }
        .an-settle-clear { display: flex; align-items: center; gap: 10px; background: rgba(29,158,117,0.07); border: 1px solid rgba(29,158,117,0.2); border-radius: 10px; padding: 16px 18px; font-size: 13px; color: #9CA3AF; margin-bottom: 4px; }
        .an-attn-split { display: grid; grid-template-columns: repeat(2,1fr); gap: 10px; margin-bottom: 12px; }
        .an-attn-tile { background: #1E2A3A; border: 1px solid rgba(255,255,255,0.05); border-radius: 10px; padding: 12px 14px; }
        .an-attn-tile-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 5px; }
        .an-attn-tile-value { font-size: 20px; font-weight: 700; color: #F1F5F9; line-height: 1; }
        .an-attn-tile-sub { font-size: 11px; color: #6B7280; margin-top: 5px; }
        .an-attn-card { display: flex; gap: 12px; background: #1E2A3A; border: 1px solid rgba(255,255,255,0.06); border-left: 3px solid #E24B4A; border-radius: 10px; padding: 13px 15px; align-items: flex-start; justify-content: space-between; }
        .an-attn-meta { font-size: 12px; color: #9CA3AF; margin-top: 4px; }
        .an-attn-hint { font-size: 12px; color: #94A3B8; margin-top: 7px; max-width: 620px; line-height: 1.45; }
        .an-attn-id { font-size: 10px; color: #4B5563; margin-top: 6px; font-family: ui-monospace, monospace; }
        .an-pill { display: inline-block; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.05em; }
        .an-comp-bar { display: flex; width: 100%; height: 10px; border-radius: 999px; overflow: hidden; background: rgba(255,255,255,0.04); margin-bottom: 16px; }
        .an-comp-seg { height: 100%; transition: opacity 0.12s; }
        .an-share-track { width: 84px; height: 5px; border-radius: 999px; background: rgba(255,255,255,0.06); overflow: hidden; margin-top: 5px; }
        .an-share-fill { height: 100%; border-radius: 999px; }
        .an-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; flex: none; }
        .an-settle-row { cursor: pointer; transition: background 0.12s; }
        .an-settle-row:hover { background: rgba(255,255,255,0.035) !important; }
        .an-chip { background: #1E2A3A; border: 1px solid rgba(255,255,255,0.07); border-radius: 999px; padding: 5px 13px; font-size: 12px; color: #9CA3AF; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s, color 0.12s, border-color 0.12s; }
        .an-chip:hover { color: #E2E8F0; }
        .an-chip.active { background: #111827; color: #F1F5F9; border-color: rgba(255,255,255,0.18); }
        .an-chip-count { color: #6B7280; margin-left: 6px; font-size: 11px; }
        .an-chart-card { background: #1E2A3A; border-radius: 12px; padding: 20px; border: 1px solid rgba(255,255,255,0.05); margin-bottom: 16px; }
        .an-chart-title { font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 16px; }
        .an-no-data { color: #6B7280; font-size: 13px; text-align: center; padding: 24px 0; }
        /* ── Settlement rollup hero + charts ── */
        .an-set-hero { display: grid; grid-template-columns: 1.5fr 1fr 1fr 1fr; gap: 10px; margin-bottom: 12px; }
        .an-hero-card { background: #1E2A3A; border: 1px solid rgba(255,255,255,0.05); border-radius: 12px; padding: 15px 16px; }
        .an-hero-card.lead { border-color: rgba(29,158,117,0.28); background: linear-gradient(180deg, rgba(29,158,117,0.09), rgba(29,158,117,0.015) 62%, transparent), #1E2A3A; }
        .an-hero-label { font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 7px; display: flex; align-items: center; gap: 6px; }
        .an-hero-value { font-size: 22px; font-weight: 700; color: #F1F5F9; line-height: 1; font-variant-numeric: tabular-nums; }
        .an-hero-card.lead .an-hero-value { font-size: 28px; color: #2fce9a; }
        /* company_settles: the lead tile is "your account" money, so it reads
           blue instead of driver-green. Same layout, just re-accented. */
        .an-hero-card.lead.paid-company { border-color: rgba(74,158,255,0.28); background: linear-gradient(180deg, rgba(74,158,255,0.09), rgba(74,158,255,0.015) 62%, transparent), #1E2A3A; }
        .an-hero-card.lead.paid-company .an-hero-value { color: #6cb2ff; }
        .an-hero-sub { font-size: 11px; color: #6B7280; margin-top: 6px; }
        .an-hero-sub.up { color: #1D9E75; }
        .an-hero-sub.down { color: #E24B4A; }
        .an-two-up { display: grid; grid-template-columns: 340px 1fr; gap: 12px; margin-bottom: 20px; }
        .an-donut-wrap { display: flex; align-items: center; gap: 18px; }
        .an-donut-legend { display: flex; flex-direction: column; gap: 9px; flex: 1; min-width: 0; }
        .an-leg { display: flex; align-items: center; gap: 8px; font-size: 12px; }
        .an-leg .an-dot { margin-right: 0; }
        .an-leg-name { color: #CBD5E1; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .an-leg-amt { color: #F1F5F9; font-weight: 600; font-variant-numeric: tabular-nums; }
        .an-leg-pct { color: #6B7280; width: 40px; text-align: right; font-variant-numeric: tabular-nums; }
        .an-trend-legend { display: flex; gap: 14px; margin-top: 10px; }
        .an-tl { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #9CA3AF; }
        .an-tl-swatch { width: 10px; height: 3px; border-radius: 2px; }
        /* donut: draw-in + hover morph share one stroke-dasharray transition */
        .an-donut-seg { transition: stroke-dasharray 0.7s cubic-bezier(.4,0,.2,1), stroke-width 0.18s ease, opacity 0.18s ease; cursor: pointer; }
        .an-leg { display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer; padding: 2px 4px; border-radius: 5px; transition: background 0.12s; }
        .an-leg:hover, .an-leg.hot { background: rgba(255,255,255,0.05); }
        .an-spark-dot { animation: an-pulse 1.8s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
        @keyframes an-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
        /* daily flow: HTML bars so heights transition smoothly on any data change */
        .an-bars-plot { position: relative; height: 168px; margin: 0 0 0 34px; }
        .an-grid-line { position: absolute; left: 0; right: 0; height: 1px; background: rgba(255,255,255,0.05); }
        .an-grid-line.base { background: rgba(255,255,255,0.09); }
        .an-ylab { position: absolute; left: -34px; width: 30px; text-align: right; font-size: 9px; color: #4B5563; transform: translateY(-50%); font-variant-numeric: tabular-nums; }
        .an-bars-row { position: absolute; left: 0; right: 0; bottom: 22px; top: 0; display: flex; align-items: flex-end; }
        .an-bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; cursor: default; position: relative; }
        .an-bar-stack { width: 62%; max-width: 34px; display: flex; flex-direction: column; justify-content: flex-end; height: 100%; }
        .an-bar-seg { width: 100%; border-radius: 2px 2px 0 0; height: 0; transition: height 0.55s cubic-bezier(.4,0,.2,1), filter 0.15s ease; }
        .an-bar-paid { background: #1D9E75; }
        .an-bar-held { background: #F59E0B; margin-bottom: 1px; }
        .an-bar-col:hover .an-bar-seg { filter: brightness(1.22); }
        /* company_settles fee waterfall: gross → −fees → net, spelled out. */
        .an-fee-waterfall { max-width: 440px; border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 2px 16px; background: #1E2A3A; }
        .an-fw-row { display: flex; justify-content: space-between; align-items: center; padding: 11px 0; font-size: 13px; color: #C7CEDB; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .an-fw-row:last-child { border-bottom: none; }
        .an-fw-row.minus { color: #9AA3B2; }
        .an-fw-row.total { font-weight: 700; font-size: 15px; color: #F1F5F9; }
        .an-fw-label { display: flex; align-items: center; gap: 8px; }
        .an-fw-amt { font-variant-numeric: tabular-nums; }
        .an-fw-row.total .an-fw-amt { color: #6cb2ff; }
        .an-bar-lab { position: absolute; bottom: -22px; left: 50%; transform: translateX(-50%); font-size: 9px; color: #6B7280; white-space: nowrap; }
        .an-bar-tip { position: absolute; left: 50%; transform: translateX(-50%); pointer-events: none; opacity: 0; background: #0b1119; border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 8px 10px; font-size: 11px; z-index: 5; min-width: 132px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); transition: opacity 0.12s; }
        .an-bar-col:hover .an-bar-tip { opacity: 1; }
        .an-bar-tip .an-tip-day { color: #9CA3AF; font-weight: 600; margin-bottom: 5px; }
        .an-tip-row { display: flex; justify-content: space-between; gap: 14px; margin-top: 2px; }
        .an-tip-row .k { display: flex; align-items: center; gap: 5px; color: #9CA3AF; }
        .an-tip-row .v { color: #F1F5F9; font-weight: 600; font-variant-numeric: tabular-nums; }
        .an-tip-row.tot { border-top: 1px solid rgba(255,255,255,0.08); margin-top: 5px; padding-top: 5px; }
        @media (prefers-reduced-motion: reduce) {
          .an-donut-seg, .an-bar-seg { transition: none; }
          .an-spark-dot { animation: none; }
        }
        @media (max-width: 1000px) {
          .an-set-hero { grid-template-columns: 1fr 1fr; }
          .an-two-up { grid-template-columns: 1fr; }
        }
        .an-x-labels { display: flex; justify-content: space-between; margin-top: 8px; }
        .an-x-label { font-size: 10px; color: #6B7280; }
        .an-table { width: 100%; border-collapse: collapse; }
        .an-th { font-size: 10px; font-weight: 600; color: #6B7280; text-align: left; padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); text-transform: uppercase; letter-spacing: 0.06em; }
        .an-td { font-size: 13px; color: #9CA3AF; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.03); vertical-align: middle; }
        .an-td.primary { color: #E2E8F0; font-weight: 500; }
        .an-td.addr { font-size: 11px; color: #6B7280; max-width: 160px; }
        .an-td.green { color: #1D9E75; font-weight: 600; }
        .an-td.red { color: #E24B4A; }
        .an-td.amber { color: #F59E0B; }
        /* ── Driver leaderboard ── */
        .an-dl-head, .an-dl-row { display: grid; grid-template-columns: 30px 40px minmax(0,1fr) 196px 96px 74px; gap: 14px; align-items: center; }
        .an-dl-head { padding: 10px 18px; border-bottom: 1px solid rgba(255,255,255,0.06); }
        .an-dl-hcell { font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.06em; }
        .an-dl-row { padding: 13px 18px; border-bottom: 1px solid rgba(255,255,255,0.035); transition: background 0.12s; cursor: pointer; }
        .an-dl-row:last-child { border-bottom: none; }
        .an-dl-row:hover { background: rgba(255,255,255,0.022); }
        .an-dl-rank { font-size: 13px; font-weight: 700; color: #4B5563; text-align: center; font-variant-numeric: tabular-nums; }
        .an-dl-rank.medal { font-size: 18px; line-height: 1; }
        .an-dl-av { width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; color: #E2E8F0; background: linear-gradient(135deg, #2c3d51, #1f2c3b); border: 1px solid rgba(255,255,255,0.06); overflow: hidden; flex: none; }
        .an-dl-av img { width: 100%; height: 100%; object-fit: cover; }
        .an-dl-name { font-size: 14px; font-weight: 600; color: #E2E8F0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .an-dl-meta { font-size: 11px; color: #6B7280; margin-top: 2px; font-variant-numeric: tabular-nums; }
        .an-dl-meta .warn { color: #E24B4A; font-weight: 600; }
        .an-dl-earn-val { font-size: 14px; font-weight: 700; color: #1D9E75; font-variant-numeric: tabular-nums; text-align: right; margin-bottom: 6px; }
        .an-dl-earn-track { height: 6px; border-radius: 999px; background: rgba(255,255,255,0.05); overflow: hidden; }
        .an-dl-earn-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #157355, #22c993); transition: width 0.6s cubic-bezier(.4,0,.2,1); }
        .an-dl-split-track { display: flex; height: 6px; border-radius: 999px; overflow: hidden; background: rgba(255,255,255,0.05); }
        .an-dl-split-cash { background: #F59E0B; }
        .an-dl-split-card { background: #1D9E75; }
        .an-dl-split-legend { display: flex; justify-content: space-between; gap: 6px; font-size: 9px; color: #6B7280; margin-top: 5px; font-variant-numeric: tabular-nums; }
        .an-dl-rating { text-align: right; font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
        .an-dl-rating .cnt { display: block; font-size: 10px; color: #6B7280; font-weight: 400; margin-top: 1px; }
        .an-dl-rating .none { color: #4B5563; font-weight: 400; }
        /* ── Driver detail modal ── */
        .an-dm-head { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; }
        .an-dm-av { width: 56px; height: 56px; border-radius: 50%; overflow: hidden; flex: none; display: flex; align-items: center; justify-content: center; font-size: 19px; font-weight: 700; color: #E2E8F0; background: linear-gradient(135deg, #2c3d51, #1f2c3b); border: 1px solid rgba(255,255,255,0.08); }
        .an-dm-av img { width: 100%; height: 100%; object-fit: cover; }
        .an-dm-name { font-size: 18px; font-weight: 700; color: #F1F5F9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .an-dm-sub { font-size: 12px; color: #6B7280; margin-top: 3px; }
        .an-dm-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 18px; }
        .an-dm-stat { background: #18222F; border: 1px solid rgba(255,255,255,0.04); border-radius: 10px; padding: 12px 13px; }
        .an-dm-stat-label { font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
        .an-dm-stat-value { font-size: 18px; font-weight: 700; color: #F1F5F9; font-variant-numeric: tabular-nums; }
        .an-dm-stat-sub { font-size: 10px; color: #6B7280; margin-top: 3px; font-variant-numeric: tabular-nums; }
        .an-dm-section-title { font-size: 11px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.07em; margin: 4px 0 10px; }
        .an-dm-review { background: #18222F; border: 1px solid rgba(255,255,255,0.04); border-radius: 10px; padding: 11px 13px; margin-bottom: 8px; }
        .an-dm-review-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; }
        .an-dm-review-stars { font-size: 12px; font-weight: 700; letter-spacing: 1px; }
        .an-dm-review-date { font-size: 10px; color: #6B7280; }
        .an-dm-review-text { font-size: 12px; color: #C7CEDB; line-height: 1.45; }
        .an-status { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 20px; white-space: nowrap; }
        .an-filter-row { display: flex; gap: 6px; margin-bottom: 14px; flex-wrap: wrap; align-items: center; }
        .an-filter-btn { background: #1E2A3A; border: 1px solid rgba(255,255,255,0.07); border-radius: 6px; padding: 5px 12px; font-size: 12px; color: #6B7280; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s, color 0.12s; }
        .an-filter-btn.active { background: #E8500A; color: #fff; border-color: #E8500A; }
        .an-filter-count { font-size: 11px; color: #6B7280; margin-left: auto; }
        .an-month-group { margin-bottom: 8px; border-radius: 12px; overflow: hidden; border: 1px solid rgba(255,255,255,0.05); }
        .an-month-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; background: #1E2A3A; cursor: pointer; user-select: none; transition: background 0.12s; gap: 12px; }
        .an-month-header:hover { background: #213040; }
        .an-month-header-left { display: flex; align-items: center; gap: 10px; }
        .an-month-chevron { font-size: 11px; color: #6B7280; transition: transform 0.2s; display: inline-block; }
        .an-month-chevron.open { transform: rotate(90deg); }
        .an-month-name { font-size: 14px; font-weight: 600; color: #E2E8F0; }
        .an-month-meta { font-size: 12px; color: #6B7280; }
        .an-month-revenue { font-size: 14px; font-weight: 700; color: #1D9E75; }
        .an-month-body { background: #18222F; }
        .an-ride-row { cursor: pointer; transition: background 0.1s; }
        .an-ride-row:hover td { background: rgba(232,80,10,0.04); }
        .an-peak-row { display: flex; gap: 16px; }
        .an-bar-chart-wrap { flex: 1; background: #18222F; border-radius: 10px; padding: 16px; border: 1px solid rgba(255,255,255,0.04); }
        .an-review-card { background: #1E2A3A; border-radius: 10px; padding: 14px; margin-bottom: 8px; border: 1px solid rgba(255,255,255,0.05); transition: border-color 0.12s; }
        .an-review-card.flagged { background: #1A0F0F; border-color: rgba(248,113,113,0.2); }
        .an-review-card.dispatch-reviewed { border-color: rgba(29,158,117,0.2); }
        .an-review-flag { font-size: 11px; color: #F87171; background: rgba(248,113,113,0.08); border-radius: 5px; padding: 4px 8px; margin-bottom: 8px; display: inline-block; }
        .an-reviewed-badge { font-size: 11px; color: #1D9E75; background: rgba(29,158,117,0.08); border-radius: 5px; padding: 4px 8px; margin-bottom: 8px; display: inline-block; border: 1px solid rgba(29,158,117,0.2); }
        .an-mark-reviewed-btn { background: rgba(29,158,117,0.08); color: #1D9E75; border: 1px solid rgba(29,158,117,0.2); border-radius: 6px; padding: 5px 12px; font-size: 11px; font-weight: 600; cursor: pointer; font-family: system-ui, sans-serif; transition: background 0.12s; margin-top: 10px; }
        .an-mark-reviewed-btn:hover { background: rgba(29,158,117,0.15); }
        .an-mark-reviewed-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .an-loading { color: #6B7280; text-align: center; padding: 48px; font-size: 14px; }
        .an-select { background: #1E2A3A; border: 1px solid rgba(255,255,255,0.07); border-radius: 7px; padding: 5px 12px; font-size: 12px; color: #E2E8F0; cursor: pointer; font-family: system-ui, sans-serif; outline: none; appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%234B5563'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; padding-right: 28px; }
        /* Ride detail modal */
        .an-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.72); display: flex; align-items: center; justify-content: center; z-index: 1000; backdrop-filter: blur(3px); }
        .an-modal { background: #1E2A3A; border-radius: 14px; padding: 26px; width: 100%; max-width: 480px; border: 1px solid rgba(255,255,255,0.08); max-height: 88vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
        .an-modal-title { font-size: 17px; font-weight: 700; color: #F1F5F9; margin-bottom: 16px; }
        .an-detail-row { display: flex; justify-content: space-between; align-items: flex-start; padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .an-detail-label { font-size: 12px; color: #9CA3AF; font-weight: 500; }
        .an-detail-value { font-size: 13px; color: #E2E8F0; font-weight: 500; max-width: 60%; text-align: right; }
        .an-detail-row-warning { background: rgba(226,75,74,0.1); border-radius: 6px; padding: 9px 8px; margin: 2px 0; border-bottom: none; }
        .an-detail-value-warning { color: #E24B4A; font-weight: 700; }
        .an-modal-close { background: transparent; border: 1px solid rgba(255,255,255,0.08); color: #6B7280; border-radius: 8px; padding: 8px 16px; font-size: 13px; cursor: pointer; font-family: system-ui, sans-serif; width: 100%; margin-top: 16px; transition: background 0.12s; }
        .an-modal-close:hover { background: rgba(255,255,255,0.04); }
        .an-modal-section { font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.08em; margin: 16px 0 8px; }
        /* Activity log */
        .an-date-input { background: #111E2E; border: 1px solid rgba(255,255,255,0.07); border-radius: 7px; padding: 5px 10px; font-size: 12px; color: #E2E8F0; font-family: system-ui, sans-serif; outline: none; }
        .an-date-input:focus { border-color: rgba(232,80,10,0.4); }
        /* Receipts */
        .inv-search-row { margin-bottom: 16px; }
        .inv-search { width: 100%; max-width: 380px; background: #1E2A3A; border: 1px solid rgba(255,255,255,0.07); border-radius: 8px; padding: 8px 14px; font-size: 13px; color: #E2E8F0; font-family: system-ui, sans-serif; outline: none; }
        .inv-search:focus { border-color: rgba(232,80,10,0.4); }
        .inv-search::placeholder { color: #6B7280; }
        .receipt-tag { font-family: monospace; font-size: 11px; font-weight: 700; color: #E8500A; background: rgba(232,80,10,0.08); border: 1px solid rgba(232,80,10,0.2); border-radius: 5px; padding: 2px 7px; white-space: nowrap; }
        .an-type-select { background: #111E2E; border: 1px solid rgba(255,255,255,0.07); border-radius: 7px; padding: 5px 28px 5px 10px; font-size: 12px; color: #E2E8F0; cursor: pointer; font-family: system-ui, sans-serif; outline: none; appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%234B5563'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 8px center; }
        .al-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 14px; background: #111E2E; border-radius: 10px; border: 1px solid rgba(255,255,255,0.04); margin-bottom: 16px; }
        .al-toolbar-sep { width: 1px; height: 16px; background: rgba(255,255,255,0.07); margin: 0 2px; }
        .al-toolbar-label { font-size: 11px; color: #6B7280; white-space: nowrap; }
        .al-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 20px; }
        .al-stat { background: #111E2E; border-radius: 10px; padding: 14px 16px; border: 1px solid rgba(255,255,255,0.04); }
        .al-stat-val { font-size: 28px; font-weight: 700; color: #F1F5F9; line-height: 1; display: block; }
        .al-stat-lbl { font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.07em; margin-top: 5px; display: block; }
        .al-table { width: 100%; border-collapse: collapse; }
        .al-th { font-size: 10px; font-weight: 600; color: #6B7280; text-transform: uppercase; letter-spacing: 0.07em; padding: 10px 16px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .al-tr { border-bottom: 1px solid rgba(255,255,255,0.035); }
        .al-tr:last-child { border-bottom: none; }
        .al-tr:hover td { background: rgba(255,255,255,0.015); }
        .al-td { padding: 11px 16px; vertical-align: middle; }
        .al-td-time { font-size: 12px; color: #9CA3AF; white-space: nowrap; font-variant-numeric: tabular-nums; }
        .al-td-dispatcher { font-size: 12px; color: #9CA3AF; white-space: nowrap; font-weight: 500; }
        .al-td-event { font-size: 12px; font-weight: 600; white-space: nowrap; }
        .al-td-detail { font-size: 12px; color: #9CA3AF; }
      `}</style>

      <div className="an-wrap">
        {/* LEFT PANEL */}
        <div className="an-panel">
          <div className="an-panel-title">{t("nav.analytics")}</div>
          {SECTION_ITEMS.map((s) => {
            const unreviewedLow =
              s.id === "reviews"
                ? reviews.filter(
                    (rv) => rv.rating <= 2 && !rv.reviewed_by_dispatch,
                  ).length
                : 0;
            return (
              <button
                key={s.id}
                className={`an-section-btn${section === s.id ? " active" : ""}`}
                onClick={() => setSection(s.id)}
                style={{ position: "relative" }}
              >
                {t(s.labelKey)}
                {unreviewedLow > 0 && (
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 10,
                      fontWeight: 700,
                      background: "rgba(248,113,113,0.15)",
                      color: "#F87171",
                      borderRadius: 8,
                      padding: "1px 6px",
                      border: "1px solid rgba(248,113,113,0.25)",
                    }}
                  >
                    {unreviewedLow}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="an-content">
          {/* ── REVENUE ── */}
          {section === "revenue" && (
            <>
              <div className="an-section-header">
                <div className="an-section-title">{t("stats.revenue")}</div>
                <div className="an-controls">
                  <div className="an-period-btns">
                    {(["today", "week", "month", "year"] as const).map((p) => (
                      <button
                        key={p}
                        className={`an-period-btn${period === p ? " active" : ""}`}
                        onClick={() => setPeriod(p)}
                      >
                        {/* Was `p.charAt(0).toUpperCase() + p.slice(1)` — a
                            label computed from a code identifier, invisible to
                            any scanner of string literals. */}
                        {t(`analytics.period.${p}`)}
                      </button>
                    ))}
                  </div>
                  <button
                    className="an-download-btn"
                    onClick={downloadRevenueReport}
                  >
                    {t("analytics.pdf")}
                  </button>
                  <button className="an-csv-btn" onClick={exportDriverStatsCSV}>
                    {t("analytics.csv")}
                  </button>
                </div>
              </div>

              {revenueLoading ? (
                <div className="an-loading">{t("common.loading")}</div>
              ) : (
                <>
                  {/* Always-visible strip */}
                  <div className="an-revenue-strip">
                    <div className="an-revenue-mini">
                      <div className="an-revenue-mini-label">{t("stats.today")}</div>
                      <div
                        className="an-revenue-mini-value"
                        style={{
                          color: period === "today" ? "#E8500A" : "#F1F5F9",
                        }}
                      >
                        ${totals.revenueToday.toFixed(2)}
                      </div>
                    </div>
                    <div className="an-revenue-mini">
                      <div className="an-revenue-mini-label">{t("analytics.thisWeek")}</div>
                      <div
                        className="an-revenue-mini-value"
                        style={{
                          color: period === "week" ? "#E8500A" : "#F1F5F9",
                        }}
                      >
                        ${totals.revenueWeek.toFixed(2)}
                      </div>
                    </div>
                    <div className="an-revenue-mini">
                      <div className="an-revenue-mini-label">{t("analytics.thisMonth")}</div>
                      <div
                        className="an-revenue-mini-value"
                        style={{
                          color: period === "month" ? "#1D9E75" : "#F1F5F9",
                        }}
                      >
                        ${totals.revenueMonth.toFixed(2)}
                      </div>
                    </div>
                    <div className="an-revenue-mini">
                      <div className="an-revenue-mini-label">{t("analytics.thisYear")}</div>
                      <div
                        className="an-revenue-mini-value"
                        style={{
                          color: period === "year" ? "#E8500A" : "#F1F5F9",
                        }}
                      >
                        ${totals.revenueYear.toFixed(2)}
                      </div>
                    </div>
                  </div>

                  {/* Period KPIs */}
                  <div className="an-kpi-grid">
                    <div className="an-kpi-card">
                      <div className="an-kpi-label">{t("stats.revenue")}</div>
                      <div
                        className="an-kpi-value"
                        style={{ color: "#1D9E75" }}
                      >
                        ${totals.revenue.toFixed(2)}
                      </div>
                      <div className="an-kpi-sub">
                        {periodPhrase}
                      </div>
                    </div>
                    <div className="an-kpi-card">
                      <div className="an-kpi-label">{t("rideStatus.completed")}</div>
                      <div className="an-kpi-value">{totals.rides}</div>
                      <div className="an-kpi-sub">{t("analytics.ridesWord")}</div>
                    </div>
                    <div className="an-kpi-card">
                      <div className="an-kpi-label">{t("csv.avgFare")}</div>
                      <div className="an-kpi-value">
                        ${totals.avgFare.toFixed(2)}
                      </div>
                    </div>
                    <div className="an-kpi-card">
                      <div className="an-kpi-label">{t("csv.cancelRate")}</div>
                      <div
                        className="an-kpi-value"
                        style={{
                          color: totals.cancelRate > 20 ? "#E24B4A" : "#F1F5F9",
                        }}
                      >
                        {totals.cancelRate.toFixed(1)}%
                      </div>
                    </div>
                  </div>

                  {/* Cash vs card split */}
                  <div className="an-chart-card" style={{ marginBottom: 16 }}>
                    <div className="an-chart-title">
                      {t("analytics.cashVsCard")} · {periodPhrase}
                    </div>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 12,
                      }}
                    >
                      <div
                        style={{
                          background: "#18222F",
                          borderRadius: 10,
                          padding: "14px 16px",
                          border: "1px solid rgba(255,255,255,0.04)",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 10,
                            color: "#6B7280",
                            fontWeight: 600,
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                            marginBottom: 6,
                          }}
                        >
                          {t("rideDetail.cash")}
                        </div>
                        <div
                          style={{
                            fontSize: 22,
                            fontWeight: 700,
                            color: "#F59E0B",
                          }}
                        >
                          ${totals.cashRevenue.toFixed(2)}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "#6B7280",
                            marginTop: 4,
                          }}
                        >
                          {t("analytics.ridesCount", { count: totals.cashRides })}
                        </div>
                        {totals.cashRevenue > 0 && (
                          <div
                            style={{
                              fontSize: 11,
                              color: "#F59E0B",
                              marginTop: 6,
                              fontWeight: 600,
                            }}
                          >
                            ⚠ {t("analytics.collectFromDrivers")}
                          </div>
                        )}
                      </div>
                      <div
                        style={{
                          background: "#18222F",
                          borderRadius: 10,
                          padding: "14px 16px",
                          border: "1px solid rgba(255,255,255,0.04)",
                        }}
                      >
                        <div
                          style={{
                            fontSize: 10,
                            color: "#6B7280",
                            fontWeight: 600,
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                            marginBottom: 6,
                          }}
                        >
                          {t("analytics.cardStripe")}
                        </div>
                        <div
                          style={{
                            fontSize: 22,
                            fontWeight: 700,
                            color: "#1D9E75",
                          }}
                        >
                          ${totals.cardRevenue.toFixed(2)}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "#6B7280",
                            marginTop: 4,
                          }}
                        >
                          {t("analytics.ridesCount", { count: totals.cardRides })}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "#1D9E75",
                            marginTop: 6,
                          }}
                        >
                          {t("analytics.viaStripe")}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Revenue chart */}
                  <div className="an-chart-card">
                    <div className="an-chart-title">
                      {t("analytics.revenueOverTime")}{period === "today" ? ` · ${t("analytics.byHour")}` : ""}
                    </div>
                    {(period === "today" ? hourlyData : dailyData).length === 0 ? (
                      <div className="an-no-data">
                        {t("analytics.noCompletedRides")}
                      </div>
                    ) : period === "today" ? (
                      <ResponsiveContainer width="100%" height={200}>
                        <BarChart data={hourlyData} margin={{ top: 4, right: 4, left: 8, bottom: 0 }}>
                          <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.05)" />
                          <XAxis
                            dataKey="label"
                            tick={{ fill: "#6B7280", fontSize: 10 }}
                            axisLine={false}
                            tickLine={false}
                            interval={2}
                          />
                          <YAxis
                            tick={{ fill: "#6B7280", fontSize: 10 }}
                            axisLine={false}
                            tickLine={false}
                            tickFormatter={(v) => `$${v}`}
                            width={40}
                          />
                          <Tooltip content={<RevenueTooltip />} cursor={{ fill: "rgba(232,80,10,0.06)" }} />
                          <Bar dataKey="revenue" fill="#E8500A" radius={[3, 3, 0, 0]} maxBarSize={32} />
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <ResponsiveContainer width="100%" height={200}>
                        <AreaChart data={dailyData} margin={{ top: 4, right: 4, left: 8, bottom: 0 }}>
                          <defs>
                            <linearGradient id="revenueGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#E8500A" stopOpacity={0.22} />
                              <stop offset="100%" stopColor="#E8500A" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.05)" />
                          <XAxis
                            dataKey="day"
                            tick={{ fill: "#6B7280", fontSize: 10 }}
                            axisLine={false}
                            tickLine={false}
                            interval="preserveStartEnd"
                          />
                          <YAxis
                            tick={{ fill: "#6B7280", fontSize: 10 }}
                            axisLine={false}
                            tickLine={false}
                            tickFormatter={(v) => `$${v}`}
                            width={40}
                          />
                          <Tooltip content={<RevenueTooltip />} />
                          <Area
                            type="monotone"
                            dataKey="revenue"
                            stroke="#E8500A"
                            strokeWidth={2}
                            fill="url(#revenueGrad)"
                            dot={{ fill: "#E8500A", strokeWidth: 0, r: 3 }}
                            activeDot={{ r: 5, fill: "#E8500A", stroke: "#1E2A3A", strokeWidth: 2 }}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    )}
                  </div>

                  {/* Driver earnings */}
                  <div className="an-chart-card">
                    <div className="an-chart-title">{t("analytics.driverEarnings")}</div>
                    {driverStats.length === 0 ? (
                      <div className="an-no-data">
                        {t("analytics.noDriverData")}
                      </div>
                    ) : (
                      <table className="an-table">
                        <thead>
                          <tr>
                            {[
                              "csv.driver",
                              "csv.rides",
                              "csv.earnings",
                              "rideDetail.cash",
                              "rideDetail.card",
                              "csv.avgFare",
                              "csv.cancelRate",
                            ].map((h) => (
                              <th key={h} className="an-th">
                                {t(h)}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {driverStats.map((d, i) => (
                            <tr
                              key={i}
                              style={{
                                background:
                                  i % 2 === 0
                                    ? "transparent"
                                    : "rgba(255,255,255,0.015)",
                              }}
                            >
                              <td className="an-td primary">{d.name}</td>
                              <td className="an-td">{d.rides}</td>
                              <td className="an-td green">
                                ${d.earnings.toFixed(2)}
                              </td>
                              <td className="an-td amber">
                                ${d.cashEarnings.toFixed(2)}
                              </td>
                              <td
                                className="an-td"
                                style={{ color: "#1D9E75" }}
                              >
                                ${d.cardEarnings.toFixed(2)}
                              </td>
                              <td className="an-td">${d.avgFare.toFixed(2)}</td>
                              <td
                                className={`an-td${d.cancelRate > 20 ? " red" : ""}`}
                              >
                                {d.cancelRate.toFixed(1)}%
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>

                  {/* Peak activity */}
                  <div className="an-chart-card">
                    <div className="an-chart-title">
                      {t("analytics.peakActivity")}
                    </div>
                    {peakLoading ? (
                      <div className="an-no-data">{t("common.loading")}</div>
                    ) : (
                      <div className="an-peak-row">
                        {/* By hour */}
                        <div className="an-bar-chart-wrap" style={{ flex: 2 }}>
                          <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 4, fontWeight: 500 }}>
                            {t("analytics.byHourOfDay")}
                            {peakHour && peakHour.rides > 0 && (
                              <span style={{ color: "#E8500A", marginLeft: 8 }}>
                                {t("analytics.peakAt", {
                          when: fmtHour(peakHour.hour),
                          rides: t("analytics.ridesCount", { count: peakHour.rides }),
                        })}
                              </span>
                            )}
                          </div>
                          <ResponsiveContainer width="100%" height={130}>
                            <BarChart data={hourStats} margin={{ top: 4, right: 0, left: -28, bottom: 0 }} barCategoryGap="20%">
                              <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.04)" />
                              <XAxis
                                dataKey="label"
                                tick={{ fill: "#6B7280", fontSize: 9 }}
                                axisLine={false}
                                tickLine={false}
                                interval={2}
                              />
                              <YAxis hide />
                              <Tooltip content={<PeakTooltip />} cursor={{ fill: "rgba(232,80,10,0.06)" }} />
                              <Bar dataKey="rides" radius={[3, 3, 0, 0]} maxBarSize={18}>
                                {hourStats.map((h) => (
                                  <Cell
                                    key={h.hour}
                                    fill={peakHour && h.hour === peakHour.hour ? "#E8500A" : "#1E3A5F"}
                                  />
                                ))}
                              </Bar>
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                        {/* By day */}
                        <div className="an-bar-chart-wrap" style={{ flex: 1 }}>
                          <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 4, fontWeight: 500 }}>
                            {t("analytics.byDayOfWeek")}
                            {peakDay && peakDay.rides > 0 && (
                              <span style={{ color: "#E8500A", marginLeft: 8 }}>
                                {t("analytics.busiestOn", {
                          when: peakDay.day,
                          rides: t("analytics.ridesCount", { count: peakDay.rides }),
                        })}
                              </span>
                            )}
                          </div>
                          <ResponsiveContainer width="100%" height={130}>
                            <BarChart data={dayStats} margin={{ top: 4, right: 0, left: -28, bottom: 0 }} barCategoryGap="25%">
                              <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.04)" />
                              <XAxis
                                dataKey="day"
                                tick={{ fill: "#6B7280", fontSize: 10 }}
                                axisLine={false}
                                tickLine={false}
                              />
                              <YAxis hide />
                              <Tooltip content={<PeakTooltip />} cursor={{ fill: "rgba(232,80,10,0.06)" }} />
                              <Bar dataKey="rides" radius={[3, 3, 0, 0]} maxBarSize={28}>
                                {dayStats.map((d) => (
                                  <Cell
                                    key={d.day}
                                    fill={peakDay && d.day === peakDay.day ? "#E8500A" : "#1E3A5F"}
                                  />
                                ))}
                              </Bar>
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          {/* ── RIDE HISTORY ── */}
          {section === "rides" && (
            <>
              <div className="an-section-header">
                <div className="an-section-title">{t("analytics.sections.rides")}</div>
                <div className="an-controls">
                  {availableYears.length > 0 && (
                    <select
                      className="an-select"
                      value={selectedYear}
                      onChange={(e) => setSelectedYear(Number(e.target.value))}
                    >
                      {availableYears.map((y) => (
                        <option key={y} value={y}>{y}</option>
                      ))}
                    </select>
                  )}
                  <button
                    className="an-download-btn"
                    onClick={() =>
                      downloadYearReport(selectedYear, monthGroups)
                    }
                  >
                    {t("analytics.pdf")} {selectedYear}
                  </button>
                  <button
                    className="an-csv-btn"
                    onClick={() =>
                      exportRidesCSV(
                        filteredRides.filter(
                          (r) =>
                            new Date(r.created_at).getFullYear() ===
                            selectedYear,
                        ),
                        // i18n-ok — a filename.
      `rides-${selectedYear}.csv`,
                      )
                    }
                  >
                    {t("analytics.csv")}
                  </button>
                </div>
              </div>
              {ridesLoading ? (
                <div className="an-loading">{t("common.loading")}</div>
              ) : (
                <>
                  <div className="an-filter-row">
                    {["all", "completed", "cancelled"].map((s) => (
                      <button
                        key={s}
                        className={`an-filter-btn${rideFilter === s ? " active" : ""}`}
                        onClick={() => setRideFilter(s)}
                      >
                        {s === "all" ? t("analytics.filterAll") : rideStatusLabel(s)}
                      </button>
                    ))}
                    <span className="an-filter-count">
                      {t("analytics.ridesCount", { count: filteredRides.length })}
                    </span>
                  </div>
                  <div className="inv-search-row">
                    <input
                      className="inv-search"
                      placeholder={t("analytics.ridesSearchPlaceholder")}
                      value={rideSearch}
                      onChange={(e) => setRideSearch(e.target.value)}
                    />
                  </div>
                  {monthGroups.length === 0 ? (
                    <div className="an-no-data" style={{ padding: "48px 0" }}>
                      {rideSearch ? t("analytics.noRidesMatch") : t("analytics.noRidesFound")}
                    </div>
                  ) : (
                    monthGroups.map((group) => {
                      const isOpen =
                        expandedMonths.has(group.key) || rideSearch.trim() !== "";
                      return (
                        <div key={group.key} className="an-month-group">
                          <div
                            className="an-month-header"
                            onClick={() => toggleMonth(group.key)}
                          >
                            <div className="an-month-header-left">
                              <span
                                className={`an-month-chevron${isOpen ? " open" : ""}`}
                              >
                                ▶
                              </span>
                              <span className="an-month-name">
                                {group.label}
                              </span>
                              <span className="an-month-meta">
                                {t("analytics.ridesCount", { count: group.rides.length })}
                                {group.rides.length !== 1 ? "s" : ""}
                              </span>
                            </div>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 12,
                              }}
                            >
                              <span className="an-month-revenue">
                                ${group.totalRevenue.toFixed(2)}
                              </span>
                              <button
                                className="an-download-btn-sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  downloadMonthReport(group);
                                }}
                              >
                                {t("analytics.pdf")}
                              </button>
                              <button
                                className="an-csv-btn"
                                style={{
                                  fontSize: 11,
                                  padding: "4px 10px",
                                  borderRadius: 6,
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  exportRidesCSV(
                                    group.rides,
                                    // i18n-ok — a filename.
      `rides-${group.key}.csv`,
                                  );
                                }}
                              >
                                {t("analytics.csv")}
                              </button>
                            </div>
                          </div>
                          {isOpen && (
                            <div className="an-month-body">
                              <table className="an-table">
                                <thead>
                                  <tr>
                                    {([
                                      "date",
                                      "ride",
                                      "passenger",
                                      "driver",
                                      "pickup",
                                      "dropoff",
                                      "fare",
                                      "status",
                                      "payment",
                                      "receipt",
                                    ] as const).map((h) => (
                                      <th
                                        key={h}
                                        className="an-th"
                                        style={{ padding: "10px 14px" }}
                                      >
                                        {t(`analytics.col.${h}`)}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {group.rides.map((r, i) => (
                                    <tr
                                      key={r.id}
                                      className="an-ride-row"
                                      style={{
                                        background:
                                          i % 2 === 0
                                            ? "transparent"
                                            : "rgba(255,255,255,0.015)",
                                      }}
                                      onClick={() => openRideDetail(r)}
                                    >
                                      <td
                                        className="an-td"
                                        style={{ whiteSpace: "nowrap" }}
                                      >
                                        {fmtDate(r.created_at, {
                                          month: "short",
                                          day: "numeric",
                                        })}
                                      </td>
                                      <td
                                        className="an-td"
                                        style={{
                                          fontFamily: "ui-monospace, monospace",
                                          fontSize: 11,
                                          letterSpacing: "0.06em",
                                          whiteSpace: "nowrap",
                                        }}
                                      >
                                        {formatRideRef(r.ride_ref)}
                                      </td>
                                      <td className="an-td primary">
                                        {r.passenger_name}
                                      </td>
                                      <td className="an-td">{r.driver_name}</td>
                                      <td className="an-td addr">
                                        {r.pickup_address}
                                      </td>
                                      <td className="an-td addr">
                                        {r.dropoff_address}
                                      </td>
                                      <td
                                        className="an-td"
                                        style={{
                                          fontWeight: 600,
                                          color: "#9CA3AF",
                                        }}
                                      >
                                        {r.fare_final
                                          ? `$${r.fare_final.toFixed(2)}`
                                          : r.fare_estimate
                                            ? `$${r.fare_estimate.toFixed(2)}`
                                            : "—"}
                                      </td>
                                      <td className="an-td">
                                        <span
                                          className="an-status"
                                          style={{
                                            background:
                                              STATUS_COLORS[r.status] + "18",
                                            color: STATUS_COLORS[r.status],
                                            border: `1px solid ${STATUS_COLORS[r.status]}30`,
                                          }}
                                        >
                                          {rideStatusLabel(r.status)}
                                        </span>
                                      </td>
                                      <td
                                        className="an-td"
                                        style={{ textTransform: "capitalize" }}
                                      >
                                        {r.payment_method}
                                      </td>
                                      <td className="an-td">
                                        {r.receipt_number ? (
                                          <span className="receipt-tag">{r.receipt_number}</span>
                                        ) : (
                                          <span style={{ color: "#6B7280" }}>—</span>
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </>
              )}
            </>
          )}

          {/* ── SETTLEMENTS ── */}
          {/* Two deliberately separate scopes on this tab, in priority order:
              (1) Needs attention -- all-time, unresolved-only, the actual todo
                  list, so a stranded ride from three months ago can't hide
                  behind a period selector; and (2) the period rollup +
                  drilldown -- every completed card ride bucketed by where its
                  money went, resolved ones included. Numbers never cross
                  between the two blocks: anything outstanding is counted off
                  needsAttention, anything historical off the rollup RPC. */}
          {section === "settlements" && (
            <>
              {/* ═══ 1. Period rollup — hero + charts (leads the tab) ═══ */}
              <div className="an-section-header">
                <div className="an-section-title">
                  {isCompanySettles ? t("settle.cardSettlementTitle") : t("settle.whereCardWent")}
                </div>
                <div className="an-controls">
                  {/* Net | Gross display lens. Net (default) = what actually
                      reached accounts after fees; gross = what passengers paid.
                      Both come from one RPC call, so this is instant. Hidden for
                      company_settles — its fee view shows the full gross→net
                      decomposition at once, so a basis toggle is meaningless. */}
                  {!isCompanySettles && (
                    <div className="an-period-btns" title={t("settle.basisHelp")}>
                      {(["net", "gross"] as const).map((b) => (
                        <button
                          key={b}
                          className={`an-period-btn${settlementBasis === b ? " active" : ""}`}
                          onClick={() => setSettlementBasis(b)}
                        >
                          {b === "net" ? t("settle.net") : t("settle.gross")}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="an-period-btns">
                    {(["today", "week", "month", "year"] as const).map((p) => (
                      <button
                        key={p}
                        className={`an-period-btn${period === p ? " active" : ""}`}
                        onClick={() => setPeriod(p)}
                      >
                        {t(`analytics.period.${p}`)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="an-scope-note" style={{ marginTop: -12, marginBottom: 16 }}>
                {isCompanySettles
                  ? t("settle.cardSettledSub")
                  : settlementBasis === "net"
                    ? t("settle.netSub")
                    : t("settle.grossSub")}
              </div>

              {isCompanySettles ? (
                /* ── company_settles: fee-breakdown view ── */
                feeBreakdownLoading ? (
                  <div className="an-loading">{t("common.loading")}</div>
                ) : !feeBreakdown || feeBreakdown.paid_rides === 0 ? (
                  <div className="an-no-data">{t("settle.noSettledCard")}</div>
                ) : (
                  <>
                    {/* Hero: gross fares decomposed. Net = what landed; the two
                        fees are what was withheld. gross = net + vellon + stripe. */}
                    <div className="an-set-hero">
                      <div className="an-hero-card lead paid-company">
                        <div className="an-hero-label">
                          <span className="an-dot" style={{ background: "#4a9eff" }} />
                          {t("settle.netToYourAccount")}
                        </div>
                        <div className="an-hero-value">${feeBreakdown.net_total.toFixed(2)}</div>
                        <div className="an-hero-sub">
                          {t("analytics.ridesCount", { count: feeBreakdown.paid_rides })} · {t("settle.settledToStripe")}
                        </div>
                      </div>

                      <div className="an-hero-card">
                        <div className="an-hero-label">{t("settle.grossCardFares")}</div>
                        <div className="an-hero-value">${feeBreakdown.gross_fares.toFixed(2)}</div>
                        <div className="an-hero-sub">{t("settle.whatPassengersPaid")}</div>
                      </div>

                      <div className="an-hero-card">
                        <div className="an-hero-label">
                          <span className="an-dot" style={{ background: "#E8500A" }} />
                          {t("rideDetail.vellonFee")}
                        </div>
                        <div className="an-hero-value" style={{ color: "#f0782f" }}>
                          ${feeBreakdown.vellon_fee.toFixed(2)}
                        </div>
                        <div className="an-hero-sub">
                          {feeBreakdown.gross_fares > 0
                            ? t("settle.pctOfFares", {
                                pct: ((feeBreakdown.vellon_fee / feeBreakdown.gross_fares) * 100).toFixed(1),
                              })
                            : t("settle.platformFee")}
                        </div>
                      </div>

                      <div className="an-hero-card">
                        <div className="an-hero-label">
                          <span className="an-dot" style={{ background: "#8B93A7" }} />
                          {t("settle.stripeFee")}
                        </div>
                        <div className="an-hero-value" style={{ color: "#aab2c4" }}>
                          ${feeBreakdown.stripe_fee.toFixed(2)}
                        </div>
                        <div className="an-hero-sub">{t("settle.cardProcessing")}</div>
                      </div>
                    </div>

                    {/* Two-up: fee-composition donut + daily net-settled flow */}
                    <div className="an-two-up">
                      <div className="an-chart-card">
                        <div className="an-chart-title">{t("settle.whereEachDollar")}</div>
                        {(() => {
                          const center = feeHot
                            ? feeDonut.segs.find((s) => s.key === feeHot)
                            : feeDonut.top;
                          return (
                            <div className="an-donut-wrap">
                              <svg width="118" height="118" viewBox="0 0 118 118" style={{ flex: "none" }}>
                                <g transform="rotate(-90 59 59)">
                                  <circle cx="59" cy="59" r="46" fill="none" stroke="#243244" strokeWidth="15" />
                                  {feeDonut.segs.map((s) => {
                                    const hot = feeHot === s.key;
                                    const dimmed = feeHot != null && !hot;
                                    return (
                                      <circle
                                        key={s.key}
                                        className="an-donut-seg"
                                        cx="59"
                                        cy="59"
                                        r="46"
                                        fill="none"
                                        stroke={s.color}
                                        strokeWidth={hot ? 18 : 15}
                                        strokeDasharray={
                                          settleChartsReady
                                            ? `${s.len.toFixed(2)} ${feeDonut.C.toFixed(2)}`
                                            : `0 ${feeDonut.C.toFixed(2)}`
                                        }
                                        strokeDashoffset={s.offset.toFixed(2)}
                                        opacity={dimmed ? 0.28 : 1}
                                        onMouseEnter={() => setFeeHot(s.key)}
                                        onMouseLeave={() => setFeeHot(null)}
                                      />
                                    );
                                  })}
                                </g>
                                {center && (
                                  <>
                                    <text x="59" y="55" textAnchor="middle" fill={feeHot ? center.color : "#F1F5F9"} fontSize="19" fontWeight="700">
                                      {center.pct.toFixed(1)}%
                                    </text>
                                    <text x="59" y="71" textAnchor="middle" fill="#6B7280" fontSize="9.5" style={{ letterSpacing: "0.04em" }}>
                                      {center.name.toUpperCase()}
                                    </text>
                                  </>
                                )}
                              </svg>
                              <div className="an-donut-legend">
                                {feeDonut.segs.map((s) => (
                                  <div
                                    className={`an-leg${feeHot === s.key ? " hot" : ""}`}
                                    key={s.key}
                                    onMouseEnter={() => setFeeHot(s.key)}
                                    onMouseLeave={() => setFeeHot(null)}
                                  >
                                    <span className="an-dot" style={{ background: s.color }} />
                                    <span className="an-leg-name">{s.name}</span>
                                    <span className="an-leg-amt">${s.amt.toFixed(2)}</span>
                                    <span className="an-leg-pct">{s.pct.toFixed(1)}%</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })()}
                      </div>

                      <div className="an-chart-card">
                        <div className="an-chart-title">{t("settle.dailyNetTitle")}</div>
                        {settlementDailyChart.buckets.length === 0 ? (
                          <div className="an-no-data" style={{ padding: "40px 0" }}>
                            {t("settle.noSettledToChart")}
                          </div>
                        ) : (
                          (() => {
                            const plotH = 146;
                            const nm = settlementDailyChart.niceMaxNet;
                            const n = settlementDailyChart.buckets.length;
                            const labelEvery = Math.ceil(n / 12);
                            return (
                              <div className="an-bars-plot">
                                {[0, 0.5, 1].flatMap((f) => {
                                  const top = (1 - f) * plotH;
                                  return [
                                    <div key={`g${f}`} className={`an-grid-line${f === 0 ? " base" : ""}`} style={{ top }} />,
                                    <div key={`y${f}`} className="an-ylab" style={{ top }}>
                                      ${(nm * f).toFixed(0)}
                                    </div>,
                                  ];
                                })}
                                <div className="an-bars-row">
                                  {settlementDailyChart.buckets.map((b, i) => {
                                    const h = (b.paid / nm) * plotH;
                                    return (
                                      <div className="an-bar-col" key={b.key}>
                                        <div className="an-bar-stack">
                                          <div
                                            className="an-bar-seg"
                                            style={{ height: settleChartsReady ? h : 0, background: "#4a9eff", borderRadius: "3px 3px 0 0" }}
                                          />
                                        </div>
                                        {i % labelEvery === 0 && <div className="an-bar-lab">{b.label}</div>}
                                        <div className="an-bar-tip" style={{ bottom: h + 8 }}>
                                          <div className="an-tip-day">{b.label}</div>
                                          <div className="an-tip-row tot">
                                            <span className="k">{t("rideDetail.netSettled")}</span>
                                            <span className="v">${b.paid.toFixed(2)}</span>
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })()
                        )}
                      </div>
                    </div>
                  </>
                )
              ) : settlementRollupLoading ? (
                <div className="an-loading">{t("common.loading")}</div>
              ) : settlementRollup.length === 0 ? (
                <div className="an-no-data">{t("settle.noCompletedCard")}</div>
              ) : (
                <>
                  {/* Hero tiles — all one basis, so nothing needs reconciling. */}
                  <div className="an-set-hero">
                    <div className={`an-hero-card lead${leadAccent.cls}`}>
                      <div className="an-hero-label">
                        <span className="an-dot" style={{ background: leadAccent.main }} />
                        {leadPaidLabel}
                      </div>
                      <div className="an-hero-value">${settlementTotals.settled.toFixed(2)}</div>
                      <div className="an-hero-sub">
                        {t("analytics.ridesCount", { count: settlementTotals.settledRides })}
                        {settlementTotals.settledRides === 1 ? "" : "s"} · {leadPaidSub}
                      </div>
                      {settlementDailyChart.buckets.length > 1 &&
                        (() => {
                          const pts = settlementDailyChart.buckets.map((b) => b.paid);
                          const mx = Math.max(1, ...pts);
                          const W = 260, H = 40, PAD = 4;
                          const step = W / (pts.length - 1);
                          const xy = pts.map(
                            (v, i) => [i * step, H - PAD - (v / mx) * (H - PAD * 2)] as const,
                          );
                          const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
                          const area = `${line} L${W},${H} L0,${H} Z`;
                          const [ex, ey] = xy[xy.length - 1];
                          return (
                            <div style={{ marginTop: 12 }}>
                              <svg width="100%" height="40" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
                                <defs>
                                  <linearGradient id="an-spark-grad" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0" stopColor={leadAccent.main} stopOpacity="0.42" />
                                    <stop offset="1" stopColor={leadAccent.main} stopOpacity="0" />
                                  </linearGradient>
                                </defs>
                                <path d={area} fill="url(#an-spark-grad)" opacity={settleChartsReady ? 1 : 0} style={{ transition: "opacity 0.5s ease" }} />
                                <path
                                  d={line}
                                  fill="none"
                                  stroke={leadAccent.main}
                                  strokeWidth="2"
                                  strokeLinejoin="round"
                                  strokeLinecap="round"
                                  vectorEffect="non-scaling-stroke"
                                  pathLength={100}
                                  strokeDasharray={100}
                                  strokeDashoffset={settleChartsReady ? 0 : 100}
                                  style={{ transition: "stroke-dashoffset 0.9s cubic-bezier(.4,0,.2,1)" }}
                                />
                                <circle className="an-spark-dot" cx={ex} cy={ey} r="3" fill={leadAccent.bright} opacity={settleChartsReady ? 1 : 0} />
                              </svg>
                            </div>
                          );
                        })()}
                    </div>

                    <div className="an-hero-card">
                      <div className="an-hero-label">
                        {settlementBasis === "net" ? t("settle.netTotal") : t("settle.cardFares")}
                      </div>
                      <div className="an-hero-value">${settlementTotals.grand.toFixed(2)}</div>
                      <div className="an-hero-sub">
                        {t("analytics.ridesCount", { count: settlementTotals.rides })}{" "}
                        {periodPhrase}
                      </div>
                    </div>

                    <div className="an-hero-card">
                      <div className="an-hero-label">{t("settlementShort.platformInvoiced")}</div>
                      <div
                        className="an-hero-value"
                        style={{ color: settlementTotals.held > 0 ? "#F59E0B" : "#F1F5F9" }}
                      >
                        ${settlementTotals.held.toFixed(2)}
                      </div>
                      <div className="an-hero-sub">
                        {t("settle.pendingInvoiceCount", { count: settlementTotals.heldRides })}
                      </div>
                    </div>

                    <div className="an-hero-card">
                      <div className="an-hero-label">{t("settle.failedOrReversed")}</div>
                      <div
                        className="an-hero-value"
                        style={{ color: settlementTotals.problem > 0 ? "#E24B4A" : "#F1F5F9" }}
                      >
                        ${settlementTotals.problem.toFixed(2)}
                      </div>
                      <div className="an-hero-sub">
                        {t("analytics.ridesCount", { count: settlementTotals.problemRides })} {t("settle.thisPeriod")}
                      </div>
                    </div>
                  </div>

                  {/* Two-up: donut composition + daily settlement flow */}
                  <div className="an-two-up">
                    <div className="an-chart-card">
                      <div className="an-chart-title">{t("settle.compositionByRoute")}</div>
                      {(() => {
                        // Center follows the hovered slice, else the biggest.
                        const center = settleHotRoute
                          ? settlementDonut.segs.find((s) => s.route === settleHotRoute)
                          : settlementDonut.top;
                        return (
                          <div className="an-donut-wrap">
                            <svg width="118" height="118" viewBox="0 0 118 118" style={{ flex: "none" }}>
                              <g transform="rotate(-90 59 59)">
                                <circle cx="59" cy="59" r="46" fill="none" stroke="#243244" strokeWidth="15" />
                                {settlementDonut.segs.map((s) => {
                                  const hot = settleHotRoute === s.route;
                                  const dimmed = settleHotRoute != null && !hot;
                                  return (
                                    <circle
                                      key={s.route}
                                      className="an-donut-seg"
                                      cx="59"
                                      cy="59"
                                      r="46"
                                      fill="none"
                                      stroke={s.color}
                                      strokeWidth={hot ? 18 : 15}
                                      strokeDasharray={
                                        settleChartsReady
                                          ? `${s.len.toFixed(2)} ${settlementDonut.C.toFixed(2)}`
                                          : `0 ${settlementDonut.C.toFixed(2)}`
                                      }
                                      strokeDashoffset={s.offset.toFixed(2)}
                                      opacity={dimmed ? 0.28 : 1}
                                      onMouseEnter={() => setSettleHotRoute(s.route)}
                                      onMouseLeave={() => setSettleHotRoute(null)}
                                    />
                                  );
                                })}
                              </g>
                              {center && (
                                <>
                                  <text x="59" y="55" textAnchor="middle" fill={settleHotRoute ? center.color : "#F1F5F9"} fontSize="19" fontWeight="700">
                                    {center.pct.toFixed(1)}%
                                  </text>
                                  <text x="59" y="71" textAnchor="middle" fill="#6B7280" fontSize="9.5" style={{ letterSpacing: "0.04em" }}>
                                    {settlementShort(center.route).toUpperCase()}
                                  </text>
                                </>
                              )}
                            </svg>
                            <div className="an-donut-legend">
                              {settlementDonut.segs.map((s) => (
                                <div
                                  className={`an-leg${settleHotRoute === s.route ? " hot" : ""}`}
                                  key={s.route}
                                  onMouseEnter={() => setSettleHotRoute(s.route)}
                                  onMouseLeave={() => setSettleHotRoute(null)}
                                >
                                  <span className="an-dot" style={{ background: s.color }} />
                                  <span className="an-leg-name">
                                    {settlementShort(s.route)}
                                  </span>
                                  <span className="an-leg-amt">${s.amt.toFixed(2)}</span>
                                  <span className="an-leg-pct">{s.pct.toFixed(1)}%</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })()}
                    </div>

                    <div className="an-chart-card">
                      <div className="an-chart-title">{t("settle.dailyFlow")}</div>
                      {settlementDailyChart.buckets.length === 0 ? (
                        <div className="an-no-data" style={{ padding: "40px 0" }}>
                          {t("settle.noSettledToChart")}
                        </div>
                      ) : (
                        (() => {
                          const plotH = 146; // 168px plot − 22px label strip
                          const nm = settlementDailyChart.niceMax;
                          const n = settlementDailyChart.buckets.length;
                          const labelEvery = Math.ceil(n / 12);
                          return (
                            <>
                              <div className="an-bars-plot">
                                {[0, 0.5, 1].flatMap((f) => {
                                  const top = (1 - f) * plotH;
                                  return [
                                    <div
                                      key={`g${f}`}
                                      className={`an-grid-line${f === 0 ? " base" : ""}`}
                                      style={{ top }}
                                    />,
                                    <div key={`y${f}`} className="an-ylab" style={{ top }}>
                                      ${(nm * f).toFixed(0)}
                                    </div>,
                                  ];
                                })}
                                <div className="an-bars-row">
                                  {settlementDailyChart.buckets.map((b, i) => {
                                    const paidH = (b.paid / nm) * plotH;
                                    const heldH = (b.held / nm) * plotH;
                                    return (
                                      <div className="an-bar-col" key={b.key}>
                                        <div className="an-bar-stack">
                                          <div
                                            className="an-bar-seg an-bar-held"
                                            style={{ height: settleChartsReady && b.held > 0 ? heldH : 0 }}
                                          />
                                          <div
                                            className="an-bar-seg an-bar-paid"
                                            style={{ height: settleChartsReady ? paidH : 0 }}
                                          />
                                        </div>
                                        {i % labelEvery === 0 && (
                                          <div className="an-bar-lab">{b.label}</div>
                                        )}
                                        <div
                                          className="an-bar-tip"
                                          style={{ bottom: paidH + heldH + 8 }}
                                        >
                                          <div className="an-tip-day">{b.label}</div>
                                          <div className="an-tip-row">
                                            <span className="k">
                                              <span className="an-dot" style={{ background: "#1D9E75" }} />
                                              {t("settle.paid")}
                                            </span>
                                            <span className="v">${b.paid.toFixed(2)}</span>
                                          </div>
                                          <div className="an-tip-row">
                                            <span className="k">
                                              <span className="an-dot" style={{ background: "#F59E0B" }} />
                                              {t("settle.held")}
                                            </span>
                                            <span className="v">${b.held.toFixed(2)}</span>
                                          </div>
                                          <div className="an-tip-row tot">
                                            <span className="k">{t("reports.total")}</span>
                                            <span className="v">${(b.paid + b.held).toFixed(2)}</span>
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                              <div className="an-trend-legend">
                                <span className="an-tl"><span className="an-tl-swatch" style={{ background: "#1D9E75" }} /> {t("settle.paidToDrivers")}</span>
                                <span className="an-tl"><span className="an-tl-swatch" style={{ background: "#F59E0B" }} /> {t("settlementShort.platformInvoiced")}</span>
                              </div>
                            </>
                          );
                        })()
                      )}
                    </div>
                  </div>

                  {/* Route detail table — same basis as everything above. */}
                  <div className="an-chart-card">
                    <table className="an-table">
                      <thead>
                        <tr>
                          {([
                            "route",
                            "rides",
                            settlementBasis === "net" ? "net" : "fares",
                            "share",
                          ] as const).map((h, i) => (
                            <th key={h} className="an-th" style={{ textAlign: i === 0 ? "left" : "right" }}>
                              {t(`analytics.col.${h}`)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {settlementRollupSorted.map((row) => {
                          const isProblem = (
                            SETTLEMENT_ACTIONABLE_ROUTES as readonly string[]
                          ).includes(row.settlement_route);
                          const color = settlementColor(row.settlement_route);
                          const amt = settlementAmt(row);
                          const pct =
                            settlementTotals.grand > 0
                              ? (amt / settlementTotals.grand) * 100
                              : 0;
                          const active = settlementRouteFilter === row.settlement_route;
                          return (
                            <tr
                              key={row.settlement_route}
                              className="an-settle-row"
                              onClick={() =>
                                setSettlementRouteFilter(active ? "all" : row.settlement_route)
                              }
                              style={{
                                background: active ? "rgba(255,255,255,0.05)" : "transparent",
                              }}
                              title={
                                active
                                  ? t("settle.clickToClear")
                                  : t("settle.clickToFilter")
                              }
                            >
                              <td className="an-td primary">
                                <span style={{ display: "flex", alignItems: "center" }}>
                                  <span className="an-dot" style={{ background: color }} />
                                  <span style={isProblem ? { color } : {}}>
                                    {settlementShort(row.settlement_route)}
                                  </span>
                                </span>
                              </td>
                              <td className="an-td" style={{ textAlign: "right" }}>
                                {row.rides_count}
                              </td>
                              <td
                                className="an-td"
                                style={{ textAlign: "right", color: "#E2E8F0", fontWeight: 600 }}
                              >
                                ${amt.toFixed(2)}
                              </td>
                              <td className="an-td" style={{ textAlign: "right" }}>
                                {pct.toFixed(0)}%
                                <div className="an-share-track" style={{ marginLeft: "auto" }}>
                                  <div className="an-share-fill" style={{ width: `${pct}%`, background: color }} />
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                        <tr>
                          <td className="an-td primary" style={{ fontWeight: 700, borderBottom: "none" }}>
                            {t("reports.total")}
                          </td>
                          <td className="an-td" style={{ textAlign: "right", fontWeight: 700, borderBottom: "none" }}>
                            {settlementTotals.rides}
                          </td>
                          <td
                            className="an-td"
                            style={{ textAlign: "right", fontWeight: 700, color: "#F1F5F9", borderBottom: "none" }}
                          >
                            ${settlementTotals.grand.toFixed(2)}
                          </td>
                          <td className="an-td" style={{ borderBottom: "none" }} />
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {/* ═══ 1b. Cash lane ═══
                  Cash never touches Stripe -- the driver collects the fare at the
                  door -- so it has no settlement routes to show. The only money
                  Vellon touches is its fee, which accrues here and is billed to
                  the company monthly (same rate as card). Honors the Net | Gross
                  toggle. Renders for both payout models; the driver-owns vs
                  company-owns framing (labels + lead accent) is set above. */}
              {(payoutModel === "driver_direct" || isCompanySettles) && (
                <>
                  <div className="an-section-header" style={{ marginTop: 32 }}>
                    <div className="an-section-title">{t("settle.cashFares")}</div>
                  </div>
                  <div className="an-scope-note" style={{ marginTop: -12, marginBottom: 16 }}>
                    {cashScopeNote}
                  </div>
                  {cashSettlementLoading ? (
                    <div className="an-loading">{t("common.loading")}</div>
                  ) : !cashSettlement || cashSettlement.cash_rides === 0 ? (
                    <div className="an-no-data">{t("settle.noCompletedCash")}</div>
                  ) : (
                    <div className="an-set-hero" style={{ gridTemplateColumns: "1.5fr 1fr 1fr" }}>
                      <div className={`an-hero-card lead${leadAccent.cls}`}>
                        <div className="an-hero-label">
                          {settlementBasis === "net" ? cashLeadNetLabel : cashLeadGrossLabel}
                        </div>
                        <div className="an-hero-value">
                          $
                          {(settlementBasis === "net"
                            ? cashSettlement.cash_fares - cashSettlement.cash_fee_owed
                            : cashSettlement.cash_fares
                          ).toFixed(2)}
                        </div>
                        <div className="an-hero-sub">
                          {t("analytics.ridesCount", { count: cashSettlement.cash_rides })}
                          {cashSettlement.cash_rides === 1 ? "" : "s"}
                          {settlementBasis === "net" ? ` · ${t("settle.afterVellonFee")}` : ` · ${cashGrossTail}`}
                        </div>
                      </div>

                      {/* Complement of the lead tile, so net and gross each show
                          three distinct numbers (fares = net + fee). */}
                      <div className="an-hero-card">
                        <div className="an-hero-label">
                          {settlementBasis === "net" ? cashGrossShort : cashLeadNetLabel}
                        </div>
                        <div className="an-hero-value">
                          $
                          {(settlementBasis === "net"
                            ? cashSettlement.cash_fares
                            : cashSettlement.cash_fares - cashSettlement.cash_fee_owed
                          ).toFixed(2)}
                        </div>
                        <div className="an-hero-sub">
                          {settlementBasis === "net"
                            ? `${t("analytics.ridesCount", { count: cashSettlement.cash_rides })} ${periodPhrase}`
                            : t("settle.afterVellonFee")}
                        </div>
                      </div>

                      <div className="an-hero-card">
                        <div className="an-hero-label">{t("settle.feeAccruing")}</div>
                        <div className="an-hero-value" style={{ color: "#F59E0B" }}>
                          ${cashSettlement.cash_fee_owed.toFixed(2)}
                        </div>
                        <div className="an-hero-sub">
                          {periodPhrase} · {t("settle.invoicedMonthly")}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* ═══ 2. Needs attention (all-time, unresolved) ═══ */}
              <div className="an-section-header" style={{ marginTop: 32 }}>
                <div
                  className="an-section-title"
                  style={{ display: "flex", alignItems: "center", gap: 8 }}
                >
                  {t("attention.title")}
                  {needsAttention.length > 0 && (
                    <span className="an-attn-badge">{needsAttention.length}</span>
                  )}
                </div>
                <div className="an-controls">
                  <span className="an-scope-note">{t("settle.allTimeUnresolved")}</span>
                </div>
              </div>

              {needsAttentionLoading ? (
                <div className="an-loading">{t("common.loading")}</div>
              ) : needsAttention.length === 0 ? (
                <div className="an-settle-clear">
                  <span style={{ color: "#1D9E75", fontSize: 16 }}>✓</span>
                  {t("settle.allClean")}
                </div>
              ) : (
                <>
                  {/* Split by direction of money on purpose -- a combined
                      "$ outstanding" would net a receivable against a payable. */}
                  <div className="an-attn-split">
                    <div className="an-attn-tile" style={{ borderLeft: "3px solid #F59E0B" }}>
                      <div className="an-attn-tile-label" style={{ color: "#F59E0B" }}>
                        {t("settle.toCollect")}
                      </div>
                      <div className="an-attn-tile-value">
                        ${attentionSplit.collect.amount.toFixed(2)}
                      </div>
                      <div className="an-attn-tile-sub">
                        {t("analytics.ridesCount", { count: attentionSplit.collect.count })} · {t("settle.needsCollection")}
                      </div>
                    </div>
                    <div className="an-attn-tile" style={{ borderLeft: "3px solid #E24B4A" }}>
                      <div className="an-attn-tile-label" style={{ color: "#E24B4A" }}>
                        {t("settle.toPayOut")}
                      </div>
                      <div className="an-attn-tile-value">
                        ${attentionSplit.payout.amount.toFixed(2)}
                      </div>
                      <div className="an-attn-tile-sub">
                        {t("analytics.ridesCount", { count: attentionSplit.payout.count })} · {t("settle.netOwedToDriver")}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {needsAttention.map((row) => {
                      const dir = SETTLEMENT_DIRECTION[row.settlement_route];
                      const dirColor = dir === "collect" ? "#F59E0B" : "#E24B4A";
                      const when = new Date(row.completed_at ?? row.created_at);
                      const days = Math.floor(
                        (Date.now() - when.getTime()) / 86_400_000,
                      );
                      // Match the tile: show the net owed for driver payouts /
                      // clawbacks, gross only for platform_invoiced.
                      const shownAmt = settlementOwedAmount(row);
                      return (
                        <div
                          key={row.id}
                          className="an-attn-card"
                          style={{ borderLeftColor: dirColor }}
                        >
                          <div>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                flexWrap: "wrap",
                              }}
                            >
                              <span style={{ fontSize: 13, fontWeight: 700, color: "#F1F5F9" }}>
                                {settlementShort(row.settlement_route)}
                              </span>
                              <span
                                className="an-pill"
                                style={{ color: dirColor, background: `${dirColor}1F` }}
                              >
                                {dir === "collect" ? t("settle.collect") : t("settle.payOut")}
                              </span>
                              {days >= 1 && (
                                <span style={{ fontSize: 11, color: "#6B7280" }}>
                                  {t("settle.waitingDays", { count: days })}
                                </span>
                              )}
                            </div>
                            <div className="an-attn-meta">
                              <strong style={{ color: "#E2E8F0", fontWeight: 600 }}>
                                ${shownAmt?.toFixed(2) ?? "—"}
                              </strong>{" "}
                              · {row.driver_name} · {fmtDate(when)}
                              {row.stripe_dispute_id && ` · ${t("settle.disputeRef", { id: row.stripe_dispute_id })}`}
                            </div>
                            <div className="an-attn-hint">
                              {row.settlement_route && SETTLEMENT_ACTION_HINT_KEYS[row.settlement_route]
                                ? t(SETTLEMENT_ACTION_HINT_KEYS[row.settlement_route])
                                : ""}
                            </div>
                            <div className="an-attn-id">{t("settle.rideId", { id: row.id })}</div>
                          </div>
                          <button
                            className="an-download-btn"
                            disabled={resolvingRideId === row.id}
                            onClick={() => resolveSettlement(row)}
                          >
                            {resolvingRideId === row.id ? t("settle.marking") : t("reports.markResolvedCheck")}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {/* ═══ 3. Per-ride drilldown ═══ */}
              <div className="an-section-header" style={{ marginTop: 32 }}>
                <div className="an-section-title">{t("analytics.ridesIn", { period: periodPhrase })}</div>
                <div className="an-controls">
                  <div className="an-period-btns">
                    {(["all", "open", "resolved"] as const).map((id) => (
                      <button
                        key={id}
                        className={`an-period-btn${settlementStateFilter === id ? " active" : ""}`}
                        onClick={() => setSettlementStateFilter(id)}
                      >
                        {t(`analytics.settlementState.${id}`)}
                      </button>
                    ))}
                  </div>
                  <button
                    className="an-csv-btn"
                    disabled={filteredSettlementRides.length === 0}
                    onClick={exportSettlementsCSV}
                  >
                      {t("analytics.csv")}
                  </button>
                </div>
              </div>

              {/* Route chips mirror the rollup rows, but carry the "All" reset
                  the table itself can't -- clearing the filter has to stay
                  reachable even when a period change empties the rollup. */}
              <div className="an-filter-row">
                <button
                  className={`an-chip${settlementRouteFilter === "all" ? " active" : ""}`}
                  onClick={() => setSettlementRouteFilter("all")}
                >
                  {t("settle.allRoutes")}
                  <span className="an-chip-count">{settlementRides.length}</span>
                </button>
                {settlementRollupSorted.map((r) => (
                  <button
                    key={r.settlement_route}
                    className={`an-chip${settlementRouteFilter === r.settlement_route ? " active" : ""}`}
                    onClick={() => setSettlementRouteFilter(r.settlement_route)}
                  >
                    <span
                      className="an-dot"
                      style={{ background: settlementColor(r.settlement_route), marginRight: 6 }}
                    />
                    {settlementShort(r.settlement_route)}
                    <span className="an-chip-count">{r.rides_count}</span>
                  </button>
                ))}
                <span className="an-filter-count">
                  {t("settle.nShown", { count: filteredSettlementRides.length })}
                </span>
              </div>

              {settlementRidesLoading ? (
                <div className="an-loading">{t("common.loading")}</div>
              ) : filteredSettlementRides.length === 0 ? (
                <div className="an-no-data">
                  {t("settle.noRidesMatchFilter")}
                </div>
              ) : (
                <div className="an-chart-card" style={{ padding: 0, overflow: "hidden" }}>
                  <table className="an-table">
                    <thead>
                      <tr>
                        {([
                          "date",
                          "ride",
                          "driver",
                          "fare",
                          "route",
                          "status",
                        ] as const).map((h) => (
                          <th key={h} className="an-th" style={{ padding: "12px 14px" }}>
                            {t(`analytics.col.${h}`)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredSettlementRides.map((row, i) => {
                        const isProblem = (
                          SETTLEMENT_ACTIONABLE_ROUTES as readonly string[]
                        ).includes(row.settlement_route);
                        const color = settlementColor(row.settlement_route);
                        return (
                          <tr
                            key={row.id}
                            style={{
                              background:
                                i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)",
                            }}
                          >
                            <td className="an-td" style={{ whiteSpace: "nowrap" }}>
                              {fmtDate(row.completed_at ?? row.created_at)}
                            </td>
                            <td
                              className="an-td"
                              style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}
                              title={row.id}
                            >
                              {formatRideRef(row.ride_ref)}
                            </td>
                            <td className="an-td primary">{row.driver_name}</td>
                            <td className="an-td" style={{ color: "#E2E8F0", fontWeight: 600 }}>
                              {row.fare_final != null ? `$${row.fare_final.toFixed(2)}` : "—"}
                            </td>
                            <td className="an-td">
                              <span style={{ display: "flex", alignItems: "center" }}>
                                <span className="an-dot" style={{ background: color }} />
                                <span style={isProblem ? { color, fontWeight: 600 } : {}}>
                                  {settlementShort(row.settlement_route)}
                                </span>
                              </span>
                              {row.stripe_dispute_id && (
                                <div style={{ fontSize: 10, color: "#6B7280", marginLeft: 16 }}>
                                  {row.stripe_dispute_id}
                                </div>
                              )}
                            </td>
                            <td className="an-td">
                              {!isProblem ? (
                                <span style={{ fontSize: 12, color: "#4B5563" }}>
                                  {t("settle.noActionNeeded")}
                                </span>
                              ) : row.settlement_resolved_at ? (
                                <span
                                  style={{
                                    fontSize: 12,
                                    color: "#1D9E75",
                                    fontWeight: 600,
                                    whiteSpace: "nowrap",
                                  }}
                                  title={fmtDateTime(row.settlement_resolved_at)}
                                >
                                  ✓ {t("reports.resolved")}
                                </span>
                              ) : (
                                <button
                                  className="an-download-btn-sm"
                                  disabled={resolvingRideId === row.id}
                                  onClick={() => resolveSettlement(row)}
                                >
                                  {resolvingRideId === row.id ? t("settle.marking") : t("reports.markResolvedCheck")}
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {/* ── REVIEWS ── */}
          {section === "reviews" && (
            <>
              <div className="an-section-header">
                <div className="an-section-title">{t("analytics.sections.reviews")}</div>
                <div className="an-controls">
                  <button className="an-download-btn" onClick={exportReviewsPDF}>{t("analytics.pdf")}</button>
                  <button className="an-csv-btn" onClick={exportReviewsCSV}>{t("analytics.csv")}</button>
                </div>
              </div>
              {reviewsLoading ? (
                <div className="an-loading">{t("common.loading")}</div>
              ) : (
                <>
                  <div
                    className="an-filter-row"
                    style={{ gap: 10, marginBottom: 16 }}
                  >
                    <select
                      className="an-select"
                      value={reviewDriverFilter}
                      onChange={(e) => setReviewDriverFilter(e.target.value)}
                    >
                      <option value="all">{t("reports.allDrivers")}</option>
                      {reviewDriverOptions.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                    <div style={{ display: "flex", gap: 4 }}>
                      {[null, 1, 2, 3, 4, 5].map((s) => (
                        <button
                          key={s ?? "all"}
                          className={`an-filter-btn${reviewStarFilter === s ? " active" : ""}`}
                          onClick={() => setReviewStarFilter(s)}
                          style={{ padding: "5px 10px" }}
                        >
                          {s === null ? t("analytics.filterAll") : "★".repeat(s)}
                        </button>
                      ))}
                    </div>
                    <span className="an-filter-count">
                      {t("analytics.reviewsCount", { count: filteredReviews.length })}
                      {filteredReviews.length !== 1 ? "s" : ""}
                    </span>
                  </div>

                  {reviewDriverFilter !== "all" &&
                    selectedDriverAvg !== null && (
                      <div
                        className="an-revenue-strip"
                        style={{
                          marginBottom: 16,
                          gridTemplateColumns: "repeat(3, 1fr)",
                        }}
                      >
                        <div className="an-revenue-mini">
                          <div className="an-revenue-mini-label">{t("analytics.sections.reviews")}</div>
                          <div className="an-revenue-mini-value">
                            {selectedDriverReviews.length}
                          </div>
                        </div>
                        <div className="an-revenue-mini">
                          <div className="an-revenue-mini-label">
                            {t("drivers.avgRating")}
                          </div>
                          <div
                            className="an-revenue-mini-value"
                            style={{
                              color:
                                selectedDriverAvg >= 4
                                  ? "#1D9E75"
                                  : selectedDriverAvg <= 2
                                    ? "#E24B4A"
                                    : "#F59E0B",
                            }}
                          >
                            {selectedDriverAvg.toFixed(1)} ★
                          </div>
                        </div>
                        <div className="an-revenue-mini">
                          <div className="an-revenue-mini-label">
                            {t("analytics.lowRatings")}
                          </div>
                          <div
                            className="an-revenue-mini-value"
                            style={{
                              color:
                                selectedDriverFlagged > 0
                                  ? "#E24B4A"
                                  : "#F1F5F9",
                            }}
                          >
                            {selectedDriverFlagged > 0
                              ? `⚠ ${selectedDriverFlagged}`
                              : "—"}
                          </div>
                        </div>
                      </div>
                    )}

                  {filteredReviews.length === 0 ? (
                    <div className="an-no-data" style={{ padding: "48px 0" }}>
                      {t("analytics.noReviewsMatch")}
                    </div>
                  ) : (
                    filteredReviews.map((rv) => (
                      <div
                        key={rv.id}
                        className={`an-review-card${rv.rating <= 2 ? " flagged" : ""}${rv.reviewed_by_dispatch ? " dispatch-reviewed" : ""}`}
                      >
                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            marginBottom:
                              rv.rating <= 2 || rv.reviewed_by_dispatch ? 8 : 0,
                            flexWrap: "wrap",
                          }}
                        >
                          {rv.rating <= 2 && (
                            <span className="an-review-flag">⚠ {t("receipt.lowRating")}</span>
                          )}
                          {rv.reviewed_by_dispatch && (
                            <span className="an-reviewed-badge">
                              ✓ {t("analytics.reviewedByDispatch")}
                            </span>
                          )}
                        </div>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: 8,
                          }}
                        >
                          <div>
                            <span
                              style={{
                                color: "#F59E0B",
                                fontSize: 14,
                                letterSpacing: 1,
                              }}
                            >
                              {"★".repeat(rv.rating)}
                              {"☆".repeat(5 - rv.rating)}
                            </span>
                            <span
                              style={{
                                fontSize: 11,
                                color: "#9CA3AF",
                                marginLeft: 6,
                              }}
                            >
                              {rv.rating}/5
                            </span>
                          </div>
                          <span style={{ fontSize: 11, color: "#6B7280" }}>
                            {fmtDate(rv.created_at,
                              {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              },
                            )}
                          </span>
                        </div>
                        <div
                          style={{ display: "flex", gap: 20, marginBottom: 6 }}
                        >
                          <div style={{ fontSize: 12, color: "#9CA3AF" }}>
                            <span style={{ color: "#6B7280" }}>{t("reports.driver")}: </span>
                            {rv.driver_name ?? "—"}
                          </div>
                          <div style={{ fontSize: 12, color: "#9CA3AF" }}>
                            <span style={{ color: "#6B7280" }}>
                              {t("rideDetail.passenger")}:{" "}
                            </span>
                            {rv.passenger_name ?? "—"}
                          </div>
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: "#9CA3AF",
                            marginBottom: rv.comment ? 8 : 0,
                          }}
                        >
                          {rv.pickup_address} → {rv.dropoff_address}
                        </div>
                        {rv.comment && (
                          <div
                            style={{
                              background: "rgba(255,255,255,0.03)",
                              borderRadius: 6,
                              padding: "8px 12px",
                              borderLeft: "2px solid #2D3F52",
                              fontSize: 13,
                              color: "#9CA3AF",
                              fontStyle: "italic",
                            }}
                          >
                            "{rv.comment}"
                          </div>
                        )}
                        {rv.rating <= 2 && !rv.reviewed_by_dispatch && (
                          <button
                            className="an-mark-reviewed-btn"
                            disabled={markingReviewed === rv.id}
                            onClick={() => markReviewReviewed(rv.id)}
                          >
                            {markingReviewed === rv.id
                              ? t("common.saving")
                              : t("analytics.markAsReviewed")}
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </>
              )}
            </>
          )}

          {/* ── DRIVERS ── */}
          {section === "drivers" && (
            <>
              <div className="an-section-header">
                <div className="an-section-title">{t("analytics.driverPerformance")}</div>
                <div className="an-controls">
                  <div className="an-period-btns">
                    {(["today", "week", "month", "year"] as const).map((p) => (
                      <button
                        key={p}
                        className={`an-period-btn${period === p ? " active" : ""}`}
                        onClick={() => setPeriod(p)}
                      >
                        {t(`analytics.period.${p}`)}
                      </button>
                    ))}
                  </div>
                  <button className="an-download-btn" onClick={exportDriversPDF}>{t("analytics.pdf")}</button>
                  <button className="an-csv-btn" onClick={exportDriverStatsCSV}>{t("analytics.csv")}</button>
                </div>
              </div>
              {revenueLoading ? (
                <div className="an-loading">{t("common.loading")}</div>
              ) : driverStats.length === 0 ? (
                <div className="an-no-data">{t("analytics.noDriverData")}</div>
              ) : (() => {
                const totalRides = driverStats.reduce((s, d) => s + d.rides, 0);
                const totalEarnings = driverStats.reduce((s, d) => s + d.earnings, 0);
                const maxEarnings = Math.max(...driverStats.map((d) => d.earnings), 1);
                const rated = driverStats.filter((d) => d.avgRating !== null);
                const fleetRating = rated.length
                  ? rated.reduce((s, d) => s + (d.avgRating ?? 0) * d.ratingCount, 0) /
                    rated.reduce((s, d) => s + d.ratingCount, 0)
                  : null;
                const medals = ["🥇", "🥈", "🥉"];
                // Initials of a PERSON'S NAME, not a label — the only thing
                // being title-cased here is the user's own data.
                const initials = (name: string) => // i18n-ok
                  name
                    .split(" ")
                    .filter(Boolean)
                    .slice(0, 2)
                    .map((w) => w[0]?.toUpperCase() ?? "")
                    .join("") || "?";
                const ratingColor = (r: number) =>
                  r >= 4 ? "#1D9E75" : r <= 2 ? "#E24B4A" : "#F59E0B";
                return (
                  <>
                    <div className="an-kpi-grid">
                      <div className="an-kpi-card">
                        <div className="an-kpi-label">{t("analytics.activeDrivers")}</div>
                        <div className="an-kpi-value">{driverStats.length}</div>
                        <div className="an-kpi-sub">{t("analytics.withRidesThisPeriod")}</div>
                      </div>
                      <div className="an-kpi-card">
                        <div className="an-kpi-label">{t("analytics.completedRides")}</div>
                        <div className="an-kpi-value">{totalRides}</div>
                        <div className="an-kpi-sub">
                          {t("analytics.avgPerDriver", { n: (totalRides / driverStats.length).toFixed(1) })}
                        </div>
                      </div>
                      <div className="an-kpi-card">
                        <div className="an-kpi-label">{t("analytics.totalEarnings")}</div>
                        <div className="an-kpi-value" style={{ color: "#1D9E75" }}>
                          ${totalEarnings.toFixed(2)}
                        </div>
                        <div className="an-kpi-sub">{t("analytics.faresCollectedByDrivers")}</div>
                      </div>
                      <div className="an-kpi-card">
                        <div className="an-kpi-label">{t("analytics.fleetRating")}</div>
                        <div
                          className="an-kpi-value"
                          style={{ color: fleetRating !== null ? ratingColor(fleetRating) : "#6B7280" }}
                        >
                          {fleetRating !== null ? `${fleetRating.toFixed(1)} ★` : "—"}
                        </div>
                        <div className="an-kpi-sub">
                          {fleetRating !== null
                            ? t("analytics.acrossReviews", { count: rated.reduce((s, d) => s + d.ratingCount, 0) })
                            : t("analytics.noReviewsYet")}
                        </div>
                      </div>
                    </div>
                    <div className="an-chart-card" style={{ padding: 0, overflow: "hidden" }}>
                      <div className="an-dl-head">
                        <div className="an-dl-hcell" style={{ textAlign: "center" }}>#</div>
                        <div className="an-dl-hcell" />
                        <div className="an-dl-hcell">{t("csv.driver")}</div>
                        <div className="an-dl-hcell" style={{ textAlign: "right" }}>{t("csv.earnings")}</div>
                        <div className="an-dl-hcell">{t("analytics.cashSlashCard")}</div>
                        <div className="an-dl-hcell" style={{ textAlign: "right" }}>{t("csv.rating")}</div>
                      </div>
                      {driverStats.map((d, i) => {
                        const paidTotal = d.cashEarnings + d.cardEarnings;
                        const cashPct = paidTotal ? (d.cashEarnings / paidTotal) * 100 : 0;
                        const cardPct = paidTotal ? 100 - cashPct : 0;
                        return (
                          <div
                            className="an-dl-row"
                            key={d.id}
                            onClick={() => setDriverDetail(d)}
                          >
                            <div className={`an-dl-rank${i < 3 ? " medal" : ""}`}>
                              {i < 3 ? medals[i] : i + 1}
                            </div>
                            <div className="an-dl-av">
                              {d.avatarUrl ? (
                                <img
                                  src={d.avatarUrl}
                                  alt=""
                                  onError={(e) => {
                                    // fall back to initials if the image 404s
                                    const el = e.currentTarget;
                                    el.style.display = "none";
                                    el.parentElement!.textContent = initials(d.name);
                                  }}
                                />
                              ) : (
                                initials(d.name)
                              )}
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <div className="an-dl-name">{d.name}</div>
                              <div className="an-dl-meta">
                                {t("analytics.ridesCount", { count: d.rides })} · {t("analytics.avgFareInline", { amount: d.avgFare.toFixed(2) })}
                                {d.cancelRate > 0 && (
                                  <>
                                    {" · "}
                                    <span className={d.cancelRate > 20 ? "warn" : undefined}>
                                      {t("analytics.pctCancelled", { pct: d.cancelRate.toFixed(0) })}
                                    </span>
                                  </>
                                )}
                              </div>
                            </div>
                            <div>
                              <div className="an-dl-earn-val">${d.earnings.toFixed(2)}</div>
                              <div className="an-dl-earn-track">
                                <div
                                  className="an-dl-earn-fill"
                                  style={{ width: `${(d.earnings / maxEarnings) * 100}%` }}
                                />
                              </div>
                            </div>
                            <div>
                              <div className="an-dl-split-track">
                                <div className="an-dl-split-cash" style={{ width: `${cashPct}%` }} />
                                <div className="an-dl-split-card" style={{ width: `${cardPct}%` }} />
                              </div>
                              <div className="an-dl-split-legend">
                                <span style={{ color: "#F59E0B" }}>${d.cashEarnings.toFixed(0)}</span>
                                <span style={{ color: "#1D9E75" }}>${d.cardEarnings.toFixed(0)}</span>
                              </div>
                            </div>
                            <div className="an-dl-rating">
                              {d.avgRating !== null ? (
                                <>
                                  <span style={{ color: ratingColor(d.avgRating) }}>
                                    {d.avgRating.toFixed(1)} ★
                                  </span>
                                  <span className="cnt">
                                    {t("analytics.reviewsCount", { count: d.ratingCount })}
                                  </span>
                                </>
                              ) : (
                                <span className="none">—</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {driverDetail && (() => {
                      const d = driverDetail;
                      const rank = driverStats.findIndex((x) => x.id === d.id) + 1;
                      const fleetAvgFare = totalRides ? totalEarnings / totalRides : 0;
                      const fleetAvgEarn = driverStats.length
                        ? totalEarnings / driverStats.length
                        : 0;
                      const paidTotal = d.cashEarnings + d.cardEarnings;
                      const diffPct = fleetAvgEarn
                        ? ((d.earnings - fleetAvgEarn) / fleetAvgEarn) * 100
                        : 0;
                      const fmtDate = (s: string) =>
                        new Date(s).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        });
                      return (
                        <div
                          className="an-modal-overlay"
                          onClick={() => setDriverDetail(null)}
                        >
                          <div className="an-modal" onClick={(e) => e.stopPropagation()}>
                            <div className="an-dm-head">
                              <div className="an-dm-av">
                                {d.avatarUrl ? (
                                  <img src={d.avatarUrl} alt="" />
                                ) : (
                                  initials(d.name)
                                )}
                              </div>
                              <div style={{ minWidth: 0 }}>
                                <div className="an-dm-name">{d.name}</div>
                                <div className="an-dm-sub">
                                  {rank <= 3 ? `${medals[rank - 1]} ` : ""}
                                  {t("analytics.rankByEarnings", { rank })}
                                  {d.avgRating !== null && (
                                    <>
                                      {" · "}
                                      <span
                                        style={{
                                          color: ratingColor(d.avgRating),
                                          fontWeight: 600,
                                        }}
                                      >
                                        {d.avgRating.toFixed(1)} ★
                                      </span>{" "}
                                      ({d.ratingCount})
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="an-dm-grid">
                              <div className="an-dm-stat">
                                <div className="an-dm-stat-label">{t("analytics.totalEarnings")}</div>
                                <div
                                  className="an-dm-stat-value"
                                  style={{ color: "#1D9E75" }}
                                >
                                  ${d.earnings.toFixed(2)}
                                </div>
                                <div className="an-dm-stat-sub">
                                  {diffPct >= 0 ? "▲" : "▼"}{" "}
                                  {t("analytics.vsFleetAvg", { pct: Math.abs(diffPct).toFixed(0) })}
                                </div>
                              </div>
                              <div className="an-dm-stat">
                                <div className="an-dm-stat-label">{t("analytics.completedRides")}</div>
                                <div className="an-dm-stat-value">{d.rides}</div>
                                <div className="an-dm-stat-sub">
                                  {t("analytics.avgVsFleet", { avg: d.avgFare.toFixed(2), fleet: fleetAvgFare.toFixed(2) })}
                                </div>
                              </div>
                              <div className="an-dm-stat">
                                <div className="an-dm-stat-label">{t("analytics.cashSlashCard")}</div>
                                <div
                                  className="an-dm-stat-value"
                                  style={{ fontSize: 15 }}
                                >
                                  <span style={{ color: "#F59E0B" }}>
                                    ${d.cashEarnings.toFixed(0)}
                                  </span>
                                  <span style={{ color: "#4B5563" }}> / </span>
                                  <span style={{ color: "#1D9E75" }}>
                                    ${d.cardEarnings.toFixed(0)}
                                  </span>
                                </div>
                                <div className="an-dm-stat-sub">
                                  {paidTotal
                                    ? Math.round((d.cashEarnings / paidTotal) * 100)
                                    : 0}
                                  {t("analytics.pctCashSuffix")}
                                </div>
                              </div>
                              <div className="an-dm-stat">
                                <div className="an-dm-stat-label">{t("analytics.cancellations")}</div>
                                <div
                                  className="an-dm-stat-value"
                                  style={{
                                    color: d.cancelRate > 20 ? "#E24B4A" : "#F1F5F9",
                                  }}
                                >
                                  {d.cancelled}
                                </div>
                                <div className="an-dm-stat-sub">
                                  {t("analytics.pctOfAssigned", { pct: d.cancelRate.toFixed(1) })}
                                </div>
                              </div>
                            </div>
                            <div className="an-dm-section-title">
                              {t("analytics.recentReviewComments")}
                            </div>
                            {d.recentReviews.length === 0 ? (
                              <div className="an-no-data" style={{ padding: "16px 0" }}>
                                {t("analytics.noWrittenReviews")}
                              </div>
                            ) : (
                              d.recentReviews.map((rv, i) => (
                                <div className="an-dm-review" key={i}>
                                  <div className="an-dm-review-top">
                                    <span
                                      className="an-dm-review-stars"
                                      style={{ color: ratingColor(rv.rating) }}
                                    >
                                      {"★".repeat(rv.rating)}
                                      <span style={{ color: "#374151" }}>
                                        {"★".repeat(5 - rv.rating)}
                                      </span>
                                    </span>
                                    <span className="an-dm-review-date">
                                      {fmtDate(rv.created_at)}
                                    </span>
                                  </div>
                                  <div className="an-dm-review-text">{rv.comment}</div>
                                </div>
                              ))
                            )}
                            <button
                              className="an-modal-close"
                              onClick={() => setDriverDetail(null)}
                            >
                              {t("common.close")}
                            </button>
                          </div>
                        </div>
                      );
                    })()}
                  </>
                );
              })()}
            </>
          )}
          {/* ── ACTIVITY LOG ── */}
          {section === "activity" && (() => {
            const filtered = activityTypeFilter === "all"
              ? activityEvents
              : activityEvents.filter((e) => e.event_type === activityTypeFilter);
            const cancels = filtered.filter((e) => e.event_type === "ride.cancelled").length;
            const driverActions = filtered.filter((e) => e.event_type.startsWith("driver.") || e.event_type.startsWith("invite.")).length;
            const announcements = filtered.filter((e) => e.event_type.startsWith("announcement.")).length;

            return (
              <>
                {/* Header row */}
                <div className="an-section-header" style={{ marginBottom: 12 }}>
                  <div>
                    <div className="an-section-title">{t("analytics.sections.activity")}</div>
                    <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2 }}>
                      {activityDateFrom} → {activityDateTo}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      className="an-download-btn"
                      onClick={() => exportActivityPDF(filtered)}
                      disabled={filtered.length === 0}
                    >
                      {t("analytics.pdf")}
                    </button>
                    <button
                      className="an-csv-btn"
                      onClick={() => exportActivityCSV(filtered)}
                      disabled={filtered.length === 0}
                    >
                      {t("analytics.csv")}
                    </button>
                  </div>
                </div>

                {/* Filter toolbar */}
                <div className="al-toolbar">
                  <span className="al-toolbar-label">{t("analytics.from")}</span>
                  <input
                    type="date"
                    className="an-date-input"
                    value={activityDateFrom}
                    onChange={(e) => setActivityDateFrom(e.target.value)}
                  />
                  <span className="al-toolbar-label">{t("analytics.to")}</span>
                  <input
                    type="date"
                    className="an-date-input"
                    value={activityDateTo}
                    onChange={(e) => setActivityDateTo(e.target.value)}
                  />
                  <div className="al-toolbar-sep" />
                  <select
                    className="an-type-select"
                    value={activityTypeFilter}
                    onChange={(e) => setActivityTypeFilter(e.target.value)}
                  >
                    <option value="all">{t("analytics.allEventTypes")}</option>
                    <optgroup label={t("nav.rides")}>
                      <option value="ride.created">{eventLabel("ride.created")}</option>
                      <option value="ride.cancelled">{eventLabel("ride.cancelled")}</option>
                      <option value="ride.assigned">{eventLabel("ride.assigned")}</option>
                      <option value="ride.reassigned">{eventLabel("ride.reassigned")}</option>
                      <option value="ride.fare_changed">{eventLabel("ride.fare_changed")}</option>
                      <option value="ride.scheduled_modified">{eventLabel("ride.scheduled_modified")}</option>
                      <option value="ride.route_modified">{eventLabel("ride.route_modified")}</option>
                      <option value="ride.flag_resolved">{eventLabel("ride.flag_resolved")}</option>
                    </optgroup>
                    <optgroup label={t("nav.drivers")}>
                      <option value="driver.suspended">{eventLabel("driver.suspended")}</option>
                      <option value="driver.reactivated">{eventLabel("driver.reactivated")}</option>
                      <option value="driver.deleted">{eventLabel("driver.deleted")}</option>
                      <option value="driver.vehicle_updated">{eventLabel("driver.vehicle_updated")}</option>
                      <option value="invite.created">{eventLabel("invite.created")}</option>
                      <option value="invite.revoked">{eventLabel("invite.revoked")}</option>
                    </optgroup>
                    <optgroup label={t("nav.discounts")}>
                      <option value="discount.created">{eventLabel("discount.created")}</option>
                      <option value="discount.deactivated">{eventLabel("discount.deactivated")}</option>
                      <option value="discount.deleted">{eventLabel("discount.deleted")}</option>
                    </optgroup>
                    <optgroup label={t("nav.announcements")}>
                      <option value="announcement.drivers">{eventLabel("announcement.drivers")}</option>
                      <option value="announcement.passengers">{eventLabel("announcement.passengers")}</option>
                    </optgroup>
                    <optgroup label={t("nav.settings")}>
                      <option value="settings.pricing_updated">{eventLabel("settings.pricing_updated")}</option>
                      <option value="settings.contact_updated">{eventLabel("settings.contact_updated")}</option>
                      <option value="settings.numbering_updated">{eventLabel("settings.numbering_updated")}</option>
                      <option value="settings.vehicle_class_created">{eventLabel("settings.vehicle_class_created")}</option>
                      <option value="settings.vehicle_class_updated">{eventLabel("settings.vehicle_class_updated")}</option>
                      <option value="settings.vehicle_class_status_changed">{eventLabel("settings.vehicle_class_status_changed")}</option>
                    </optgroup>
                    {/* Only types something actually emits are listed. The
                        remaining allowed values (ride.notes_added,
                        escalation.acknowledged, report.reviewed/dismissed,
                        driver.number_changed, driver.car_number_changed,
                        staff.deactivated/reactivated) have no emitter, so an
                        option for them would be a filter that always returns
                        nothing. Add the option WITH the emitter. */}
                    <optgroup label={t("nav.reports")}>
                      <option value="report.printed">{eventLabel("report.printed")}</option>
                      <option value="dispatch_report.submitted">{eventLabel("dispatch_report.submitted")}</option>
                    </optgroup>
                    <optgroup label={t("settings.sections.team")}>
                      <option value="staff.created">{eventLabel("staff.created")}</option>
                      <option value="staff.updated">{eventLabel("staff.updated")}</option>
                    </optgroup>
                    <optgroup label={t("analytics.sections.settlements")}>
                      <option value="settlement.resolved">{eventLabel("settlement.resolved")}</option>
                    </optgroup>
                    <optgroup label={t("analytics.exports")}>
                      <option value="export.csv">{eventLabel("export.csv")}</option>
                      <option value="export.pdf">{eventLabel("export.pdf")}</option>
                      <option value="invoice.printed">{eventLabel("invoice.printed")}</option>
                    </optgroup>
                  </select>
                  {activityLoading && (
                    <span style={{ fontSize: 11, color: "#6B7280", marginLeft: 4 }}>{t("common.loading")}</span>
                  )}
                </div>

                {/* Stats strip */}
                <div className="al-stats">
                  <div className="al-stat">
                    <span className="al-stat-val">{filtered.length}</span>
                    <span className="al-stat-lbl">{t("analytics.totalEvents")}</span>
                  </div>
                  <div className="al-stat">
                    <span className="al-stat-val" style={{ color: cancels > 0 ? "#E24B4A" : "#F1F5F9" }}>{cancels}</span>
                    <span className="al-stat-lbl">{t("analytics.cancellations")}</span>
                  </div>
                  <div className="al-stat">
                    <span className="al-stat-val">{driverActions}</span>
                    <span className="al-stat-lbl">{t("analytics.driverActions")}</span>
                  </div>
                  <div className="al-stat">
                    <span className="al-stat-val">{announcements}</span>
                    <span className="al-stat-lbl">{t("nav.announcements")}</span>
                  </div>
                </div>

                {/* Debug error */}
                {activityError && (
                  <div style={{ background: "#2D1515", border: "1px solid #E24B4A44", borderRadius: 8, padding: "10px 14px", marginBottom: 12, fontSize: 12, color: "#E24B4A", fontFamily: "monospace" }}>
                    {activityError}
                  </div>
                )}

                {/* Table */}
                {!activityLoading && filtered.length === 0 ? (
                  <div className="an-no-data" style={{ padding: "48px 0" }}>
                    {activityError ? t("analytics.couldNotLoadEvents") : t("analytics.noEvents")}
                  </div>
                ) : (
                  <div className="an-chart-card" style={{ padding: 0, overflow: "hidden" }}>
                    <table className="al-table">
                      <thead>
                        <tr>
                          <th className="al-th">{t("csv.dateTime")}</th>
                          <th className="al-th">{t("settings.role.dispatcher")}</th>
                          <th className="al-th">{t("csv.event")}</th>
                          <th className="al-th">{t("csv.details")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((e) => {
                          const color = EVENT_COLORS[e.event_type] ?? "#6B7280";
                          const detail = formatEventDetails(e.event_type, e.details);
                          return (
                            <tr key={e.id} className="al-tr">
                              <td className="al-td al-td-time">
                                {fmtDateTime(e.created_at, {
                                  month: "short",
                                  day: "numeric",
                                  hour: "numeric",
                                  minute: "2-digit",
                                } as any)}
                              </td>
                              <td className="al-td al-td-dispatcher">{e.dispatcher_name ?? "—"}</td>
                              <td className="al-td al-td-event" style={{ color }}>
                                {eventLabel(e.event_type)}
                              </td>
                              <td className="al-td al-td-detail">{detail || "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            );
          })()}

          {/* ── RECEIPTS ── */}
          {section === "receipts" && (
            <>
              <div className="an-section-header">
                <div className="an-section-title">{t("analytics.sections.receipts")}</div>
                <div className="an-controls">
                  <span className="an-filter-count">
                    {t("analytics.receiptsCount", { count: filteredReceipts.length })}
                  </span>
                  <button className="an-download-btn" onClick={exportReceiptsPDF} disabled={filteredReceipts.length === 0}>{t("analytics.pdf")}</button>
                  <button className="an-csv-btn" onClick={exportReceiptsCSV} disabled={filteredReceipts.length === 0}>{t("analytics.csv")}</button>
                </div>
              </div>
              <div className="inv-search-row">
                <input
                  className="inv-search"
                  placeholder={t("analytics.receiptSearchPlaceholder")}
                  value={receiptSearch}
                  onChange={(e) => setReceiptSearch(e.target.value)}
                />
              </div>
              {receiptsLoading ? (
                <div className="an-loading">{t("common.loading")}</div>
              ) : filteredReceipts.length === 0 ? (
                <div className="an-no-data" style={{ padding: "48px 0" }}>
                  {receiptSearch ? t("analytics.noReceiptsMatch") : t("analytics.noReceiptsYet")}
                </div>
              ) : (
                <div className="an-chart-card" style={{ padding: 0, overflow: "hidden" }}>
                  <table className="an-table">
                    <thead>
                      <tr>
                        {([
                          "receiptNo",
                          "date",
                          "passenger",
                          "driver",
                          "route",
                          "amount",
                          "payment",
                        ] as const).map((h) => (
                          <th key={h} className="an-th" style={{ padding: "12px 14px" }}>{t(`analytics.col.${h}`)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredReceipts.map((inv, i) => (
                        <tr
                          key={inv.id}
                          className="an-ride-row"
                          style={{ background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)" }}
                          onClick={() => setSelectedReceipt(inv)}
                        >
                          <td className="an-td">
                            <span className="receipt-tag">{inv.receipt_number}</span>
                          </td>
                          <td className="an-td" style={{ whiteSpace: "nowrap" }}>
                            {fmtDate(inv.sent_at, { month: "short", day: "numeric", year: "numeric" })}
                          </td>
                          <td className="an-td primary">{inv.passenger_name ?? "—"}</td>
                          <td className="an-td">{inv.driver_name ?? "—"}</td>
                          <td className="an-td addr">
                            {inv.pickup_address && inv.dropoff_address
                              ? `${inv.pickup_address} → ${inv.dropoff_address}`
                              : inv.pickup_address ?? "—"}
                          </td>
                          <td className="an-td green">${inv.fare.toFixed(2)}</td>
                          <td className="an-td" style={{ textTransform: "capitalize" }}>{inv.payment_method ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {selectedReceipt && (
                <div className="an-modal-overlay" onClick={() => setSelectedReceipt(null)}>
                  <div className="an-modal" onClick={(e) => e.stopPropagation()}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                      <div className="an-modal-title" style={{ marginBottom: 0 }}>{t("receipt.receipt")}</div>
                      <span className="receipt-tag" style={{ fontSize: 13, padding: "4px 10px" }}>
                        {selectedReceipt.receipt_number}
                      </span>
                    </div>
                    {(
                      [
                        [t("receipt.date"), fmtDateTime(selectedReceipt.sent_at, { dateStyle: "medium", timeStyle: "short" })],
                        [t("receipt.company"), selectedReceipt.company_name ?? "—"],
                        ...(receiptTax(selectedReceipt).taxed && selectedReceipt.hst_number
                          ? [[
                              t("receipt.taxRegLabel", {
                                taxLabel: selectedReceipt.tax_label || t("receipt.hst"),
                              }),
                              selectedReceipt.hst_number,
                            ]]
                          : []),
                        [t("analytics.col.passenger"), selectedReceipt.passenger_name ?? "—"],
                        [t("analytics.col.driver"), selectedReceipt.driver_name ?? "—"],
                        [t("analytics.col.pickup"), selectedReceipt.pickup_address ?? "—"],
                        [t("analytics.col.dropoff"), selectedReceipt.dropoff_address ?? "—"],
                        [t("analytics.col.payment"), selectedReceipt.payment_method ?? "—"],
                        ...(selectedReceipt.discount_amount && selectedReceipt.pre_discount_fare != null
                          ? ([
                              [t("receipt.originalFare"), `$${selectedReceipt.pre_discount_fare.toFixed(2)}`],
                              [`${t("receipt.discount")}${selectedReceipt.discount_label ? ` — ${selectedReceipt.discount_label}` : ""}`, `-$${selectedReceipt.discount_amount.toFixed(2)}`],
                            ] as [string, string][])
                          : []),
                        // Same gate and same stored figures as the printed and
                        // emailed copies — see receiptTax(). No tax line at all
                        // when the ride was not taxed.
                        ...((): [string, string][] => {
                          const tax = receiptTax(selectedReceipt);
                          if (!tax.taxed) return [];
                          const taxLabel = tax.label || t("receipt.hst");
                          return [
                            [t("receipt.subtotalBefore", { taxLabel }), `$${tax.subtotal!.toFixed(2)}`],
                            [
                              t("receipt.taxLine", { taxLabel, rate: tax.rateText }),
                              `$${tax.amount!.toFixed(2)}`,
                            ],
                          ];
                        })(),
                        [totalLabel, `$${selectedReceipt.fare.toFixed(2)}`],
                      ] as [string, string][]
                    ).map(([lbl, val]) => (
                      <div
                        key={lbl}
                        className="an-detail-row"
                        style={lbl === totalLabel ? { borderTop: "1px solid rgba(255,255,255,0.12)", marginTop: 4, paddingTop: 12 } : {}}
                      >
                        <span className="an-detail-label">{lbl}</span>
                        <span
                          className="an-detail-value"
                          style={lbl === totalLabel ? { color: "#1D9E75", fontWeight: 700, fontSize: 16 } : {}}
                        >
                          {val}
                        </span>
                      </div>
                    ))}
                    <button
                      className="an-download-btn"
                      style={{ width: "100%", marginTop: 16, textAlign: "center" }}
                      onClick={() => printReceipt(selectedReceipt)}
                    >
                      {t("analytics.printReceipt")}
                    </button>
                    <button className="an-modal-close" onClick={() => setSelectedReceipt(null)}>
                      {t("common.close")}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── RIDE DETAIL MODAL ── */}
      {rideDetail && (
        <div className="an-modal-overlay" onClick={() => setRideDetail(null)}>
          <div className="an-modal" onClick={(e) => e.stopPropagation()}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 16,
              }}
            >
              <div className="an-modal-title" style={{ marginBottom: 0 }}>
                {t("rideEdit.rideDetails")}
              </div>
              <span
                className="an-status"
                style={{
                  background: STATUS_COLORS[rideDetail.ride.status] + "18",
                  color: STATUS_COLORS[rideDetail.ride.status],
                  border: `1px solid ${STATUS_COLORS[rideDetail.ride.status]}30`,
                }}
              >
                {rideStatusLabel(rideDetail.ride.status)}
              </span>
            </div>
            {(
              [
                [
                  t("receipt.date"),
                  fmtDateTime(rideDetail.ride.created_at, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }),
                ],
                [t("rideDetail.passenger"), rideDetail.ride.passenger_name],
                [t("rideDetail.driver"), rideDetail.ride.driver_name],
                [t("reports.pickup"), rideDetail.ride.pickup_address],
                [t("reports.dropoff"), rideDetail.ride.dropoff_address],
                [
                  t("rideDetail.fareEstimate"),
                  rideDetail.ride.fare_estimate
                    ? `$${rideDetail.ride.fare_estimate.toFixed(2)}`
                    : "—",
                ],
                [
                  t("rideDetail.fareFinal"),
                  rideDetail.ride.fare_final
                    ? `$${rideDetail.ride.fare_final.toFixed(2)}`
                    : "—",
                ],
                [t("analytics.col.payment"), rideDetail.ride.payment_method],
                ...(rideDetail.ride.payment_method === "card" && rideDetail.ride.settlement_route
                  ? ([
                      [
                        t("rideDetail.vellonFee"),
                        rideDetail.ride.fare_final != null &&
                        rideDetail.ride.platform_fee_percent_at_completion != null
                          ? `$${(
                              rideDetail.ride.fare_final *
                              (rideDetail.ride.platform_fee_percent_at_completion / 100)
                            ).toFixed(2)} (${rideDetail.ride.platform_fee_percent_at_completion}%)`
                          : "—",
                      ],
                      [
                        t("rideDetail.cardFee"),
                        rideDetail.ride.stripe_fee != null
                          ? `$${rideDetail.ride.stripe_fee.toFixed(2)}`
                          : t("rideDetail.feePending"),
                      ],
                      [
                        t("rideDetail.netSettled"),
                        rideDetail.ride.fare_final != null &&
                        rideDetail.ride.platform_fee_percent_at_completion != null &&
                        rideDetail.ride.stripe_fee != null
                          ? `$${(
                              rideDetail.ride.fare_final -
                              rideDetail.ride.fare_final *
                                (rideDetail.ride.platform_fee_percent_at_completion / 100) -
                              rideDetail.ride.stripe_fee
                            ).toFixed(2)}`
                          : "—",
                      ],
                      [
                        settlementLabel,
                        settlementRouteLabel(rideDetail.ride.settlement_route),
                      ],
                      ...(rideDetail.ride.refunded_amount_cents &&
                      rideDetail.ride.refunded_amount_cents > 0
                        ? ([
                            [
                              t("rideDetail.refundedToPassenger"),
                              `$${(rideDetail.ride.refunded_amount_cents / 100).toFixed(2)}` +
                                (rideDetail.ride.refund_reason
                                  ? ` (${refundReasonLabel(rideDetail.ride.refund_reason)})`
                                  : ""),
                            ],
                            ...(rideDetail.ride.transfer_reversed_cents &&
                            rideDetail.ride.transfer_reversed_cents > 0
                              ? ([
                                  [
                                    t("rideDetail.clawedBack"),
                                    `$${(rideDetail.ride.transfer_reversed_cents / 100).toFixed(2)}`,
                                  ],
                                ] as [string, string][])
                              : []),
                          ] as [string, string][])
                        : []),
                    ] as [string, string][])
                  : []),
                ...(rideDetail.ride.status === "cancelled" && rideDetail.ride.cancelled_reason
                  ? ([[
                      t("rideDetail.cancelledReason"),
                      cancelReasonLabel(rideDetail.ride.cancelled_reason),
                    ]] as [string, string][])
                  : []),
                ...((): [string, string][] => {
                  const waited = noShowEvidence(
                    rideDetail.ride.arrived_at,
                    rideDetail.ride.no_show_at,
                  );
                  return waited ? [[t("rideDetail.driverWaited"), waited]] : [];
                })(),
              ] as [string, string][]
            ).map(([label, value]) => {
              const isSettlementWarning =
                label === settlementLabel &&
                ["transfer_failed", "transfer_reversed", "reversal_failed", "retransfer_failed"].includes(
                  rideDetail.ride.settlement_route ?? "",
                );
              return (
                <div
                  key={label}
                  className={`an-detail-row${isSettlementWarning ? " an-detail-row-warning" : ""}`}
                >
                  <span className="an-detail-label">{label}</span>
                  <span
                    className={`an-detail-value${isSettlementWarning ? " an-detail-value-warning" : ""}`}
                  >
                    {value}
                  </span>
                </div>
              );
            })}

            {rideDetail.review && (
              <>
                <div className="an-modal-section">{t("receipt.review")}</div>
                <div
                  style={{
                    background: "#18222F",
                    borderRadius: 10,
                    padding: 14,
                    border: "1px solid rgba(255,255,255,0.05)",
                  }}
                >
                  {rideDetail.review.rating <= 2 && (
                    <span
                      className="an-review-flag"
                      style={{ marginBottom: 10, display: "inline-block" }}
                    >
                      ⚠ {t("receipt.lowRating")}
                    </span>
                  )}
                  {rideDetail.review.reviewed_by_dispatch && (
                    <span
                      className="an-reviewed-badge"
                      style={{
                        marginBottom: 10,
                        marginLeft: rideDetail.review.rating <= 2 ? 8 : 0,
                        display: "inline-block",
                      }}
                    >
                      ✓ {t("csv.reviewed")}
                    </span>
                  )}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: rideDetail.review.comment ? 8 : 0,
                    }}
                  >
                    <span
                      style={{
                        color: "#F59E0B",
                        fontSize: 15,
                        letterSpacing: 1,
                      }}
                    >
                      {"★".repeat(rideDetail.review.rating)}
                      {"☆".repeat(5 - rideDetail.review.rating)}
                    </span>
                    <span style={{ fontSize: 12, color: "#6B7280" }}>
                      {rideDetail.review.rating}/5
                    </span>
                  </div>
                  {rideDetail.review.comment && (
                    <div
                      style={{
                        background: "rgba(255,255,255,0.03)",
                        borderRadius: 6,
                        padding: "8px 12px",
                        borderLeft: "2px solid #2D3F52",
                        fontSize: 13,
                        color: "#6B7280",
                        fontStyle: "italic",
                      }}
                    >
                      "{rideDetail.review.comment}"
                    </div>
                  )}
                  {!rideDetail.review.reviewed_by_dispatch && (
                    <button
                      className="an-mark-reviewed-btn"
                      style={{ display: "block", marginTop: 10 }}
                      disabled={markingReviewed === rideDetail.review.id}
                      onClick={() => markReviewReviewed(rideDetail.review!.id)}
                    >
                      {markingReviewed === rideDetail.review.id
                        ? t("common.saving")
                        : t("analytics.markAsReviewed")}
                    </button>
                  )}
                </div>
              </>
            )}
            {!rideDetail.review && rideDetail.ride.status === "completed" && (
              <div
                style={{
                  fontSize: 12,
                  color: "#6B7280",
                  textAlign: "center",
                  padding: "12px 0",
                }}
              >
                {t("analytics.noReviewForRide")}
              </div>
            )}

            {rideDetail.ride.receipt_number && (
              <button
                className="an-download-btn"
                style={{ width: "100%", marginTop: 16, textAlign: "center" }}
                disabled={printingRide}
                onClick={() => printRideReceipt(rideDetail.ride, rideDetail.review)}
              >
                {printingRide ? t("analytics.preparing") : t("analytics.printReceipt")}
              </button>
            )}
            <button
              className="an-modal-close"
              onClick={() => setRideDetail(null)}
            >
              {t("common.close")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
