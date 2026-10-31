import { afterEach, expect, test } from "bun:test"

process.env.TERSE_FAKE = "1"
delete process.env.OPENAI_API_KEY // force the rules extractor, never the real OpenAI
const { handle } = await import("./server")
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
})

const post = (path: string, body: unknown) =>
  handle(new Request(`http://127.0.0.1:8787${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))

const doc = "Allergies:\n- Penicillin (hives)\n\nMedications:\n- Amlodipine 5 mg — 08:00 — blood pressure\n\nFollow-up:\n- Dr. Patel in 1 week"

test("organize reads a document with the rules extractor when no OpenAI key is set", async () => {
  const res = await post("/api/records/organize", { elderId: "grandpa-joe", text: doc })
  const body = await res.json()
  expect(res.status).toBe(200)
  expect(body.source).toBe("rules")
  expect(body.organized.medications[0].name).toMatch(/Amlodipine/)
})

test("organize rejects an empty document", async () => {
  expect((await post("/api/records/organize", { elderId: "grandpa-joe", text: "  " })).status).toBe(400)
})

test("apply replaces a medicine on file, keeping its prescriber and refills, inserts before deleting, and adds one note", async () => {
  process.env.SUPABASE_URL = "https://db.test"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test"
  const calls: string[] = []
  let inserted: Record<string, unknown>[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    const path = String(url).replace("https://db.test/rest/v1/", "")
    calls.push(`${method} ${path.split("?")[0]}${method === "DELETE" ? ` ${new URL(String(url)).searchParams.get("id")}` : ""}`)
    if (method === "GET") return new Response(JSON.stringify([{ id: "rx-1", name: "amlodipine", prescriber: "Dr. Patel", refills_left: 2 }]), { status: 200 })
    if (method === "POST" && path.startsWith("prescriptions")) inserted = JSON.parse(String(init?.body))
    return new Response("[]", { status: 200 })
  }) as typeof fetch
  const organized = {
    summary: "Discharged after dizziness.", conditions: ["hypertension"], allergies: ["penicillin"], notes: [], follow_ups: ["Dr. Patel in 1 week"],
    medications: [{ name: "Amlodipine", dose: "5 mg", times: ["08:00"], purpose: "blood pressure" }, { name: "Vitamin D3", dose: "1000 IU", times: ["08:00"], purpose: "low vitamin D" }],
  }
  const body = await (await post("/api/records/apply", { elderId: "grandpa-joe", author: "Riverside Hospital", organized })).json()
  expect(body).toEqual({ ok: true, inserted: { prescriptions: 2, clinical_notes: 1 } })
  expect(calls).toEqual(["GET prescriptions", "POST prescriptions", "DELETE prescriptions in.(rx-1)", "POST clinical_notes"])
  expect(inserted[0]).toMatchObject({ name: "Amlodipine", prescriber: "Dr. Patel", refills_left: 2 })
  expect(inserted[1]).toMatchObject({ name: "Vitamin D3", prescriber: "Riverside Hospital", refills_left: null })
})
