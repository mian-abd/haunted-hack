import { afterEach, expect, test } from "bun:test"
import { loadRecord, supabaseAuth } from "./records"

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
