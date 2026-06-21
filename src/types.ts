export interface Profile {
  id: string;
  company_id: string | null;
  name: string | null;
  phone: string | null;
  role: "passenger" | "driver" | "admin";
  created_at: string;
}

export interface Driver {
  id: string;
  vehicle_make: string | null;
  vehicle_model: string | null;
  plate_number: string | null;
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
  created_at: string;
  passenger_id: string;
  driver_id: string | null;
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
