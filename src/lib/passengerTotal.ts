// What the passenger pays (or paid) for a ride: fare + booking fee, the one
// price passenger, driver and dispatch lists all show (mgcj-app
// booking-fee-design.md; the app's copy is src/lib/bookingTotal.ts
// ridePassengerTotal: change both). Display only. A ride with no fee reads
// exactly as it did before the fee existed. Analytics and revenue stay on the
// fare: the booking fee is not the company's revenue.
export function passengerTotal(ride: {
  status?: string | null;
  payment_method?: string | null;
  fare_estimate?: number | string | null;
  fare_final?: number | string | null;
  booking_fee?: number | string | null;
}): number | null {
  const fee = Number(ride.booking_fee ?? 0) || 0;
  if (ride.status === "completed" && ride.fare_final != null) {
    return Math.round((Number(ride.fare_final) + fee) * 100) / 100;
  }
  if (ride.fare_estimate == null || !(Number(ride.fare_estimate) > 0)) return null;
  const fare = Number(ride.fare_estimate);
  if (ride.payment_method === "cash") return fee > 0 ? Math.ceil(fare + fee) : fare;
  return Math.round((fare + fee) * 100) / 100;
}

export function passengerTotalText(ride: Parameters<typeof passengerTotal>[0], empty = "—"): string {
  const total = passengerTotal(ride);
  return total == null ? empty : `$${total.toFixed(2)}`;
}
