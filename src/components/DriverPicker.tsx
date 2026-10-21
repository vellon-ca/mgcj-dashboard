// The assign-driver list used by the live-ride panel and the scheduled ride
// card. The order comes from lib/driverRanking.ts; the booking form uses the
// same ranking through driverOptionLabel(), since it is a <select>.
//
// Styles live with the other db-* classes in DashboardPage's <style> block.
import { useTranslation } from "react-i18next";
import type { RankedDriver } from "../lib/driverRanking";
import { distanceText, driverName, issueText } from "../lib/driverPickerText";

export default function DriverPicker({
  ranked,
  loading,
  onPick,
  onCancel,
}: {
  ranked: RankedDriver[];
  /** check-ride-conflicts still running: drive times and clashes may change the order. */
  loading: boolean;
  onPick: (r: RankedDriver) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const firstDemoted = ranked.findIndex((r) => r.demoted);

  return (
    <>
      <div className="db-assign-label">
        {t("dispatch.assignDriverLabel")}
        {loading ? ` ${t("dispatch.checkingConflicts")}` : ""}
      </div>
      {ranked.length === 0 && <div className="db-pick-empty">{t("picker.none")}</div>}
      {ranked.map((r, idx) => {
        const vehicle = [r.driver.vehicle_make, r.driver.vehicle_model].filter(Boolean).join(" ");
        const dist = distanceText(r, t);
        return (
          <div key={r.driver.id}>
            {idx === firstDemoted && <div className="db-pick-divider">{t("picker.lessSuitable")}</div>}
            <button
              className={`db-assign-driver-btn db-pick-row${r.demoted ? " demoted" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onPick(r);
              }}
            >
              <span className="db-pick-main">
                <span className="db-pick-name">
                  {driverName(r, t)}
                  {r.closest && <span className="db-pick-tag best">{t("picker.closest")}</span>}
                  {r.current && <span className="db-pick-tag">{t("picker.current")}</span>}
                </span>
                <span className="db-pick-meta">
                  {[
                    r.driver.car_number ? `${t("drivers.carShort")} ${r.driver.car_number}` : null,
                    vehicle || null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {r.issues.length > 0 && (
                  <span className="db-pick-issues">
                    {r.issues.map((i) => issueText(i, r, t)).join(" · ")}
                  </span>
                )}
              </span>
              {dist && <span className="db-pick-dist">{dist}</span>}
            </button>
          </div>
        );
      })}
      <button
        className="db-cancel-assign-btn"
        onClick={(e) => {
          e.stopPropagation();
          onCancel();
        }}
      >
        {t("common.cancel")}
      </button>
    </>
  );
}
