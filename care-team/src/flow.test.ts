import { test, expect, beforeAll } from "bun:test"

// Tests never touch the real database or OpenAI, even when care-team/.env (which bun test loads) has the keys.
delete process.env.SUPABASE_URL
delete process.env.SUPABASE_SERVICE_ROLE_KEY
delete process.env.OPENAI_API_KEY
import { localRelay } from "./relay"
import { fakeActor } from "./actor"
import { startCareTeam, invalid, channelFor } from "./flow"
import { dangerSign } from "./brain"
import type { HospitalRecord } from "./records"

const record: HospitalRecord = {
  source: "seed",
  patient: { id: "grandpa-joe", name: "Grandpa Joe", age: 82, conditions: ["hypertension"], family_name: "Maria", family_relation: "daughter", family_phone: "555-0101", primary_doctor: "Dr. Demo" },
  prescriptions: [{ patient_id: "grandpa-joe", name: "Amlodipine", dose: "5 mg", times: ["08:00"], purpose: "blood pressure", prescriber: "Dr. Demo", refills_left: 2 }],
  clinical_notes: [],
}

beforeAll(() => {
  delete process.env.OPENAI_API_KEY // force MOCK brains
  process.env.RECHECK_SECONDS = "90"
})

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5)
  expect(check()).toBe(true)
}

function team() {
  const actor = fakeActor()
  const { escalate } = startCareTeam(localRelay(), actor, async () => record)
  const events = () => actor.calls.filter((c) => c.method === "logEvent").map((c) => c.args[0])
  return { actor, escalate, events }
}

test("dizziness + missed Amlodipine: doctor, pharmacy and family lanes fill, status goes to watch, recheck is scheduled", async () => {
  const { actor, escalate, events } = team()
  const t0 = Date.now()
  escalate({ elderId: "grandpa-joe", kind: "symptom", reason: "dizzy, ran out of blood pressure pills", details: { severity: "medium" } })
  await until(() => events().length === 6 && actor.calls.some((c) => c.method === "scheduleCheckIn"))

  const hops = events().map((e) => `${e.from}>${e.to}:${e.data.lane}:${e.data.type}`)
  expect(hops.slice(0, 3)).toEqual([
    "caretaker>doctor:doctor:case",
    "doctor>caretaker:doctor:decision",
    "doctor>pharmacy:pharmacy:refill_request",
  ])
  // after the refill request, the pharmacy and the doctor's family notice run in parallel, so their order can vary
  expect(hops.slice(3).sort()).toEqual(["doctor>family:family:notify_family", "family>family-contact:family:family_message", "pharmacy>doctor:pharmacy:refill_ready"])
  expect(hops.indexOf("doctor>family:family:notify_family")).toBeLessThan(hops.indexOf("family>family-contact:family:family_message"))
  expect(events().every((e) => e.kind === "agent_msg" && e.data.relayId && e.data.caseId === events()[0].data.caseId)).toBe(true)

  const decision = events()[1].data
  expect(decision.urgency).toBe("watch")
  expect(decision.actions).toEqual(["Refill Amlodipine 5 mg", "Recheck in 2h", "Notify family", "Do not double the dose"])
  expect(events().find((e) => e.data.type === "refill_ready").text).toBe("Refill for Amlodipine 5 mg ready at 5 PM at the corner pharmacy.")
  expect(events().find((e) => e.data.type === "family_message").text).toStartWith("Hi Maria, Dad is OK but felt dizzy")

  const status = actor.calls.find((c) => c.method === "setStatus")!
  expect(status.args[0]).toBe("watch")
  const [atMs] = actor.calls.find((c) => c.method === "scheduleCheckIn")!.args
  expect(atMs - t0).toBeGreaterThanOrEqual(90_000)
  expect(atMs - t0).toBeLessThan(92_000)
})

test("refill goes straight to the pharmacy; summary and teach_back go to the family agent", async () => {
  const { actor, escalate, events } = team()
  escalate({ elderId: "grandpa-joe", kind: "refill", reason: "out of pills", details: { med: "amlodipine" } })
  escalate({ elderId: "grandpa-joe", kind: "summary", reason: "call went fine" })
  escalate({ elderId: "grandpa-joe", kind: "teach_back", reason: "said metformin at bedtime" })
  await until(() => events().length === 6)
  const hops = events().map((e) => `${e.from}>${e.to}:${e.data.lane}`).sort()
  expect(hops).toEqual([
    "caretaker>family:family", "caretaker>family:family", "caretaker>pharmacy:pharmacy",
    "family>family-contact:family", "family>family-contact:family", "pharmacy>caretaker:pharmacy",
  ])
  expect(actor.calls.some((c) => c.method === "setStatus")).toBe(false) // no doctor decision, no status change
})

test("safety floor: heart rate 140 is urgent, family is told to come now, quick recheck, no refill", async () => {
  const { actor, escalate, events } = team()
  const t0 = Date.now()
  escalate({ elderId: "grandpa-joe", kind: "vitals", reason: "Heart rate 140 bpm", details: { heartRate: 140 } })
  await until(() => events().some((e) => e.data.type === "family_message") && actor.calls.some((c) => c.method === "scheduleCheckIn"))

  const decision = events().find((e) => e.data.type === "decision")
  expect(decision.data.urgency).toBe("urgent")
  expect(decision.text).toContain("URGENT")
  expect(actor.calls.find((c) => c.method === "setStatus")!.args[0]).toBe("urgent")
  const [atMs] = actor.calls.find((c) => c.method === "scheduleCheckIn")!.args
  expect(atMs - t0).toBeLessThan(62_000) // URGENT_RECHECK_SECONDS defaults to 60
  expect(events().some((e) => e.data.type === "refill_request")).toBe(false)
  expect(events().find((e) => e.data.type === "family_message").text).toContain("go to him now")
})

test("safety floor: the LLM cannot lower urgency for chest pain", async () => {
  const realFetch = globalThis.fetch
  process.env.OPENAI_API_KEY = "test-key"
  const ok = { urgency: "ok", reason: "fine", actions: [], refill_med: null, notify_family: false, recheck: false, message: "All fine." }
  globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: JSON.stringify(ok) } }] })) as unknown as typeof fetch
  try {
    const { actor, escalate, events } = team()
    escalate({ elderId: "grandpa-joe", kind: "symptom", reason: "chest pain since breakfast", details: { severity: "medium" } })
    await until(() => actor.calls.some((c) => c.method === "setStatus"))
    expect(events().find((e) => e.data.type === "decision").data.urgency).toBe("urgent")
    expect(actor.calls.find((c) => c.method === "setStatus")!.args[0]).toBe("urgent")
  } finally {
    globalThis.fetch = realFetch
    delete process.env.OPENAI_API_KEY
  }
})

test("one case per call: the demo call is one thread with exactly one refill", async () => {
  const { escalate, events } = team()
  const ids = [
    escalate({ elderId: "grandpa-joe", kind: "symptom", reason: "dizzy, ran out of blood pressure pills", details: { severity: "medium" } }),
    escalate({ elderId: "grandpa-joe", kind: "refill", reason: "Refill needed: Amlodipine", details: { med: "Amlodipine" } }),
    escalate({ elderId: "grandpa-joe", kind: "teach_back", reason: "Teach-back not understood: Metformin (said bedtime)", details: { med: "Metformin" } }),
    escalate({ elderId: "grandpa-joe", kind: "summary", reason: "Dizzy, out of Amlodipine, mixed up Metformin timing", details: { mood: "tired" } }),
  ]
  expect(new Set(ids).size).toBe(1)
  const count = (type: string) => events().filter((e) => e.data.type === type).length
  await until(() => count("refill_ready") === 1 && count("family_message") === 3 && count("decision") === 1)
  await Bun.sleep(100) // give a duplicate refill time to show up
  expect(count("refill_ready")).toBe(1)
  expect(count("refill_request")).toBe(0) // the direct refill came first, so the doctor does not ask again
  expect(events().every((e) => e.data.caseId === ids[0])).toBe(true)
})

test("escalate body validation and channel names", () => {
  expect(invalid({ elderId: "grandpa-joe", kind: "symptom", reason: "dizzy" })).toBeNull()
  expect(invalid({ elderId: "grandpa-joe", kind: "symptom", reason: "dizzy", details: { severity: "high" } })).toBeNull()
  expect(invalid(null)).not.toBeNull()
  expect(invalid({ elderId: "", kind: "symptom", reason: "x" })).not.toBeNull()
  expect(invalid({ elderId: "a", kind: "party", reason: "x" })).not.toBeNull()
  expect(invalid({ elderId: "a", kind: "refill", reason: "" })).not.toBeNull()
  expect(invalid({ elderId: "a", kind: "refill", reason: "x", details: [1] })).not.toBeNull()
  expect(channelFor("grandpa-joe")).toBe("care-grandpa-joe")
  expect(channelFor("Grandpa Joe!")).toBe("care-grandpa-joe-")
})

test("falling asleep is not a fall", () => {
  expect(dangerSign({ reason: "I fell asleep early last night", details: {} })).toBeNull()
  expect(dangerSign({ reason: "I fell in the kitchen", details: {} })).toContain("fell in the kitchen")
})
