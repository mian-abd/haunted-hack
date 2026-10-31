import { afterEach, expect, test } from "bun:test"

process.env.TERSE_FAKE = "1"
const { handle } = await import("./server")
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
})

const get = () => handle(new Request("http://127.0.0.1:8787/api/history?elderId=grandpa-joe"))

test("no Supabase configured: empty history, source none", async () => {
  const body = await (await get()).json()
  expect(body).toEqual({ calls: [], events: [], source: "none" })
})

test("reads calls and care_events from Supabase, newest first", async () => {
  process.env.SUPABASE_URL = "https://db.test"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test"
  const seen: string[] = []
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url))
    const rows = String(url).includes("/calls?") ? [{ started_at: null, ended_at: "2026-10-31T21:30:00Z", summary: "Dizzy", mood: "tired" }] : [{ created_at: "2026-10-31T21:29:00Z", kind: "symptom", from_agent: null, to_agent: null, text: "Dizzy since this morning" }]
    return new Response(JSON.stringify(rows), { status: 200 })
  }) as typeof fetch
  const body = await (await get()).json()
  expect(body.source).toBe("supabase")
  expect(body.calls[0].summary).toBe("Dizzy")
  expect(body.events[0].kind).toBe("symptom")
  expect(seen.some(u => u.includes("order=created_at.desc"))).toBe(true)
})
