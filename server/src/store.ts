// Supabase as the system of record (PLAN.md "Supabase"): hospital records in, call archive and care history out.
// PostgREST over fetch, service key server-side only. Every write is fire-and-forget: a slow or missing database
// never blocks a call. With SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY unset, reads fall back to supabase/seed.json
// and writes are skipped.
import type { Med, NewEvent, Profile } from "./actor"

type Row = Record<string, any>

// A new sb_secret_ key is not a JWT, and Supabase rejects it as a Bearer token: send it as apikey only.
export const supabaseAuth = (key: string): Record<string, string> =>
  key.split(".").length === 3 ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key }

function db() {
  const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = process.env
  return url && key ? { url: url.replace(/\/+$/, ""), headers: { ...supabaseAuth(key), "Content-Type": "application/json" } } : null
}

async function rest(method: string, path: string, body?: unknown, prefer = "return=minimal"): Promise<any> {
  const d = db()
  if (!d) return null
  const r = await fetch(`${d.url}/rest/v1/${path}`, {
    method,
    headers: { ...d.headers, Prefer: prefer },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  })
  if (!r.ok) throw new Error(`${method} ${path.split("?")[0]} ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return prefer === "return=minimal" ? null : r.json()
}

const quietly = (what: string, p: Promise<unknown>) =>
  p.catch(e => console.warn(`[supabase] ${what} failed: ${e?.message ?? e}`))

// The demo reset reads the patient and prescriptions from Supabase; null means "use seed.json".
export async function recordFor(elderId: string): Promise<[Profile, Med[]] | null> {
  if (!db()) return null
  try {
    const id = encodeURIComponent(elderId)
    const [p] = await rest("GET", `patients?id=eq.${id}&select=*`, undefined, "")
    if (!p) return null
    const rx: Row[] = await rest("GET", `prescriptions?patient_id=eq.${id}&select=name,dose,times,purpose&order=name`, undefined, "")
    const profile: Profile = { name: p.name, age: p.age, conditions: p.conditions, family: { name: p.family_name, relation: p.family_relation, phone: p.family_phone ?? undefined } }
    return [profile, rx.map(r => ({ name: r.name, dose: r.dose, times: r.times, purpose: r.purpose, lastTakenAt: null, missedCount: 0 }))]
  } catch (e: any) {
    console.warn(`[supabase] reading ${elderId} failed, using seed.json: ${e?.message ?? e}`)
    return null
  }
}

// One care_events row per ElderActor timeline event the server writes (meds, symptoms, teach-back, vitals, calls).
export function archiveEvent(elderId: string, e: NewEvent): Promise<unknown> {
  return quietly("care_events insert", rest("POST", "care_events", {
    patient_id: elderId, kind: e.kind, from_agent: e.from ?? null, to_agent: e.to ?? null, text: e.text, data: e.data ?? null,
  }))
}

// calls row at the end of a call. Kept per elder so the post-call transcript can wait for it.
const lastCall = new Map<string, Promise<unknown>>()

export function archiveCall(elderId: string, summary: string, mood?: string, startedAt?: number | null): Promise<unknown> {
  const done = Promise.all([
    quietly("calls insert", rest("POST", "calls", {
      patient_id: elderId, summary, mood: mood ?? null, started_at: startedAt ? new Date(startedAt).toISOString() : null,
    })),
    archiveEvent(elderId, { kind: "call_ended", from: "system", text: summary, data: { mood: mood ?? null } }),
  ])
  lastCall.set(elderId, done)
  return done
}

// The ElevenLabs post-call transcript goes onto the call's row (the newest one without a transcript, ended in the
// last 30 minutes). If no such row exists (the call never reached end_call), it gets a row of its own.
export async function archiveTranscript(elderId: string, summary: string, transcript: unknown[], conversationId: string | null) {
  if (!db()) return
  await lastCall.get(elderId)
  const id = encodeURIComponent(elderId)
  const since = new Date(Date.now() - 30 * 60_000).toISOString()
  await quietly("calls transcript", (async () => {
    const recent: Row[] = await rest("GET", `calls?patient_id=eq.${id}&transcript=is.null&ended_at=gte.${since}&select=id&order=ended_at.desc&limit=1`, undefined, "")
    if (recent[0]) await rest("PATCH", `calls?id=eq.${recent[0].id}`, { transcript })
    else await rest("POST", "calls", { patient_id: elderId, summary, transcript })
  })())
  await archiveEvent(elderId, { kind: "note", from: "system", text: `Call transcript saved (${transcript.length} turns)`, data: { conversationId, turns: transcript.length } })
}
