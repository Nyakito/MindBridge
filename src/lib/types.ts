export type UserRole = 'client' | 'therapist' | 'admin'

export interface Profile {
  id: string
  role: UserRole
  full_name: string
  phone: string | null
  country: string | null
  onboarding_completed: boolean
  created_at: string
}

export type VerificationStatus =
  | 'pending'
  | 'under_review'
  | 'approved'
  | 'rejected'
  | 'suspended'

export interface Therapist {
  id: string
  full_name: string
  professional_title: string
  biography: string
  qualifications: string[]
  specializations: string[]
  languages: string[]
  years_experience: number
  session_duration_minutes: number
  session_fee_cents: number
  session_terms: string
  consultation_format: 'online' | 'in_person' | 'both'
  verification_status: VerificationStatus
  photo_url: string | null
}

export interface AvailabilitySlot {
  id: string
  starts_at: string
  ends_at: string
}

export interface Appointment {
  id: string
  starts_at: string
  ends_at: string
  status: 'pending' | 'confirmed' | 'cancelled' | 'completed'
  therapist_name?: string
  client_name?: string
  accepted_session_terms?: string
  accepted_session_fee_cents?: number
  platform_fee_cents?: number
}

export interface Entitlement {
  kind: 'single_session'
  remaining_sessions: number | null
  expires_at: string | null
}

export interface ClientAccess {
  has_directory_access: boolean
  free_sessions_remaining: number
  bookable_sessions_remaining: number
  membership_expires_at: string | null
}
