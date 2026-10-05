// The domain label maps that were copy-pasted across DashboardPage,
// AnalyticsPage and ReportsPage — now in one place, holding KEYS.
//
// WHY THIS FILE EXISTS NOW. The repo's convention is per-page copies of
// STATUS_LABELS / STATUS_COLORS / CANCEL_REASON_LABELS (see this repo's
// CLAUDE.md, which says so explicitly and warns you have to edit several by
// hand). That is survivable for English — the copies were in fact identical —
// but a translation turns one list into N per page: three parallel key sets for
// one set of ride statuses, each able to drift from the others silently, in a
// language the person editing it cannot read. So i18n forces the hoist that was
// optional before.
//
// COLORS ARE DELIBERATELY NOT HERE. They are styling, each page scopes its own
// CSS, and moving them would be a second change riding along with this one.
// Only the maps that became translation keys moved.
//
// EVERY VALUE IS A KEY, NOT ENGLISH. These are module-scope tables, evaluated
// before any language is active, so a t() call here would resolve against
// whatever locale happened to boot and then never update. Resolve at the render
// site: `t(RIDE_STATUS_KEYS[ride.status])`.
//
// A dynamic `t(MAP[x])` is INVISIBLE to check-i18n.mjs, which can only see
// literal t("…") calls. That is the cost of this shape and the reason the keys
// are written out in full here rather than assembled — they stay greppable, and
// this file is short enough to read.

import i18next from "i18next";
import { fmtTime } from "../i18n/format";

/** Ride lifecycle. `offered` exists only on the live board; Analytics never
 *  shows one, which is why its old copy of this map was missing it. Harmless
 *  in a shared map — a key for a status a page cannot render is never read. */
export const RIDE_STATUS_KEYS: Record<string, string> = {
  pending: "rideStatus.pending",
  offered: "rideStatus.offered",
  assigned: "rideStatus.assigned",
  driver_arriving: "rideStatus.driverArriving",
  in_progress: "rideStatus.inProgress",
  completed: "rideStatus.completed",
  cancelled: "rideStatus.cancelled",
  scheduled: "rideStatus.scheduled",
};

/** Falls back to the raw column value, as all three pages did: an unknown
 *  status is a schema change this build predates, and showing `foo` is more
 *  useful to whoever reports it than showing nothing. */
export function rideStatusLabel(status: string): string {
  const key = RIDE_STATUS_KEYS[status];
  return key ? i18next.t(key) : status;
}

export const CANCEL_REASON_KEYS: Record<string, string> = {
  timeout: "cancelReason.timeout",
  missed_window: "cancelReason.missedWindow",
  passenger_cancelled: "cancelReason.passengerCancelled",
  dispatch_cancelled: "cancelReason.dispatchCancelled",
  passenger_no_show: "cancelReason.passengerNoShow",
  system_cancelled: "cancelReason.systemCancelled",
};

export const SETTLEMENT_ROUTE_KEYS: Record<string, string> = {
  driver_transfer: "settlementRoute.driverTransfer",
  company_transfer: "settlementRoute.companyTransfer",
  platform_invoiced: "settlementRoute.platformInvoiced",
  transfer_failed: "settlementRoute.transferFailed",
  transfer_reversed: "settlementRoute.transferReversed",
  refund_reversed: "settlementRoute.refundReversed",
  refund_review: "settlementRoute.refundReview",
  reversal_failed: "settlementRoute.reversalFailed",
  retransfer_failed: "settlementRoute.retransferFailed",
  unsettled: "settlementRoute.unsettled",
};

export const REFUND_REASON_KEYS: Record<string, string> = {
  driver_fault: "refundReason.driverFault",
  platform_mistake: "refundReason.platformMistake",
  goodwill: "refundReason.goodwill",
};

/** Passenger-filed driver reports (`driver_reports.reason`). */
export const REPORT_REASON_KEYS: Record<string, string> = {
  unsafe_driving: "reportReason.unsafeDriving",
  rude_behavior: "reportReason.rudeBehavior",
  wrong_vehicle: "reportReason.wrongVehicle",
  wrong_driver: "reportReason.wrongDriver",
  vehicle_condition: "reportReason.vehicleCondition",
  cash_request: "reportReason.cashRequest",
  harassment: "reportReason.harassment",
  smoking: "reportReason.smoking",
  other: "reportReason.other",
};

/**
 * Mid-ride passenger escalations (`rides.flag_reason`), in TWO registers, and
 * they are not duplicates.
 *
 * `FLAG_REASON_KEYS` is the long form on the live dispatch card, where the
 * point is to tell a dispatcher mid-shift what is wrong in one glance
 * ("Passenger says they're NOT in the car"). `ESC_REASON_KEYS` is the terse
 * form in the Reports list, where the reason sits in a column beside a dozen
 * others. Same column, different jobs — do not collapse them into one.
 */
export const FLAG_REASON_KEYS: Record<string, string> = {
  not_in_car: "flagReason.notInCar",
  driver_never_came: "flagReason.driverNeverCame",
  wrong_destination: "flagReason.wrongDestination",
  felt_unsafe: "flagReason.feltUnsafe",
  other: "flagReason.other",
};

export const ESC_REASON_KEYS: Record<string, string> = {
  not_in_car: "escReason.notInCar",
  felt_unsafe: "escReason.feltUnsafe",
  driver_never_came: "escReason.driverNeverCame",
  wrong_destination: "escReason.wrongDestination",
  other: "escReason.other",
};

/** One order for both registers — they are the same column. */
export const FLAG_REASON_ORDER = [
  "not_in_car",
  "felt_unsafe",
  "driver_never_came",
  "wrong_destination",
  "other",
];

/**
 * A driver-filed no-show is the one cancellation where dispatch has to
 * arbitrate between two people who disagree, so the detail modal shows the
 * evidence rather than the verdict. Both timestamps are stamped server-side by
 * the lifecycle trigger (mgcj-app migration 20260741), not written by the
 * driver's app, and settle-ride will not accept a no-show until 5 minutes after
 * arrived_at with the driver inside the pickup geofence — so this is a record
 * of what happened, not a restatement of the driver's claim.
 *
 * Was duplicated verbatim in DashboardPage and AnalyticsPage, hardcoded tag
 * included, so the dates read English in a French UI in both.
 */
export function noShowEvidence(
  arrivedAt: string | null,
  noShowAt: string | null,
): string | null {
  if (!noShowAt) return null;
  const time = (d: Date) => fmtTime(d, { hour: "numeric", minute: "2-digit" });
  const filed = new Date(noShowAt);
  if (!arrivedAt) {
    return i18next.t("noShow.reportedNoArrival", { filed: time(filed) });
  }
  const arrived = new Date(arrivedAt);
  const mins = Math.round((filed.getTime() - arrived.getTime()) / 60_000);
  return i18next.t("noShow.waited", {
    arrived: time(arrived),
    filed: time(filed),
    count: mins,
  });
}
