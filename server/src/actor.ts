// Bridge to the ElderActor (actor/src/actor.ts) through the Terse generated client in ../generated.
// Falls back to an in-memory fake when TERSE_FAKE=1 or when the generated client is missing.
import { existsSync } from "node:fs"

// Types copied from the PLAN.md contract.
export type Status = "ok" | "watch" | "urgent"
export type Med = { name: string; dose: string; times: string[]; purpose: string; lastTakenAt: number | null; missedCount: number }
export type Profile = { name: string; age: number; conditions: string[]; family: { name: string; relation: string; phone?: string } }
export type EventKind = "call_due" | "call_started" | "call_ended" | "med" | "symptom" | "teach_back" | "vitals" | "agent_msg" | "status" | "note"
export type AgentName = "caretaker" | "doctor" | "pharmacy" | "family" | "family-contact"
export type TimelineEvent = {
  id: string; ts: number; kind: EventKind; text: string
  from?: AgentName | "elder" | "system"; to?: AgentName
  data?: { lane?: "doctor" | "pharmacy" | "family"; urgency?: Status; [k: string]: unknown }
}
export type NewEvent = Omit<TimelineEvent, "id" | "ts">
export type ElderState = {
  profile: Profile | null; meds: Med[]; status: Status; statusReason: string
  callState: "idle" | "due" | "in_progress"; nextCheckInAt: number | null; timeline: TimelineEvent[]
}
// The contract's methods minus onAlarm: a runtime hook the generated client does not expose.
export type Elder = {
  setup(profile: Profile, meds: Med[]): Promise<unknown>
  scheduleCheckIn(atMs: number, reason?: string): Promise<unknown>
  startCall(): Promise<unknown>
  endCall(summary: string, mood?: string): Promise<unknown>
  recordMed(name: string, taken: boolean, note?: string): Promise<unknown>
  logEvent(e: NewEvent): Promise<TimelineEvent>
  setStatus(status: Status, reason: string): Promise<unknown>
  getState(): Promise<ElderState>
}

const GENERATED = "../generated/index.js" // written by `terse actor generate` run from server/
export const isFake = process.env.TERSE_FAKE === "1" || !existsSync(new URL("../generated", import.meta.url))
const { actors } = isFake ? { actors: null } : await import(GENERATED)

export function elder(elderId: string): Elder {
  return isFake ? fakeElder(elderId) : actors.ElderActor.get(elderId)
}

export async function prepareWebsocket(elderId: string): Promise<{ websocketUrl: string }> {
  if (isFake) throw new Error("fake actor has no websocket")
  return actors.ElderActor.prepareWebsocket({ actorId: elderId, metadata: null }) // ElderActor's socket metadata type is null
}

// In-memory fake that mirrors actor/src/actor.ts. No websocket, so broadcasts are dropped.
const fakes = new Map<string, ElderState>()
const alarms = new Map<string, Timer>()
const blank = (): ElderState => ({ profile: null, meds: [], status: "ok", statusReason: "", callState: "idle", nextCheckInAt: null, timeline: [] })

function fakeElder(id: string): Elder {
  const s = fakes.get(id) ?? fakes.set(id, blank()).get(id)!
  const log = (e: NewEvent): TimelineEvent => {
    const ev = { id: crypto.randomUUID(), ts: Date.now(), ...e }
    s.timeline = [...s.timeline, ev].slice(-200)
    return ev
  }
  const onAlarm = () => { s.callState = "due"; s.nextCheckInAt = null; log({ kind: "call_due", from: "system", text: "Check-in call is due" }) }
  return {
    async setup(profile, meds) { clearTimeout(alarms.get(id)); Object.assign(s, blank(), { profile, meds }) },
    async scheduleCheckIn(atMs, reason) {
      clearTimeout(alarms.get(id))
      alarms.set(id, setTimeout(onAlarm, Math.max(0, atMs - Date.now())).unref())
      s.nextCheckInAt = atMs
      log({ kind: "note", from: "system", text: reason ? `Check-in scheduled: ${reason}` : "Check-in scheduled", data: { atMs } })
    },
    async startCall() { s.callState = "in_progress"; log({ kind: "call_started", from: "system", text: "Check-in call started" }) },
    async endCall(summary, mood) { s.callState = "idle"; log({ kind: "call_ended", from: "system", text: summary, data: mood ? { mood } : undefined }) },
    async recordMed(name, taken, note) {
      const key = name.trim().toLowerCase()
      s.meds = s.meds.map(m => m.name.toLowerCase() !== key ? m
        : taken ? { ...m, lastTakenAt: Date.now(), missedCount: 0 } : { ...m, missedCount: m.missedCount + 1 })
      log({ kind: "med", from: "elder", text: `${name}: ${taken ? "taken" : "not taken"}${note ? ` (${note})` : ""}`, data: { med: name, taken, ...(note ? { note } : {}) } })
    },
    async logEvent(e) { return log(e) },
    async setStatus(status, reason) { s.status = status; s.statusReason = reason; log({ kind: "status", text: reason, from: "system", data: { urgency: status } }) },
    async getState() { return structuredClone(s) },
  }
}
