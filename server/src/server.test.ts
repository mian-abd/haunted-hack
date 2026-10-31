import { afterAll, beforeEach, expect, test } from "bun:test"

// Fake actor + stubbed fetch. Env must be set before the modules load.
process.env.TERSE_FAKE = "1"
process.env.CARE_TEAM_URL = "http://care.test"
const { handle, supabaseAuth } = await import("./server")
const { elder } = await import("./actor")

const ID = "grandpa-joe"
const realFetch = globalThis.fetch
let calls: { url: string; init: RequestInit }[] = []
let careTeamDown = false
let nextResponse = () => new Response("{}", { status: 202 })

beforeEach(async () => {
  calls = []
  careTeamDown = false
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    if (careTeamDown && String(url).startsWith("http://care.test")) throw new Error("connect ECONNREFUSED")
    return nextResponse()
  }) as typeof fetch
  const res = await post("/api/demo/reset", { elderId: ID })
  expect(res.status).toBe(200)
  calls = []
})
afterAll(() => { globalThis.fetch = realFetch })

const post = (path: string, body: unknown, origin = "http://localhost:5173") =>
  handle(new Request(`http://server.test${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) }))
const tool = async (name: string, args: unknown) => {
  const res = await post("/api/tool", { elderId: ID, name, args })
  return { status: res.status, ...(await res.json()) as { output: string; error?: string } }
}
const escalations = () => calls.filter(c => c.url === "http://care.test/escalate").map(c => JSON.parse(String(c.init.body)))
const state = () => elder(ID).getState()

test("demo reset maps supabase/seed.json to Profile and Med[]", async () => {
  const seed = await Bun.file(new URL("../../supabase/seed.json", import.meta.url)).json()
  const p = seed.patients.find((x: any) => x.id === ID)
  const s = await state()
  expect(s.profile).toEqual({ name: p.name, age: p.age, conditions: p.conditions, family: { name: p.family_name, relation: p.family_relation, phone: p.family_phone } })
  const rx = seed.prescriptions.filter((r: any) => r.patient_id === ID)
  expect(s.meds.length).toBe(rx.length)
  expect(s.meds.length).toBeGreaterThan(0)
  for (const m of s.meds) expect(m).toMatchObject({ lastTakenAt: null, missedCount: 0 })
  expect(s.meds.map(m => m.name)).toEqual(rx.map((r: any) => r.name))
})

test("confirm_medication -> recordMed, no escalation", async () => {
  const med = (await state()).meds[0]!.name
  const r = await tool("confirm_medication", { med, taken: true })
  expect(r).toMatchObject({ status: 200, output: `Logged: ${med} taken.` })
  const s = await state()
  expect(s.meds[0]!.lastTakenAt).toBeNumber()
  expect(s.timeline.at(-1)).toMatchObject({ kind: "med", from: "elder" })
  expect(escalations()).toEqual([])

  expect((await tool("confirm_medication", { med, taken: false })).output).toBe(`Logged: ${med} missed.`)
  expect((await state()).meds[0]!.missedCount).toBe(1)
})

test("report_symptom: low logs only, medium/high also escalates", async () => {
  expect((await tool("report_symptom", { symptom: "a bit tired", severity: "low" })).output).toBe("Logged symptom: a bit tired (low).")
  expect(escalations()).toEqual([])

  const r = await tool("report_symptom", { symptom: "dizzy when standing", severity: "medium" })
  expect(r.output).toBe("Logged symptom: dizzy when standing (medium). Care team notified.")
  expect((await state()).timeline.at(-1)).toMatchObject({ kind: "symptom", text: "dizzy when standing", data: { severity: "medium" } })
  expect(escalations()).toEqual([{ elderId: ID, kind: "symptom", reason: "dizzy when standing", details: { severity: "medium" } }])
})

test("teach_back_result: not understood escalates once; the family lane is left to the care team", async () => {
  expect((await tool("teach_back_result", { med: "Metformin", understood: true })).output).toBe("Logged: teach-back for Metformin understood.")
  expect(escalations()).toEqual([])

  const r = await tool("teach_back_result", { med: "Metformin", understood: false, note: "thought it was at bedtime" })
  expect(r.output).toBe("Logged: teach-back for Metformin not understood. Family notified.")
  const s = await state()
  expect(s.timeline.at(-1)).toMatchObject({ kind: "teach_back", data: { med: "Metformin", understood: false } })
  expect(s.timeline.filter(e => e.data?.lane)).toEqual([]) // no server-written lane item: it would duplicate the relay's family message
  expect(escalations()).toMatchObject([{ elderId: ID, kind: "teach_back", details: { med: "Metformin" } }])
})

test("request_refill escalates to the pharmacy", async () => {
  expect((await tool("request_refill", { med: "Amlodipine" })).output).toBe("Refill request sent to the pharmacy for Amlodipine.")
  expect(escalations()).toEqual([{ elderId: ID, kind: "refill", reason: "Refill needed: Amlodipine", details: { med: "Amlodipine" } }])
})

test("end_call -> endCall + summary escalation; Supabase skipped without env", async () => {
  await post("/api/call/start", { elderId: ID })
  expect((await state()).callState).toBe("in_progress")
  const r = await tool("end_call", { summary: "Dizzy, out of BP pills.", mood: "tired" })
  expect(r.output).toBe("Call ended. Summary sent to the family.")
  const s = await state()
  expect(s.callState).toBe("idle")
  expect(s.timeline.at(-1)).toMatchObject({ kind: "call_ended", text: "Dizzy, out of BP pills.", data: { mood: "tired" } })
  expect(escalations()).toEqual([{ elderId: ID, kind: "summary", reason: "Dizzy, out of BP pills.", details: { mood: "tired" } }])
  expect(calls.filter(c => c.url.includes("/rest/v1/"))).toEqual([])
})

const LEGACY_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2ln" // shape of a legacy service_role key
test("end_call archives to Supabase calls + care_events when both env vars are set", async () => {
  process.env.SUPABASE_URL = "https://db.test"
  process.env.SUPABASE_SERVICE_ROLE_KEY = LEGACY_JWT
  await tool("end_call", { summary: "All good.", mood: "cheerful" })
  const db = calls.filter(c => c.url.startsWith("https://db.test/rest/v1/"))
  expect(db.map(c => c.url)).toEqual(["https://db.test/rest/v1/calls", "https://db.test/rest/v1/care_events"])
  for (const c of db) expect(c.init.headers).toMatchObject({ apikey: LEGACY_JWT, Authorization: `Bearer ${LEGACY_JWT}` })
})

test("Supabase auth headers: legacy JWT key gets apikey + Bearer, sb_secret_ key gets apikey only", async () => {
  expect(supabaseAuth(LEGACY_JWT)).toEqual({ apikey: LEGACY_JWT, Authorization: `Bearer ${LEGACY_JWT}` })
  expect(supabaseAuth("sb_secret_abc123")).toEqual({ apikey: "sb_secret_abc123" }) // Supabase rejects a non-JWT Bearer token

  process.env.SUPABASE_URL = "https://db.test"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_abc123"
  await tool("end_call", { summary: "All good.", mood: "cheerful" })
  const db = calls.filter(c => c.url.startsWith("https://db.test/rest/v1/"))
  expect(db.length).toBe(2)
  for (const c of db) expect(Object.keys(c.init.headers as object)).not.toContain("Authorization")
})

test("a dead care team does not break the tool call", async () => {
  careTeamDown = true
  const r = await tool("request_refill", { med: "Amlodipine" })
  expect(r).toMatchObject({ status: 200, output: "Refill request sent to the pharmacy for Amlodipine." })
  await Bun.sleep(5) // let the rejected escalation settle; it must only log
})

test("args may be a JSON string; bad input gets a 400 with an output string", async () => {
  expect((await tool("request_refill", JSON.stringify({ med: "Metformin" }))).output).toBe("Refill request sent to the pharmacy for Metformin.")
  expect(await tool("fly_to_moon", {})).toMatchObject({ status: 400, output: "Error: unknown tool: fly_to_moon" })
  expect(await tool("confirm_medication", { med: "Metformin" })).toMatchObject({ status: 400, output: "Error: taken must be true or false" })
  expect((await post("/api/tool", { name: "end_call", args: {} })).status).toBe(400) // no elderId
})

test("vitals logs an event then escalates with kind vitals", async () => {
  expect((await post("/api/demo/vitals", { elderId: ID, heartRate: 128, note: "watch alert" })).status).toBe(200)
  expect((await state()).timeline.at(-1)).toMatchObject({ kind: "vitals", text: "Heart rate 128 bpm (watch alert)" })
  expect(escalations()).toEqual([{ elderId: ID, kind: "vitals", reason: "Heart rate 128 bpm (watch alert)", details: { heartRate: 128, note: "watch alert" } }])
})

test("schedule sets nextCheckInAt and the fake alarm makes the call due", async () => {
  const res = await post("/api/demo/schedule", { elderId: ID, inSeconds: 0 })
  expect(res.status).toBe(200)
  await Bun.sleep(10)
  const s = await state()
  expect(s.callState).toBe("due")
  expect(s.timeline.at(-1)).toMatchObject({ kind: "call_due" })
})

test("CORS: preflight allowed for the web origin only", async () => {
  const pre = (origin: string) => handle(new Request("http://server.test/api/tool", { method: "OPTIONS", headers: { Origin: origin } }))
  expect((await pre("http://localhost:5173")).headers.get("access-control-allow-origin")).toBe("http://localhost:5173")
  expect((await pre("http://127.0.0.1:5173")).headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173")
  expect((await pre("https://evil.test")).headers.get("access-control-allow-origin")).toBeNull()
})

test("realtime-token: 503 mock without key; mints a GA client secret with key", async () => {
  delete process.env.OPENAI_API_KEY
  const mock = await handle(new Request("http://server.test/api/realtime-token"))
  expect(mock.status).toBe(503)
  expect(await mock.json()).toEqual({ error: "OPENAI_API_KEY not set", mock: true })

  process.env.OPENAI_API_KEY = "sk-test"
  nextResponse = () => Response.json({ value: "ek_test", expires_at: 1790000000, session: {} })
  try {
    const res = await handle(new Request("http://server.test/api/realtime-token"))
    expect(await res.json()).toEqual({ value: "ek_test", expires_at: 1790000000, model: "gpt-realtime-2.1" })
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/realtime/client_secrets")
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: "Bearer sk-test" })
    expect(JSON.parse(String(calls[0]!.init.body)).session).toMatchObject({ type: "realtime", model: "gpt-realtime-2.1" })
  } finally {
    delete process.env.OPENAI_API_KEY
    nextResponse = () => new Response("{}", { status: 202 })
  }
})
