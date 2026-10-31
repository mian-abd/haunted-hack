import { Actor, Emittable, Ephemeral, Persisted } from "terse-sdk/actor"

import type { CallState, ElderBroadcast, ElderState, EventKind, Med, NewTimelineEvent, Profile, Status, TimelineEvent } from "./types.js"

const TIMELINE_CAP = 200
const STATUSES: readonly Status[] = ["ok", "watch", "urgent"]
const KINDS: readonly EventKind[] = ["call_due", "call_started", "call_ended", "med", "symptom", "teach_back", "vitals", "agent_msg", "status", "note"]

// The runtime does not check RPC arguments against the declared types, and LLM tool output flows in here, so guard what the dashboard depends on.
function need(ok: boolean, message: string): void {
    if (!ok) throw new Error(`ElderActor: ${message}`)
}

/** One durable actor per elder (id = elder id, e.g. "grandpa-joe"): memory, scheduler and live fan-out. */
export class ElderActor extends Actor<null, never, ElderBroadcast> {
    // Reassign (never mutate) these, or the change is not saved.
    @Persisted @Emittable profile: Profile | null = null
    @Persisted @Emittable meds: Med[] = []
    @Persisted @Emittable status: Status = "ok"
    @Persisted @Emittable statusReason = ""
    @Persisted @Emittable callState: CallState = "idle"
    @Persisted @Emittable nextCheckInAt: number | null = null
    @Persisted @Emittable timeline: TimelineEvent[] = []
    @Ephemeral private rearmed = false

    // shortcut: local `terse actor dev` (CLI 0.14.9) forgets a pending alarm on restart while the state survives, so re-arm
    // from the persisted nextCheckInAt once per wake (getState/logEvent/socket connect); drop it once local alarms persist.
    private async rearm(): Promise<void> {
        if (this.rearmed) return
        this.rearmed = true
        if (this.nextCheckInAt !== null) this.alarm.set(this.nextCheckInAt)
    }

    async onConnect(): Promise<void> {
        await this.rearm()
    }

    /** Full reset (demo reset): new profile and meds, empty timeline, no alarm. */
    async setup(profile: Profile, meds: Med[]): Promise<void> {
        need(typeof profile?.name === "string" && Array.isArray(meds), "setup(profile, meds) needs profile.name and a meds array")
        this.alarm.delete()
        this.profile = profile
        this.meds = meds
        this.status = "ok"
        this.statusReason = ""
        this.callState = "idle"
        this.nextCheckInAt = null
        this.timeline = []
    }

    async scheduleCheckIn(atMs: number, reason?: string): Promise<void> {
        atMs = Math.round(atMs) // the alarm needs an integer; Date.now() + 1.1 * 1000 is not one
        this.alarm.set(atMs)
        this.nextCheckInAt = atMs
        await this.logEvent({ kind: "note", from: "system", text: reason ? `Check-in scheduled: ${reason}` : "Check-in scheduled", data: { atMs } })
    }

    async onAlarm(): Promise<void> {
        this.callState = "due"
        this.nextCheckInAt = null // the alarm is spent; nothing is scheduled until the next scheduleCheckIn
        await this.logEvent({ kind: "call_due", from: "system", text: "Check-in call is due" })
        this.broadcast({ type: "call_due" })
    }

    async startCall(): Promise<void> {
        this.callState = "in_progress"
        await this.logEvent({ kind: "call_started", from: "system", text: "Check-in call started" })
    }

    async endCall(summary: string, mood?: string): Promise<void> {
        // Log first: a throw does not roll back earlier writes, and logEvent validates summary.
        await this.logEvent({ kind: "call_ended", from: "system", text: summary, data: mood ? { mood } : undefined })
        this.callState = "idle"
    }

    /** Case-insensitive name match. An unknown med is still logged, but no med changes. */
    async recordMed(name: string, taken: boolean, note?: string): Promise<void> {
        need(typeof name === "string" && typeof taken === "boolean", "recordMed(name: string, taken: boolean)")
        const key = name.trim().toLowerCase()
        const now = Date.now()
        this.meds = this.meds.map(med =>
            med.name.toLowerCase() !== key ? med : taken ? { ...med, lastTakenAt: now, missedCount: 0 } : { ...med, missedCount: med.missedCount + 1 }
        )
        const text = `${name}: ${taken ? "taken" : "not taken"}${note ? ` (${note})` : ""}`
        await this.logEvent({ kind: "med", from: "elder", text, data: { med: name, taken, ...(note ? { note } : {}) } })
    }

    /** The single way events enter the timeline: assigns id/ts, keeps the newest 200 (newest last). */
    async logEvent(e: NewTimelineEvent): Promise<TimelineEvent> {
        need(KINDS.includes(e?.kind) && typeof e.text === "string", `logEvent needs kind (one of ${KINDS.join("|")}) and text`)
        await this.rearm()
        const event: TimelineEvent = { ...e, id: crypto.randomUUID(), ts: Date.now() }
        this.timeline = [...this.timeline, event].slice(-TIMELINE_CAP)
        return event
    }

    async setStatus(status: Status, reason: string): Promise<void> {
        need(STATUSES.includes(status) && typeof reason === "string", `setStatus needs status (ok|watch|urgent) and a reason string`)
        this.status = status
        this.statusReason = reason
        await this.logEvent({ kind: "status", from: "system", text: reason, data: { urgency: status } })
    }

    async getState(): Promise<ElderState> {
        await this.rearm()
        const { profile, meds, status, statusReason, callState, nextCheckInAt, timeline } = this
        return { profile, meds, status, statusReason, callState, nextCheckInAt, timeline }
    }
}
