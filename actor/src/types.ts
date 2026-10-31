// ElderActor contract types (PLAN.md "Shared contract"). Copy these into other folders, or use the
// generated client's types (actors.ElderActor.State etc.) after `terse actor generate`.

export type Status = "ok" | "watch" | "urgent"

export type CallState = "idle" | "due" | "in_progress"

export type Med = {
    name: string
    dose: string
    times: string[]
    purpose: string
    lastTakenAt: number | null
    missedCount: number
}

export type Profile = {
    name: string
    age: number
    conditions: string[]
    family: { name: string; relation: string; phone?: string }
}

export type EventKind = "call_due" | "call_started" | "call_ended" | "med" | "symptom" | "teach_back" | "vitals" | "agent_msg" | "status" | "note"

export type AgentName = "caretaker" | "doctor" | "pharmacy" | "family" | "family-contact"

export type TimelineEvent = {
    id: string
    ts: number
    kind: EventKind
    text: string
    from?: AgentName | "elder" | "system"
    to?: AgentName
    data?: { lane?: "doctor" | "pharmacy" | "family"; urgency?: Status; [k: string]: unknown }
}

/** What logEvent() takes: a TimelineEvent without id and ts (the actor assigns them). */
export type NewTimelineEvent = Omit<TimelineEvent, "id" | "ts">

/** Every emitted field; returned by getState() and sent as the socket "state" message. */
export type ElderState = {
    profile: Profile | null
    meds: Med[]
    status: Status
    statusReason: string
    callState: CallState
    nextCheckInAt: number | null
    timeline: TimelineEvent[]
}

/** Custom socket broadcasts (besides the built-in "state" / "state_update"). */
export type ElderBroadcast = { type: "call_due" }
