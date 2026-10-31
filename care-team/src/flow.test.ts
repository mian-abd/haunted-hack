import { test, expect, beforeAll } from "bun:test"
import { localRelay } from "./relay"
import { fakeActor } from "./actor"
import { startCareTeam, invalid, channelFor } from "./flow"
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
  expect(hops.slice(0, 4)).toEqual([
    "caretaker>doctor:doctor:case",
    "doctor>caretaker:doctor:decision",
    "doctor>pharmacy:pharmacy:refill_request",
    "doctor>family:family:notify_family",
  ])
  expect(hops.slice(4).sort()).toEqual(["family>family-contact:family:family_message", "pharmacy>doctor:pharmacy:refill_ready"])
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
