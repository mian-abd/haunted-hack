// Contract types from PLAN.md (same as actor/src/types.ts) plus the pure logic the screen renders from.

export type Status = "ok" | "watch" | "urgent"
export type CallState = "idle" | "due" | "in_progress"
export type Med = { name: string; dose: string; times: string[]; purpose: string; lastTakenAt: number | null; missedCount: number }
export type Profile = { name: string; age: number; conditions: string[]; family: { name: string; relation: string; phone?: string } }
export type EventKind = "call_due" | "call_started" | "call_ended" | "med" | "symptom" | "teach_back" | "vitals" | "agent_msg" | "status" | "note"
export type AgentName = "caretaker" | "doctor" | "pharmacy" | "family" | "family-contact"
export type Lane = "doctor" | "pharmacy" | "family"
export type TimelineEvent = {
  id: string
  ts: number
  kind: EventKind
  text: string
  from?: AgentName | "elder" | "system"
  to?: AgentName
  data?: { lane?: Lane; urgency?: Status; [k: string]: unknown }
}
export type ElderState = {
  profile: Profile | null
  meds: Med[]
  status: Status
  statusReason: string
  callState: CallState
  nextCheckInAt: number | null
  timeline: TimelineEvent[]
}

// Terse actor socket wire format (durable-actors src/sockets/mod.rs) plus the actor's custom call_due broadcast.
export type ActorMessage =
  | { type: "state"; state: Partial<ElderState>; version?: number }
  | { type: "state_update"; changes: Partial<ElderState>; removed?: string[]; version?: number }
  | { type: "call_due" }

export const EMPTY: ElderState = { profile: null, meds: [], status: "ok", statusReason: "", callState: "idle", nextCheckInAt: null, timeline: [] }

export function reduce(s: ElderState, m: ActorMessage): ElderState {
  switch (m.type) {
    case "state":
      return { ...EMPTY, ...m.state }
    case "state_update": {
      const next = { ...s, ...m.changes }
      // A removed field falls back to its default so the UI never sees undefined.
      for (const k of m.removed ?? []) if (Object.hasOwn(EMPTY, k)) Object.assign(next, { [k]: EMPTY[k as keyof ElderState] })
      return next
    }
    case "call_due":
      return { ...s, callState: "due" }
    default:
      return s
  }
}

export const LANES: Lane[] = ["doctor", "pharmacy", "family"]

/** agent_msg events per lane, newest first (the timeline is newest last). */
export function groupLanes(timeline: TimelineEvent[]): Record<Lane, TimelineEvent[]> {
  const out: Record<Lane, TimelineEvent[]> = { doctor: [], pharmacy: [], family: [] }
  for (const e of timeline) {
    const lane = e.data?.lane
    if (e.kind === "agent_msg" && lane && LANES.includes(lane)) out[lane].unshift(e)
  }
  return out
}

export const agentThread = (timeline: TimelineEvent[]) => timeline.filter(e => e.kind === "agent_msg")

const SIGNAL_KINDS: EventKind[] = ["med", "symptom", "teach_back", "vitals", "status"]
/** Non-agent events shown as chips, newest first. */
export const signals = (timeline: TimelineEvent[]) => timeline.filter(e => SIGNAL_KINDS.includes(e.kind)).reverse()

export type Tone = "good" | "warn" | "bad" | "neutral"
export function tone(e: TimelineEvent): Tone {
  const d: NonNullable<TimelineEvent["data"]> = e.data ?? {}
  const level = d.urgency ?? d.severity
  if (d.taken === false || level === "high" || level === "urgent") return "bad"
  if (d.understood === false || level === "medium" || level === "watch") return "warn"
  if (d.taken === true || d.understood === true || level === "ok") return "good"
  return "neutral"
}

/** recordMed resets missedCount when a dose is taken, so any count means the latest report was a miss. */
export function medBadge(m: Med, now: number): "taken" | "missed" | "due" {
  if (m.missedCount > 0) return "missed"
  if (m.lastTakenAt != null && new Date(m.lastTakenAt).toDateString() === new Date(now).toDateString()) return "taken"
  return "due"
}

export function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, "0")
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`
}

export function countdown(at: number | null, now: number): string {
  if (at == null) return "Not scheduled"
  return at - now <= 0 ? "Now" : mmss(at - now + 999) // round up so it reads 0:15 → 0:01, never 0:00 early
}
