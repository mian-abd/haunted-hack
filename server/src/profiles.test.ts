import { afterAll, beforeEach, expect, test } from "bun:test"

// Caller profiles against a fake Supabase (PostgREST answered by URL). Env must be set before the modules load.
process.env.TERSE_FAKE = "1"
process.env.CARE_TEAM_URL = "http://care.test"
const { handle } = await import("./server")
const { elder } = await import("./actor")
const { normalizePhone, samePhone, profileFields } = await import("./store")

const SECRET = "tool-secret-for-tests"
const realFetch = globalThis.fetch
type Row = Record<string, any>
let patients: Row[] = []
let calls: Row[] = []
let symptoms: Row[] = []
let writes: { method: string; url: string; body: any }[] = []

const fakeSupabase = (async (url: string | URL | Request, init: RequestInit = {}) => {
  const u = decodeURIComponent(String(url)), method = init.method ?? "GET"
  const body = init.body ? JSON.parse(String(init.body)) : undefined
  const param = (k: string) => u.split(`${k}=eq.`)[1]?.split("&")[0]
  if (method !== "GET") writes.push({ method, url: u, body })
  if (method === "GET" && u.includes("/rest/v1/patients?phone=eq.")) return Response.json(patients.filter(p => p.phone === param("phone")))
  if (method === "GET" && u.includes("/rest/v1/patients?id=eq.")) return Response.json(patients.filter(p => p.id === param("id")))
  if (method === "GET" && u.includes("/rest/v1/prescriptions")) return Response.json([])
  if (method === "GET" && u.includes("/rest/v1/calls")) return Response.json(calls)
  if (method === "GET" && u.includes("/rest/v1/care_events")) return Response.json(symptoms)
  if (method === "POST" && u.includes("/rest/v1/patients")) { if (!patients.some(p => p.id === body.id)) patients.push(body); return new Response(null, { status: 201 }) }
  if (method === "PATCH" && u.includes("/rest/v1/patients?id=eq.")) { Object.assign(patients.find(p => p.id === param("id")) ?? {}, body); return new Response(null, { status: 204 }) }
  return new Response(null, { status: 201 })
}) as typeof fetch

beforeEach(async () => {
  patients = [{ id: "grandpa-joe", name: "Joe Nguyen", age: 78, conditions: ["hypertension"], family_name: "Linh", family_relation: "daughter", phone: null }]
  calls = []
  symptoms = []
  writes = []
  Object.assign(process.env, { SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc123", EL_TOOL_SECRET: SECRET, ELDER_PHONE: "+15550000000" })
  globalThis.fetch = fakeSupabase
  await post("/api/demo/reset", { elderId: "grandpa-joe" }, {})
})
afterAll(() => {
  globalThis.fetch = realFetch
  for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "EL_TOOL_SECRET", "ELDER_PHONE"]) delete process.env[k]
})

function post(path: string, body: unknown, headers: Record<string, string> = { "x-unc-secret": SECRET }) {
  return handle(new Request(`http://server.test${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }))
}
const callIn = async (caller: string) => (await (await post("/api/el/init", { caller_id: caller, conversation_id: "c1" })).json()).dynamic_variables

test("phone numbers normalize, so formatting never splits one caller in two", () => {
  expect(normalizePhone("(765) 555-0100")).toBe("+17655550100")
  expect(normalizePhone("+1 765 555 0100")).toBe("+17655550100")
  expect(samePhone("7655550100", "+17655550100")).toBe(true)
  expect(samePhone("+17655550100", "+17655550199")).toBe(false)
  expect(profileFields({ name: " Rosa ", age: "84", conditions: "arthritis, afib", family_phone: "555 010 0101", junk: 1, family_name: "" }))
    .toEqual({ name: "Rosa", age: 84, conditions: ["arthritis", "afib"], family_phone: "+15550100101" })
})

test("a number we have never met gets its own new profile, not Joe's", async () => {
  const v = await callIn("+14155550123")
  expect(v.elder_id).toBe("caller-14155550123")
  expect(v.greeting).toBe("Hi, this is Troska, a care companion. Who am I speaking with?")
  expect(v.elder_context).toContain("This caller is new")
  expect(v.elder_context).not.toContain("Joe")
  expect(patients.find(p => p.id === "caller-14155550123")).toMatchObject({ name: "New caller", phone: "+14155550123" })
})

test("save_profile fills in the new caller, and their next call knows them", async () => {
  await callIn("+14155550123")
  const res = await post("/api/el/tool/save_profile", { elder_id: "caller-14155550123", name: "Rosa Alvarez", age: 84, conditions: "atrial fibrillation" })
  expect((await res.json()).output).toBe("Saved to their profile: name, age, conditions.")
  expect(patients.find(p => p.id === "caller-14155550123")).toMatchObject({ name: "Rosa Alvarez", age: 84, conditions: ["atrial fibrillation"] })
  await elder("caller-14155550123").endCall("done") // the first call is over
  const { phoneCallEnded } = await import("./elevenlabs")
  phoneCallEnded("caller-14155550123")
  const v = await callIn("4155550123") // the same person, the number written differently
  expect(v.elder_id).toBe("caller-14155550123")
  expect(v.elder_first_name).toBe("Rosa")
  expect(v.greeting).toBe("Hi Rosa, it's Troska. Thanks for calling. What can I do for you?")
  expect(v.elder_context).toContain("Rosa Alvarez, age 84")
})

test("the elder's own number finds their record, and the agent gets their history from Supabase", async () => {
  calls = [{ ended_at: "2026-10-31T21:27:58Z", summary: "Dizzy, out of Amlodipine; refill requested.", mood: "tired" }]
  symptoms = [{ created_at: "2026-10-31T21:26:59Z", text: "dizzy", data: { severity: "medium" } }]
  const v = await callIn("+1 555 000 0000") // ELDER_PHONE, formatted differently
  expect(v.elder_id).toBe("grandpa-joe")
  expect(v.elder_first_name).toBe("Joe")
  expect(v.elder_context).toContain("Earlier calls (newest first):")
  expect(v.elder_context).toContain("Dizzy, out of Amlodipine; refill requested. (mood: tired)")
  expect(v.elder_context).toContain("Recent symptoms on record:")
  expect(v.elder_context).not.toContain("not on file")
  expect(writes.some(w => w.method === "PATCH" && w.url.includes("patients?id=eq.grandpa-joe") && w.body.phone === "+15550000000")).toBe(true) // his number is now on file
})

test("history skips calls that say nothing (early hang-ups, calls that never connected) and keeps the last 3 real ones", async () => {
  calls = [
    { ended_at: "2026-10-31T21:42:34Z", summary: "Call ended before the wrap-up.", mood: "unknown" },
    { ended_at: "2026-10-31T21:40:00Z", summary: "The check-in call did not connect (no-answer).", mood: null },
    { ended_at: "2026-10-31T21:31:29Z", summary: "Dizzy since this morning; out of Amlodipine.", mood: "tired" },
    { ended_at: "2026-10-31T21:20:00Z", summary: "Call ended.", mood: null },
    { ended_at: "2026-10-31T21:10:00Z", summary: "Felt fine; took all meds.", mood: "good" },
    { ended_at: "2026-10-31T21:00:00Z", summary: "Asked about the pharmacy hours.", mood: "calm" },
    { ended_at: "2026-10-31T20:50:00Z", summary: "Oldest real call.", mood: "calm" },
  ]
  const v = await callIn("+15550000000")
  expect(v.elder_context).not.toContain("before the wrap-up")
  expect(v.elder_context).not.toContain("did not connect")
  expect(v.elder_context).toContain("Dizzy since this morning; out of Amlodipine. (mood: tired)")
  expect(v.elder_context).toContain("Asked about the pharmacy hours.")
  expect(v.elder_context).not.toContain("Oldest real call.") // only the last 3 real calls
})

test("an outbound call rings the number on the elder's profile", async () => {
  patients.push({ id: "nana-rosa", name: "Rosa Alvarez", age: 84, conditions: [], phone: "+15550100777" })
  Object.assign(process.env, { ELEVENLABS_API_KEY: "xi-test", ELEVENLABS_AGENT_ID: "agent_test", ELEVENLABS_PHONE_NUMBER_ID: "phnum_test" })
  let dialed: any
  globalThis.fetch = (async (url: any, init: any = {}) => {
    if (String(url).includes("api.elevenlabs.io")) { dialed = JSON.parse(String(init.body)); return Response.json({ success: true, conversation_id: "c2", callSid: "CA2" }) }
    return fakeSupabase(url, init)
  }) as typeof fetch
  await elder("nana-rosa").setup({ name: "Rosa Alvarez", age: 84, conditions: [], family: { name: "Marco", relation: "son" } }, [])
  expect((await post("/api/call/dial", { elderId: "nana-rosa" }, {})).status).toBe(200)
  expect(dialed.to_number).toBe("+15550100777")
  for (const k of ["ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID", "ELEVENLABS_PHONE_NUMBER_ID"]) delete process.env[k]
})
