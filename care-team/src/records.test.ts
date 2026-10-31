import { afterEach, expect, test } from "bun:test"
import { loadRecord, saveCareEvent, supabaseAuth } from "./records"

// Never the real database: bun test loads care-team/.env.
delete process.env.SUPABASE_URL
delete process.env.SUPABASE_SERVICE_ROLE_KEY

const LEGACY_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2ln" // shape of a legacy service_role key
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
})

test("Supabase auth headers: legacy JWT key gets apikey + Bearer, sb_secret_ key gets apikey only", async () => {
  expect(supabaseAuth(LEGACY_JWT)).toEqual({ apikey: LEGACY_JWT, Authorization: `Bearer ${LEGACY_JWT}` })
  expect(supabaseAuth("sb_secret_abc123")).toEqual({ apikey: "sb_secret_abc123" }) // Supabase rejects a non-JWT Bearer token

  const seen: Record<string, string>[] = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seen.push(init.headers as Record<string, string>)
    return Response.json([])
  }) as typeof fetch
  process.env.SUPABASE_URL = "https://db.test"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_abc123"
  const r = await loadRecord("grandpa-joe") // no Supabase patient: falls back to seed.json
  expect(seen.length).toBe(3)
  expect(seen.every(h => h.apikey === "sb_secret_abc123" && !("Authorization" in h))).toBe(true)
  expect(r.source).toBe("seed")
})

test("saveCareEvent writes a care_events row with the sb_secret key, and is skipped without Supabase", async () => {
  const seen: { url: string; init: RequestInit }[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => { seen.push({ url: String(url), init }); return new Response(null, { status: 201 }) }) as typeof fetch
  await saveCareEvent("grandpa-joe", { kind: "agent_msg", text: "hi" })
  expect(seen).toHaveLength(0)

  process.env.SUPABASE_URL = "https://db.test/"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_abc123"
  await saveCareEvent("grandpa-joe", { kind: "agent_msg", from: "doctor", to: "caretaker", text: "Triage: WATCH", data: { lane: "doctor" } })
  expect(seen[0].url).toBe("https://db.test/rest/v1/care_events")
  expect(seen[0].init.headers).toMatchObject({ apikey: "sb_secret_abc123", Prefer: "return=minimal" })
  expect(JSON.parse(String(seen[0].init.body))).toEqual({ patient_id: "grandpa-joe", kind: "agent_msg", from_agent: "doctor", to_agent: "caretaker", text: "Triage: WATCH", data: { lane: "doctor" } })
})
