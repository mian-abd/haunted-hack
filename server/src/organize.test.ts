import { afterAll, beforeEach, expect, test } from "bun:test"
import { organizeRecord, toRows } from "./organize"

// bun test loads server/.env: never call the real OpenAI here.
const realFetch = globalThis.fetch
const realEnv = { key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL }
let sent: any = null
let auth = ""
let reply: () => Response = () => new Response("no", { status: 500 })

beforeEach(() => {
  sent = null
  auth = ""
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_MODEL
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    expect(String(url)).toBe("https://api.openai.com/v1/chat/completions")
    sent = JSON.parse(String(init.body))
    auth = new Headers(init.headers).get("authorization") ?? ""
    return reply()
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  for (const [k, v] of [["OPENAI_API_KEY", realEnv.key], ["OPENAI_MODEL", realEnv.model]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const openai = (content: unknown) => () => Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] })

const DISCHARGE = `DISCHARGE SUMMARY
Patient: Joe Nguyen, 78
Admitted: 2026-10-20   Discharged: 2026-10-24

Discharge Diagnoses:
- Congestive heart failure, mild
- Hypertension

Allergies: Penicillin (rash), sulfa drugs

Medications:
1. Furosemide 20 mg at 08:00 for fluid
2. Metformin 500 mg twice daily at 8 am and 6 pm (diabetes)
3. Amlodipine 5 mg at 08:00 for blood pressure, refills: 0

Follow-up:
- Cardiology clinic in 1 week
- Weigh every morning; call if up more than 2 lb

Hospital course: Admitted with shortness of breath, improved with diuretics.`

test("openai path sends a strict JSON request and parses the reply", async () => {
  process.env.OPENAI_API_KEY = "sk-test"
  reply = openai({
    summary: "Joe was treated for heart failure. He goes home on a water pill.",
    conditions: ["Heart failure"], allergies: ["Penicillin"],
    medications: [{ name: "Furosemide", dose: "20 mg", times: ["08:00"], purpose: "fluid" }],
    notes: [], follow_ups: ["Cardiology in 1 week"],
  })
  const r = await organizeRecord("Furosemide 20 mg at 08:00", { name: "Joe Nguyen", conditions: ["hypertension"] })
  expect(r.source).toBe("openai")
  expect(auth).toBe("Bearer sk-test")
  expect(sent).toMatchObject({ model: "gpt-6-luna", reasoning_effort: "none", response_format: { type: "json_object" } })
  expect(sent.messages[0].content).toContain("Extract ONLY what the document states")
  expect(sent.messages[1].content).toContain("Joe Nguyen")
  expect(sent.messages[1].content).toContain("Furosemide 20 mg at 08:00")
  expect(r.organized).toEqual({
    summary: "Joe was treated for heart failure. He goes home on a water pill.",
    conditions: ["Heart failure"], allergies: ["Penicillin"],
    medications: [{ name: "Furosemide", dose: "20 mg", times: ["08:00"], purpose: "fluid" }],
    notes: [], follow_ups: ["Cardiology in 1 week"],
  })
})

test("OPENAI_MODEL overrides the model and the input is capped at 12000 chars", async () => {
  process.env.OPENAI_API_KEY = "sk-test"
  process.env.OPENAI_MODEL = "gpt-test"
  reply = openai({})
  await organizeRecord("a".repeat(20000))
  expect(sent.model).toBe("gpt-test")
  expect(sent.messages[1].content.match(/a+$/)[0].length).toBe(12000)
})

test("rules fallback reads a sample discharge summary", async () => {
  const r = await organizeRecord(DISCHARGE, { name: "Joe Nguyen" })
  expect(r.source).toBe("rules")
  expect(sent).toBeNull() // no key: no network call
  expect(r.organized.conditions).toEqual(["Congestive heart failure, mild", "Hypertension"])
  expect(r.organized.allergies).toEqual(["Penicillin (rash)", "sulfa drugs"])
  expect(r.organized.medications).toEqual([
    { name: "Furosemide", dose: "20 mg", times: ["08:00"], purpose: "fluid" },
    { name: "Metformin", dose: "500 mg", times: ["08:00", "18:00"], purpose: "diabetes" },
    { name: "Amlodipine", dose: "5 mg", times: ["08:00"], purpose: "blood pressure", refills_left: 0 },
  ])
  expect(r.organized.follow_ups).toEqual(["Cardiology clinic in 1 week", "Weigh every morning; call if up more than 2 lb"])
  expect(r.organized.notes).toContain("Hospital course: Admitted with shortness of breath, improved with diuretics.")
  expect(r.organized.summary).toBe("Found 3 medications, 2 allergies, 2 conditions and 2 follow-ups in this document.")
})

test("an OpenAI error or bad JSON falls back to rules", async () => {
  process.env.OPENAI_API_KEY = "sk-test"
  reply = () => new Response("down", { status: 500 })
  expect((await organizeRecord(DISCHARGE)).source).toBe("rules")
  reply = () => Response.json({ choices: [{ message: { content: "not json" } }] })
  const r = await organizeRecord(DISCHARGE)
  expect(r.source).toBe("rules")
  expect(r.organized.medications).toHaveLength(3)
})

test("model output is clamped: strings only, 20 items, 300 chars, HH:MM times", async () => {
  process.env.OPENAI_API_KEY = "sk-test"
  reply = openai({
    summary: "x".repeat(500),
    conditions: Array.from({ length: 30 }, (_, i) => `c${i}`.padEnd(400, "y")),
    allergies: [1, null, {}, "Penicillin", ""],
    medications: [{ name: "", dose: "1 mg" }, "junk", { name: "Furosemide", dose: "20 mg", times: ["8 am", "morning", "20:00"], purpose: "fluid", refills_left: "2" }],
    notes: "not an array",
  })
  const { organized: o } = await organizeRecord("anything")
  expect(o.summary).toHaveLength(300)
  expect(o.conditions).toHaveLength(20)
  expect(o.conditions.every(c => c.length === 300)).toBe(true)
  expect(o.allergies).toEqual(["1", "Penicillin"])
  expect(o.medications).toEqual([{ name: "Furosemide", dose: "20 mg", times: ["08:00", "20:00"], purpose: "fluid", refills_left: 2 }])
  expect(o.notes).toEqual([])
  expect(o.follow_ups).toEqual([])
})

test("toRows shapes prescriptions and one combined clinical note", () => {
  const rows = toRows("grandpa-joe", "Dr. Patel", {
    summary: "Joe was treated for heart failure.",
    conditions: ["Heart failure", "Hypertension"], allergies: ["Penicillin"],
    medications: [
      { name: "Furosemide", dose: "20 mg", times: ["08:00"], purpose: "fluid" },
      { name: "Amlodipine", dose: "5 mg", times: ["08:00"], purpose: "blood pressure", refills_left: 3 },
    ],
    notes: ["ignored in the note"], follow_ups: ["Cardiology in 1 week"],
  })
  expect(rows.prescriptions).toEqual([
    { patient_id: "grandpa-joe", name: "Furosemide", dose: "20 mg", times: ["08:00"], purpose: "fluid", prescriber: "Dr. Patel", refills_left: null },
    { patient_id: "grandpa-joe", name: "Amlodipine", dose: "5 mg", times: ["08:00"], purpose: "blood pressure", prescriber: "Dr. Patel", refills_left: 3 },
  ])
  expect(rows.clinical_notes).toEqual([{
    patient_id: "grandpa-joe", author: "Dr. Patel",
    note: "Joe was treated for heart failure. Allergies: Penicillin. Conditions: Heart failure, Hypertension. Follow-ups: Cardiology in 1 week.",
  }])
  expect(toRows("grandpa-joe", "Dr. Patel", { summary: "", conditions: [], allergies: [], medications: [], notes: [], follow_ups: [] }))
    .toEqual({ prescriptions: [], clinical_notes: [] })
})
