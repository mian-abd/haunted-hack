// server/: HTTP API from PLAN.md. Bun.serve on :8787, no framework.
import { elder, isFake, prepareWebsocket, type Med, type Profile } from "./actor"
import { callMode, dial, startAutoDial, webhook } from "./elevenlabs"

const ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]
const REALTIME_MODEL = "gpt-realtime-2.1" // OpenAI's recommended realtime model for voice agents with tools (Oct 2026)
const SEED = new URL("../../supabase/seed.json", import.meta.url)
const OK = { ok: true }

type Body = Record<string, any>
type EscalationKind = "symptom" | "refill" | "vitals" | "summary" | "teach_back"

const json = (body: unknown, status = 200) => Response.json(body, { status })
const bad = (msg: string): never => { throw Object.assign(new Error(msg), { status: 400 }) }
const need = (v: unknown, field: string): string => typeof v === "string" && v.trim() ? v : bad(`${field} is required`)
const flag = (v: unknown, field: string): boolean => typeof v === "boolean" ? v : bad(`${field} must be true or false`)

const routes: Record<string, (elderId: string, b: Body) => Promise<unknown>> = {
  "GET /api/actor-ws": async id => isFake ? json({ error: "fake actor (TERSE_FAKE=1 or no generated client): no websocket, poll /api/state", mock: true }, 503) : prepareWebsocket(id),
  "GET /api/state": id => elder(id).getState(),
  "POST /api/tool": async (id, b) => ({ output: await runTool(id, need(b.name, "name"), parseArgs(b.args)) }),
  "POST /api/demo/reset": async id => { await elder(id).setup(...await seedFor(id)); return OK },
  "POST /api/demo/schedule": async (id, b) => {
    if (typeof b.inSeconds !== "number" || b.inSeconds < 0) bad("inSeconds must be a number >= 0")
    const atMs = Date.now() + b.inSeconds * 1000
    await elder(id).scheduleCheckIn(atMs, "Demo check-in")
    return { ok: true, atMs }
  },
  "POST /api/demo/vitals": async (id, b) => {
    if (typeof b.heartRate !== "number") bad("heartRate must be a number")
    const details = { heartRate: b.heartRate, note: b.note }
    const text = `Heart rate ${b.heartRate} bpm${b.note ? ` (${b.note})` : ""}`
    await elder(id).logEvent({ kind: "vitals", text, from: "system", data: details })
    escalate({ elderId: id, kind: "vitals", reason: text, details })
    return OK
  },
  "POST /api/call/start": async id => { await elder(id).startCall(); return OK },
  "POST /api/call/end": async (id, b) => { await endCall(id, typeof b.summary === "string" && b.summary.trim() ? b.summary : "Call ended.", b.mood); return OK },
  "POST /api/call/dial": id => dial(id),
  "GET /api/call/mode": async () => callMode(),
}

export async function handle(req: Request): Promise<Response> {
  const origin = req.headers.get("origin") ?? ""
  const cors: Record<string, string> = ORIGINS.includes(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
    : {}
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, Vary: "Origin" } })
  const { pathname, searchParams } = new URL(req.url)
  let res: Response
  try {
    if (req.method === "GET" && pathname === "/api/realtime-token") res = await realtimeToken()
    else if (pathname.startsWith("/api/el/")) res = await webhook(req, pathname, { runTool, endCall }) // ElevenLabs phone agent
    else {
      const route = routes[`${req.method} ${pathname}`]
      if (!route) res = json({ error: "not found" }, 404)
      else {
        const b: Body = req.method === "POST" ? await req.json().catch(() => bad("body must be JSON")) : Object.fromEntries(searchParams)
        const out = await route(need(b?.elderId, "elderId"), b)
        res = out instanceof Response ? out : json(out)
      }
    }
  } catch (e: any) {
    if (!e?.status) console.error(`[${req.method} ${pathname}]`, e)
    // `output` too, so the voice model always gets a string to read back from /api/tool.
    res = json({ error: String(e?.message ?? e), output: `Error: ${e?.message ?? e}` }, e?.status ?? 500)
  }
  for (const [k, v] of Object.entries({ ...cors, Vary: "Origin" })) res.headers.set(k, v)
  return res
}

// Voice-agent tools from PLAN.md. Outputs are short facts the voice model reads back.
async function runTool(elderId: string, name: string, a: Body): Promise<string> {
  const actor = elder(elderId)
  switch (name) {
    case "confirm_medication": {
      const med = need(a.med, "med"), taken = flag(a.taken, "taken")
      await actor.recordMed(med, taken, a.note)
      return `Logged: ${med} ${taken ? "taken" : "missed"}.`
    }
    case "report_symptom": {
      const symptom = need(a.symptom, "symptom"), severity = a.severity
      if (!["low", "medium", "high"].includes(severity)) bad("severity must be low, medium or high")
      await actor.logEvent({ kind: "symptom", text: symptom, from: "elder", data: { severity } })
      if (severity === "low") return `Logged symptom: ${symptom} (low).`
      escalate({ elderId, kind: "symptom", reason: symptom, details: { severity } })
      return `Logged symptom: ${symptom} (${severity}). Care team notified.`
    }
    case "teach_back_result": {
      const med = need(a.med, "med"), understood = flag(a.understood, "understood")
      const note = a.note ? ` (${a.note})` : ""
      await actor.logEvent({ kind: "teach_back", text: `${med}: ${understood ? "understood" : "not understood"}${note}`, from: "elder", data: { med, understood, note: a.note } })
      if (understood) return `Logged: teach-back for ${med} understood.`
      // One path to the family lane: the care team's family agent over Agent Relay (no second server-written note).
      escalate({ elderId, kind: "teach_back", reason: `Teach-back not understood: ${med}${note}`, details: { med, note: a.note } })
      return `Logged: teach-back for ${med} not understood. Family notified.`
    }
    case "request_refill": {
      const med = need(a.med, "med")
      escalate({ elderId, kind: "refill", reason: `Refill needed: ${med}`, details: { med } })
      return `Refill request sent to the pharmacy for ${med}.`
    }
    case "end_call": {
      const summary = need(a.summary, "summary")
      await endCall(elderId, summary, a.mood)
      escalate({ elderId, kind: "summary", reason: summary, details: { mood: a.mood } })
      return "Call ended. Summary sent to the family."
    }
  }
  return bad(`unknown tool: ${name}`)
}

// The realtime data channel gives tool arguments as a JSON string; accept that or an object.
function parseArgs(args: unknown): Body {
  if (typeof args !== "string") return (args ?? {}) as Body
  try { return JSON.parse(args) } catch { return bad("args must be JSON") }
}

// Fire-and-forget: a slow or dead care team must never block the call.
function escalate(body: { elderId: string; kind: EscalationKind; reason: string; details?: Body }) {
  const url = `${process.env.CARE_TEAM_URL || "http://localhost:8788"}/escalate`
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) })
    .then(r => { if (!r.ok) console.warn(`[escalate] ${body.kind}: care-team answered ${r.status}`) })
    .catch(e => console.warn(`[escalate] ${body.kind}: care-team call failed (${e?.message ?? e}), continuing`))
}

async function endCall(elderId: string, summary: string, mood?: string) {
  await elder(elderId).endCall(summary, mood)
  archive(elderId, summary, mood)
}

// PostgREST auth. A legacy service_role key is a JWT: apikey + Authorization: Bearer. A new sb_secret_ key is not a JWT,
// and Supabase rejects it as a Bearer token ("API keys" docs, Known limitations): apikey only.
export const supabaseAuth = (key: string): Record<string, string> =>
  key.split(".").length === 3 ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key }

// Archive to Supabase only when both env vars are set. The service key stays on the server.
function archive(elderId: string, summary: string, mood?: string) {
  const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = process.env
  if (!url || !key) return
  const headers = { ...supabaseAuth(key), "Content-Type": "application/json", Prefer: "return=minimal" }
  const insert = (table: string, row: Body) =>
    fetch(`${url}/rest/v1/${table}`, { method: "POST", headers, body: JSON.stringify(row), signal: AbortSignal.timeout(5000) })
      .then(async r => { if (!r.ok) console.warn(`[supabase] ${table} insert failed ${r.status}: ${await r.text()}`) })
      .catch(e => console.warn(`[supabase] ${table} insert failed: ${e?.message ?? e}`))
  // Columns from supabase/migrations/20261031120000_init.sql.
  insert("calls", { patient_id: elderId, summary, mood: mood ?? null })
  insert("care_events", { patient_id: elderId, kind: "call_ended", from_agent: "system", text: summary, data: { mood: mood ?? null } })
}

async function seedFor(elderId: string): Promise<[Profile, Med[]]> {
  const seed = await Bun.file(SEED).json()
  const p = seed.patients.find((x: Body) => x.id === elderId) ?? bad(`no patient "${elderId}" in supabase/seed.json`)
  const profile: Profile = { name: p.name, age: p.age, conditions: p.conditions, family: { name: p.family_name, relation: p.family_relation, phone: p.family_phone ?? undefined } }
  const meds: Med[] = seed.prescriptions
    .filter((r: Body) => r.patient_id === elderId)
    .map((r: Body) => ({ name: r.name, dose: r.dose, times: r.times, purpose: r.purpose, lastTakenAt: null, missedCount: 0 }))
  return [profile, meds]
}

async function realtimeToken(): Promise<Response> {
  const key = process.env.OPENAI_API_KEY
  if (!key) return json({ error: "OPENAI_API_KEY not set", mock: true }, 503)
  // GA Realtime: mint a short-lived client secret (ek_...). The browser adds instructions and tools via session.update.
  const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: REALTIME_MODEL,
        audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" } }, output: { voice: "marin" } },
      },
    }),
  })
  if (!r.ok) {
    console.error(`[realtime-token] OpenAI ${r.status}: ${await r.text()}`)
    return json({ error: `OpenAI returned ${r.status}` }, 502)
  }
  const { value, expires_at } = await r.json()
  return json({ value, expires_at, model: REALTIME_MODEL })
}

if (import.meta.main) {
  const server = Bun.serve({ port: Number(process.env.PORT || 8787), fetch: handle })
  console.log(`server/ on ${server.url} · actor: ${isFake ? "in-memory fake" : process.env.TERSE_ACTOR_URL || "terse actor dev (127.0.0.1:7100)"} · care-team: ${process.env.CARE_TEAM_URL || "http://localhost:8788"}`)
  if (process.env.AUTO_DIAL === "1") {
    startAutoDial()
    console.log("server/ AUTO_DIAL=1: a due check-in rings the elder's phone through ElevenLabs")
  }
}
