import { supabase } from "./supabase";

export type DispatchEventType =
  | "ride.created"
  | "ride.cancelled"
  | "ride.assigned"
  | "ride.reassigned"
  | "ride.scheduled_modified"
  | "ride.notes_added"
  | "ride.fare_changed"
  | "driver.suspended"
  | "driver.reactivated"
  | "driver.deleted"
  | "invite.created"
  | "invite.revoked"
  | "discount.created"
  | "discount.deactivated"
  | "discount.deleted"
  | "report.reviewed"
  | "announcement.drivers"
  | "announcement.passengers"
  | "escalation.acknowledged"
  | "export.csv"
  | "export.pdf"
  | "invoice.printed";

export async function logDispatchEvent(params: {
  companyId: string;
  dispatcherId: string;
  eventType: DispatchEventType;
  rideId?: string | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabase.from("dispatch_events").insert({
    company_id: params.companyId,
    dispatcher_id: params.dispatcherId,
    event_type: params.eventType,
    ride_id: params.rideId ?? null,
    details: params.details ?? {},
  });
  if (error) console.error("[logDispatchEvent]", params.eventType, error.message);
}
