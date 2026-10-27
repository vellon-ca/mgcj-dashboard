import { supabase } from "./supabase";

// The fare for a trip, from price_trip() — the SQL function the server charges
// with (mgcj-app migration 20261027010000). The dashboard used to compute
// `(base + km × rate) × (1 + surcharge)` itself in fareForDistance; per-area
// pricing (a fixed airport fare, service-areas-plan.md §10) lives only in that
// function, so a local copy of the formula would quote the per-km price for a
// ride the server holds at the flat one.
//
// `metres` is the distance this page already measured to show the route. The
// fare is pre-discount. Cash rounds up to the whole dollar so nobody needs
// change; card stays at the cent, which is what edit-ride and
// create-payment-intent charge.
//
// Returns null when the trip could not be priced; callers show that as a
// failed estimate rather than a number from fallback rates.
export async function priceTrip(args: {
  companyId: string;
  pickup: { lat: number; lng: number };
  dropoff: { lat: number; lng: number };
  metres: number;
  vehicleClassId: string | null;
  paymentMethod: string;
}): Promise<number | null> {
  const { data, error } = await supabase.rpc("price_trip", {
    p_company_id: args.companyId,
    p_pickup_lat: args.pickup.lat,
    p_pickup_lng: args.pickup.lng,
    p_dropoff_lat: args.dropoff.lat,
    p_dropoff_lng: args.dropoff.lng,
    p_metres: args.metres,
    p_vehicle_class_id: args.vehicleClassId || null,
  });
  if (error || !data) {
    console.error("[priceTrip] price_trip failed:", error);
    return null;
  }
  const fare = Number((data as { fare: number | string }).fare);
  if (!Number.isFinite(fare) || fare <= 0) return null;
  return args.paymentMethod === "cash" ? Math.ceil(fare) : Math.round(fare * 100) / 100;
}
