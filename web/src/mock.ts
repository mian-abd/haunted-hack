// ?mock=1: a fixture elder plus a sample timeline, fed through the same reducer as the live socket.
// Fictional demo data mirroring supabase/seed.json.
import type { ActorMessage, ElderState, TimelineEvent } from "./state"

type NewEvent = Omit<TimelineEvent, "id" | "ts">
type Step = [atMs: number, event: NewEvent, changes?: (s: ElderState) => Partial<ElderState>]

const msg = (from: TimelineEvent["from"], to: TimelineEvent["to"], lane: "doctor" | "pharmacy" | "family", text: string, extra = {}): NewEvent =>
  ({ kind: "agent_msg", from, to, text, data: { lane, ...extra } })

const med = (name: string, patch: object) => (s: ElderState) => ({ meds: s.meds.map(m => (m.name === name ? { ...m, ...patch } : m)) })

export function mockFixture(now: number): ElderState {
  return {
    profile: { name: "Joe Nguyen", age: 78, conditions: ["hypertension", "type 2 diabetes", "mild hearing loss"], family: { name: "Linh", relation: "daughter", phone: "555-0100" } },
    meds: [
      { name: "Amlodipine", dose: "5 mg", times: ["08:00"], purpose: "blood pressure", lastTakenAt: null, missedCount: 0 },
      { name: "Metformin", dose: "500 mg", times: ["08:00", "19:00"], purpose: "blood sugar, take with meals", lastTakenAt: null, missedCount: 0 },
      { name: "Atorvastatin", dose: "20 mg", times: ["21:00"], purpose: "cholesterol", lastTakenAt: null, missedCount: 0 },
    ],
    status: "ok",
    statusReason: "Stable at the last check-in",
    callState: "idle",
    nextCheckInAt: now + 15_000,
    timeline: [{ id: "mock-start", ts: now - 60_000, kind: "note", from: "system", text: "Check-in scheduled" }],
  }
}

const STEPS: Step[] = [
  [2500, { kind: "call_due", from: "system", text: "Check-in call is due" }, () => ({ callState: "due", nextCheckInAt: null })],
  [5000, { kind: "call_started", from: "system", text: "Check-in call started" }, () => ({ callState: "in_progress" })],
  [6500, { kind: "symptom", from: "elder", text: "Dizzy since this morning", data: { severity: "medium" } }],
  [8000, { kind: "med", from: "elder", text: "Amlodipine: not taken (ran out two days ago)", data: { med: "Amlodipine", taken: false } }, med("Amlodipine", { missedCount: 1 })],
  [9000, msg("caretaker", "doctor", "doctor", "New case: Joe, 78, dizzy since this morning. Out of amlodipine for 2 days. BP 150/92 at last visit.")],
  [10000, msg("caretaker", "pharmacy", "pharmacy", "Refill request: Amlodipine 5 mg. 0 refills left; 90-day renewal approved by Dr. Patel.")],
  [11500, msg("pharmacy", "caretaker", "pharmacy", "Amlodipine 5 mg is filled. Ready for pickup at 5 pm today.")],
  [12500, { kind: "med", from: "elder", text: "Metformin: taken", data: { med: "Metformin", taken: true } }, med("Metformin", { lastTakenAt: Date.now() })],
  [13500, msg("doctor", "caretaker", "doctor", "Triage: WATCH. Likely from the missed amlodipine. Restart today, do not double up. Rest, fluids, recheck in 2 hours. 911 for chest pain, fainting or slurred speech.", { urgency: "watch" })],
  [14500, { kind: "teach_back", from: "elder", text: "Metformin: said bedtime for the evening dose; corrected to with dinner", data: { med: "Metformin", understood: false } }],
  [15500, msg("family", "family-contact", "family", "Hi Linh, Dad is OK but dizzy today. He ran out of his blood pressure pills; the refill is ready at 5 pm. We'll call him again in 2 hours.")],
  [16500, { kind: "status", from: "system", text: "Dizzy and missed amlodipine; recheck in 2 hours", data: { urgency: "watch" } }, () => ({ status: "watch", statusReason: "Dizzy and missed amlodipine; recheck in 2 hours" })],
  [17000, { kind: "note", from: "system", text: "Check-in scheduled: recheck after dizziness" }, () => ({ nextCheckInAt: Date.now() + 2 * 3600_000 })],
  [18000, { kind: "call_ended", from: "system", text: "Dizzy, out of amlodipine (refill ready 5 pm). Metformin timing corrected." }, () => ({ callState: "idle" })],
]

export function playMock(dispatch: (m: ActorMessage) => void): () => void {
  let s = mockFixture(Date.now())
  dispatch({ type: "state", state: s })
  const timers = STEPS.map(([at, event, changes], i) =>
    setTimeout(() => {
      const update = { ...changes?.(s), timeline: [...s.timeline, { ...event, id: `mock-${i}`, ts: Date.now() }] }
      s = { ...s, ...update }
      if (event.kind === "call_due") dispatch({ type: "call_due" })
      dispatch({ type: "state_update", changes: update, removed: [] })
    }, at))
  return () => timers.forEach(clearTimeout)
}
