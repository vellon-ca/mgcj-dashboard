// Words for a ranked driver: shared by the DriverPicker list and the booking
// form's <select>, so both say the same thing about the same driver.
import type { TFunction } from "i18next";
import { fmtTime } from "../i18n/format";
import type { Issue, RankedDriver } from "./driverRanking";

export function distanceText(r: RankedDriver, t: TFunction): string | null {
  const d = r.distance;
  if (!d) return null;
  if (d.kind === "drive") return t("picker.driveTime", { mins: d.mins, km: d.km.toFixed(1) });
  if (d.kind === "approx") return t("picker.approxKm", { km: d.km.toFixed(1) });
  return t("picker.nowKm", { km: d.km.toFixed(1) });
}

export function issueText(i: Issue, r: RankedDriver, t: TFunction): string {
  switch (i) {
    case "clash": {
      const c = r.clash!;
      const when = fmtTime(c.commitment_at, { hour: "numeric", minute: "2-digit" });
      if (c.direction === "before") {
        return c.minutes_short != null
          ? t("picker.lateFromEarlier", { count: c.minutes_short, when })
          : t("picker.earlierRide", { when });
      }
      return c.minutes_short != null
        ? t("dispatch.lateForBy", { count: c.minutes_short, when })
        : t("dispatch.dueAt", { when });
    }
    case "declined": return t("picker.declined");
    case "vehicle":  return t("picker.vehicle");
    case "away":     return t("dispatch.awaySuffix");
    case "offShift": return t("picker.offShift");
    case "onRide":   return t("picker.onRide");
  }
}

export function driverName(r: RankedDriver, t: TFunction): string {
  return r.driver.profile?.name ?? t("rideDetail.driver");
}

/** One line of text, for the booking form's <select>. */
export function driverOptionLabel(r: RankedDriver, t: TFunction): string {
  return [
    driverName(r, t),
    r.driver.car_number ? `${t("drivers.carShort")} ${r.driver.car_number}` : null,
    distanceText(r, t),
    ...r.issues.map((i) => issueText(i, r, t)),
  ]
    .filter(Boolean)
    .join(" · ");
}
