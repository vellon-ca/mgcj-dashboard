export interface Profile {
  id: string;
  company_id: string | null;
  name: string | null;
  phone: string | null;
  role: "passenger" | "driver" | "admin" | "dispatcher";
  avatar_url: string | null;
  is_active: boolean;
  deactivation_pending: boolean;
  deleted_at: string | null;
  created_at: string;
}

export interface Driver {
  id: string;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_year: number | null;
  plate_number: string | null;
  vehicle_class_id: string | null;
  is_active: boolean;
  current_lat: number | null;
  current_lng: number | null;
  updated_at: string;
  profile?: Profile;
}

export interface Ride {
  id: string;
  status:
    | "pending"
    | "offered"
    | "assigned"
    | "driver_arriving"
    | "in_progress"
    | "completed"
    | "cancelled"
    | "scheduled";
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_address: string;
  dropoff_lat: number;
  dropoff_lng: number;
  fare_estimate: number | null;
  fare_final: number | null;
  payment_method: string;
  scheduled_at: string | null;
  cancelled_reason: string | null;
  created_at: string;
  passenger_id: string;
  driver_id: string | null;
  vehicle_class_id: string | null;
  preferred_driver_id: string | null;
  preferred_driver_exclusive: boolean;
  declined_by: string[] | null;
  settlement_route: string | null;
  stripe_transfer_id: string | null;
  stripe_fee: number | null;
  platform_fee_percent_at_completion: number | null;
  settlement_resolved_at: string | null;
  settlement_resolved_by: string | null;
  refunded_amount_cents: number | null;
  transfer_reversed_cents: number | null;
  refunded_at: string | null;
  refund_reason: string | null;
  refund_absorbed_by: string | null;
  passenger?: Profile;
  driver?: Driver & { profile?: Profile };
}

export interface DriverInvite {
  id: string;
  phone: string;
  name: string;
  code: string;
  used: boolean;
  created_by: string | null;
  created_at: string;
}
