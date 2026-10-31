import { afterAll, beforeEach, expect, test } from "bun:test"

// Fake actor + a stubbed Supabase (PostgREST) that answers by URL. Env must be set before the modules load.
process.env.TERSE_FAKE = "1"
process.env.CARE_TEAM_URL = "http://care.test"
const { handle } = await import("./server")
const { elder } = await import("./actor")
const { archiveTranscript } = await import("./store")

const ID = "grandpa-joe"
const realFetch = globalThis.fetch
let calls: { method: string; url: string; body: any }[] = []
let recentCalls: unknown[] = []

beforeEach(() => {
  calls = []
  recentCalls = []
  process.env.SUPABASE_URL = "https://db.test"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_abc123"
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url), method = init.method ?? "GET"
    calls.push({ method, url: u, body: init.body ? JSON.parse(String(init.body)) : undefined })
    if (method === "GET" && u.includes("/rest/v1/patients")) return Response.json([{ id: ID, name: "Joe Supa", age: 79, conditions: ["hypertension"], family_name: "Linh", family_relation: "daughter", family_phone: null }])
    if (method === "GET" && u.includes("/rest/v1/prescriptions")) return Response.json([{ name: "Amlodipine", dose: "5 mg", times: ["08:00"], purpose: "blood pressure" }])
    if (method === "GET" && u.includes("/rest/v1/calls")) return Response.json(recentCalls)
    return new Response(null, { status: 201 })
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
})

const post = (path: string, body: unknown) =>
  handle(new Request(`http://server.test${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))
const writes = (table: string) => calls.filter(c => c.method !== "GET" && c.url.startsWith(`https://db.test/rest/v1/${table}`))
const settle = () => Bun.sleep(10) // archive writes are fire-and-forget

test("demo reset reads the patient and prescriptions from Supabase", async () => {
  expect((await post("/api/demo/reset", { elderId: ID })).status).toBe(200)
  const s = await elder(ID).getState()
  expect(s.profile).toMatchObject({ name: "Joe Supa", age: 79, family: { name: "Linh", relation: "daughter" } })
  expect(s.meds.map(m => m.name)).toEqual(["Amlodipine"])
})

test("tool events land in care_events, and end_call writes calls with started_at", async () => {
  await post("/api/demo/reset", { elderId: ID })
  await post("/api/call/start", { elderId: ID })
  await post("/api/tool", { elderId: ID, name: "confirm_medication", args: { med: "Amlodipine", taken: false, note: "ran out" } })
  await post("/api/tool", { elderId: ID, name: "report_symptom", args: { symptom: "dizzy", severity: "medium" } })
  await post("/api/tool", { elderId: ID, name: "end_call", args: { summary: "Dizzy, out of Amlodipine.", mood: "tired" } })
  await settle()
  expect(writes("care_events").map(c => [c.body.kind, c.body.text])).toEqual([
    ["med", "Amlodipine: not taken (ran out)"],
    ["symptom", "dizzy"],
    ["call_ended", "Dizzy, out of Amlodipine."],
  ])
  const [call] = writes("calls")
  expect(call.body).toMatchObject({ patient_id: ID, summary: "Dizzy, out of Amlodipine.", mood: "tired" })
  expect(typeof call.body.started_at).toBe("string")
})

test("the post-call transcript goes onto the call's row, or a row of its own", async () => {
  recentCalls = [{ id: "call-1" }]
  await archiveTranscript(ID, "recap", [{ role: "agent", message: "Hi Joe" }], "conv_1")
  expect(writes("calls")).toEqual([{ method: "PATCH", url: "https://db.test/rest/v1/calls?id=eq.call-1", body: { transcript: [{ role: "agent", message: "Hi Joe" }] } }])

  calls = []
  recentCalls = []
  await archiveTranscript(ID, "recap", [], "conv_2")
  expect(writes("calls")[0]).toMatchObject({ method: "POST", body: { patient_id: ID, summary: "recap", transcript: [] } })
})
