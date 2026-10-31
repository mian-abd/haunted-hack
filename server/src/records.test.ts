import { afterAll, beforeEach, expect, test } from "bun:test"

// Fake actor + stubbed fetch. Env must be set before the modules load.
process.env.TERSE_FAKE = "1"
const { handle } = await import("./server")

const ID = "grandpa-joe"
const realFetch = globalThis.fetch
let calls: { url: string; init: RequestInit }[] = []
let reply = () => Response.json([{ id: "n1", patient_id: ID, author: "Dr. Patel", note: "BP 128/80", created_at: "2026-10-31T12:00:00Z" }], { status: 201 })

beforeEach(() => {
  calls = []
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    return reply()
  }) as typeof fetch
})
afterAll(() => { globalThis.fetch = realFetch })

const get = async () => (await handle(new Request(`http://server.test/api/records?elderId=${ID}`))).json() as Promise<any>
const post = (body: unknown) =>
  handle(new Request("http://server.test/api/records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))
const useSupabase = () => { process.env.SUPABASE_URL = "https://db.test/"; process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_abc" }

test("GET /api/records falls back to seed.json (unset or failing Supabase), notes newest first", async () => {
  const r = await get()
  expect(r).toMatchObject({ source: "seed", patient: { id: ID } })
  expect(r.prescriptions.length).toBeGreaterThan(0)
  const ts = r.clinical_notes.map((n: any) => n.created_at)
  expect(ts.length).toBeGreaterThan(1)
  expect(ts).toEqual([...ts].sort().reverse())
  expect(calls).toEqual([])

  useSupabase()
  reply = () => new Response("boom", { status: 500 })
  expect((await get()).source).toBe("seed")
  expect(calls.length).toBe(3)
})

test("POST /api/records rejects an empty or long note and a long author (400), 503 without Supabase", async () => {
  for (const body of [{ elderId: ID, note: "  " }, { elderId: ID, note: "x".repeat(4001) }, { elderId: ID, note: "ok", author: "a".repeat(121) }])
    expect((await post(body)).status).toBe(400)
  expect((await post({ elderId: ID, note: "ok" })).status).toBe(503)
  expect(calls).toEqual([])
})

test("POST /api/records inserts into clinical_notes through PostgREST", async () => {
  useSupabase()
  reply = () => Response.json([{ id: "n1", patient_id: ID, author: "Dr. Patel", note: "BP 128/80", created_at: "2026-10-31T12:00:00Z" }], { status: 201 })
  const res = await post({ elderId: ID, author: " Dr. Patel ", note: " BP 128/80 " })
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ ok: true, note: { id: "n1", note: "BP 128/80" } })
  expect(calls.length).toBe(1)
  const c = calls[0]!
  expect(c.url).toBe("https://db.test/rest/v1/clinical_notes")
  expect(c.init.method).toBe("POST")
  expect(JSON.parse(String(c.init.body))).toEqual({ patient_id: ID, author: "Dr. Patel", note: "BP 128/80" })
  const h = c.init.headers as Record<string, string>
  expect(h.apikey).toBe("sb_secret_abc") // sb_secret_ keys go in apikey only, never as a Bearer token
  expect(h.Authorization).toBeUndefined()
  expect(h.Prefer).toBe("return=representation")
})
