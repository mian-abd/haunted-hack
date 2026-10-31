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
  const text = await r.text() // writes with return=minimal (or an ignored duplicate) answer with no body
  return text ? JSON.parse(text) : null
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

// ---- Caller profiles: a phone number identifies a person, so every call (in or out) finds their record and history.

const digits = (p: string) => p.replace(/\D/g, "")
/** E.164 for storage and lookup: "+1 (765) 555-0100" and "7655550100" are the same caller. */
export const normalizePhone = (p: string) => { const d = digits(p); return d ? `+${d.length === 10 ? `1${d}` : d}` : "" }
export const samePhone = (a?: string | null, b?: string | null) => !!a && !!b && !!normalizePhone(a) && normalizePhone(a) === normalizePhone(b)

export async function patientById(elderId: string): Promise<Row | null> {
  if (!db()) return null
  try { return (await rest("GET", `patients?id=eq.${encodeURIComponent(elderId)}&select=*`, undefined, ""))[0] ?? null }
  catch (e: any) { console.warn(`[supabase] reading ${elderId} failed: ${e?.message ?? e}`); return null }
}

export async function patientByPhone(phone: string): Promise<Row | null> {
  const p = normalizePhone(phone)
  if (!db() || !p) return null
  try { return (await rest("GET", `patients?phone=eq.${encodeURIComponent(p)}&select=*`, undefined, ""))[0] ?? null }
  catch (e: any) { console.warn(`[supabase] phone lookup failed: ${e?.message ?? e}`); return null }
}

/** Remembers which phone belongs to an elder (the demo elder gets ELDER_PHONE the first time it calls or is called). */
export function linkPhone(elderId: string, phone: string): Promise<unknown> {
  return quietly("patients phone", rest("PATCH", `patients?id=eq.${encodeURIComponent(elderId)}&phone=is.null`, { phone: normalizePhone(phone) }))
}

/** A number we have not met gets its own profile, filled in during the call (save_profile). Returns its id, or null. */
export async function newCallerProfile(phone: string): Promise<string | null> {
  const p = normalizePhone(phone)
  if (!db() || !p) return null
  const id = `caller-${digits(p)}`
  try {
    await rest("POST", "patients?on_conflict=id", { id, name: "New caller", phone: p }, "resolution=ignore-duplicates,return=minimal")
    return id
  } catch (e: any) { console.warn(`[supabase] new caller profile failed: ${e?.message ?? e}`); return null }
}

const PROFILE_FIELDS = ["name", "age", "conditions", "family_name", "family_relation", "family_phone", "primary_doctor"] as const
export function profileFields(a: Row): Row {
  const out: Row = {}
  for (const k of PROFILE_FIELDS) {
    const v = a[k]
    if (v === undefined || v === null || v === "") continue
    if (k === "age") { const n = Number(v); if (Number.isFinite(n) && n > 0 && n < 130) out.age = Math.round(n) }
    else if (k === "conditions") out.conditions = (Array.isArray(v) ? v : String(v).split(",")).map(x => String(x).trim()).filter(Boolean)
    else if (k === "family_phone") out.family_phone = normalizePhone(String(v)) || String(v)
    else out[k] = String(v).trim()
  }
  return out
}

/** save_profile: what the caller told the agent about themselves, stored on their patient row. */
export async function saveProfile(elderId: string, fields: Row): Promise<void> {
  if (!db()) throw new Error("profiles need Supabase (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)")
  await rest("PATCH", `patients?id=eq.${encodeURIComponent(elderId)}`, fields)
}

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

// Summaries that say nothing about the person (an early hang-up, a call that never connected): kept in the archive,
// left out of what the agent hears as their history.
const EMPTY_SUMMARY = /^(call ended( before the wrap-up)?\.?|phone check-in finished\.?|the check-in call did not connect\b.*)$/i

/** The person's history from Supabase, for the voice agent: their last calls and recent symptoms, newest first. */
export async function historyFor(elderId: string): Promise<string[]> {
  if (!db()) return []
  const id = encodeURIComponent(elderId)
  try {
    const [recent, symptoms]: Row[][] = await Promise.all([
      rest("GET", `calls?patient_id=eq.${id}&summary=not.is.null&select=ended_at,summary,mood&order=ended_at.desc&limit=12`, undefined, ""),
      rest("GET", `care_events?patient_id=eq.${id}&kind=eq.symptom&select=created_at,text,data&order=created_at.desc&limit=5`, undefined, ""),
    ])
    const calls = recent.filter(c => !EMPTY_SUMMARY.test(String(c.summary).trim())).slice(0, 3)
    const lines: string[] = []
    if (calls.length) lines.push("Earlier calls (newest first):", ...calls.map(c => `- ${when(c.ended_at)}: ${String(c.summary).slice(0, 300)}${c.mood ? ` (mood: ${c.mood})` : ""}`))
    if (symptoms.length) lines.push("Recent symptoms on record:", ...symptoms.map(e => `- ${when(e.created_at)}: ${e.text}${e.data?.severity ? ` (${e.data.severity})` : ""}`))
    return lines
  } catch (e: any) {
    console.warn(`[supabase] history for ${elderId} failed: ${e?.message ?? e}`)
    return []
  }
}
