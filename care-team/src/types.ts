// Shared contract types for care-team/. Mirrors the ElderActor section of PLAN.md.

export type Status = "ok" | "watch" | "urgent"
export type Lane = "doctor" | "pharmacy" | "family"
export type CareAgent = "caretaker" | "doctor" | "pharmacy" | "family"
export type AgentName = CareAgent | "family-contact"
export type EventKind =
  | "call_due" | "call_started" | "call_ended" | "med" | "symptom"
  | "teach_back" | "vitals" | "agent_msg" | "status" | "note"

export const CARE_AGENTS: readonly CareAgent[] = ["caretaker", "doctor", "pharmacy", "family"]

export type EscalationKind = "symptom" | "refill" | "vitals" | "summary" | "teach_back"
export const ESCALATION_KINDS: readonly EscalationKind[] = ["symptom", "refill", "vitals", "summary", "teach_back"]

export interface Escalation {
  elderId: string
  kind: EscalationKind
  reason: string
  details?: Record<string, unknown>
}

/** Input accepted by ElderActor.logEvent (see PLAN.md). */
export interface LogEventInput {
  kind: EventKind
  text: string
  from?: AgentName | "elder" | "system"
  to?: AgentName
  data?: { lane?: Lane; urgency?: Status; [k: string]: unknown }
}

/** Steps of the care-team conversation. Each step maps to exactly one Care Feed lane. */
export type Step =
  | "case"              // caretaker -> doctor: triage packet
  | "triage"            // doctor -> caretaker: { urgency, actions[], recheckInSec }
  | "recheck"           // caretaker -> doctor: recheck call booked
  | "refill_request"    // caretaker -> pharmacy
  | "refill_confirmed"  // pharmacy -> caretaker
  | "family_brief"      // caretaker -> family agent
  | "family_draft"      // family agent -> family contact (the daughter)

export const STEP_LANE: Record<Step, Lane> = {
  case: "doctor",
  triage: "doctor",
  recheck: "doctor",
  refill_request: "pharmacy",
  refill_confirmed: "pharmacy",
  family_brief: "family",
  family_draft: "family",
}

/** Routing metadata attached to every Agent Relay message we send. */
export interface UncMeta {
  unc: 1
  elderId: string
  caseId: string
  step: Step
  to: AgentName
  lane: Lane
  urgency?: Status
  payload?: Record<string, unknown>
}

export interface Triage {
  urgency: Status
  reason: string
  actions: string[]
  recheckInSec: number | null
  needsRefill: string | null
  familyHeadline: string
}

// Hospital record (shape of supabase/seed.json, one patient's slice)
export interface Patient {
  id: string
  name: string
  age: number
  conditions: string[]
  family_name: string
  family_relation: string
  family_phone?: string
  primary_doctor: string
}
export interface Prescription {
  patient_id: string
  name: string
  dose: string
  times: string[]
  purpose: string
  prescriber: string
  refills_left: number
}
export interface ClinicalNote {
  patient_id: string
  author: string
  note: string
  created_at: string
}
export interface HospitalRecord {
  patient: Patient
  prescriptions: Prescription[]
  notes: ClinicalNote[]
  source: "supabase" | "seed.json" | "builtin"
}
