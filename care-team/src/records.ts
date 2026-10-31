// Hospital record for the doctor: Supabase (PostgREST) when configured, else ../supabase/seed.json (shape in PLAN.md).
export type Patient = {
  id: string; name: string; age: number; conditions: string[]
  family_name: string; family_relation: string; family_phone?: string; primary_doctor: string
}
export type Prescription = { patient_id: string; name: string; dose: string; times: string[]; purpose: string; prescriber: string; refills_left: number }
export type ClinicalNote = { patient_id: string; author: string; note: string; created_at: string }
export type HospitalRecord = { patient: Patient | null; prescriptions: Prescription[]; clinical_notes: ClinicalNote[]; source: "supabase" | "seed" | "none" }

const SEED = new URL("../../supabase/seed.json", import.meta.url)

// PostgREST auth. A legacy service_role key is a JWT: apikey + Authorization: Bearer. A new sb_secret_ key is not a JWT,
// and Supabase rejects it as a Bearer token ("API keys" docs, Known limitations): apikey only.
export const supabaseAuth = (key: string): Record<string, string> =>
  key.split(".").length === 3 ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key }

// Care team history: every relay message also lands in Supabase care_events, next to the server's timeline events.
// Fire-and-forget, and skipped when Supabase is not configured.
export function saveCareEvent(elderId: string, e: { kind: string; from?: string; to?: string; text: string; data?: Record<string, unknown> }): Promise<void> {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "")
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return Promise.resolve()
  return fetch(`${url}/rest/v1/care_events`, {
    method: "POST",
    headers: { ...supabaseAuth(key), "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ patient_id: elderId, kind: e.kind, from_agent: e.from ?? null, to_agent: e.to ?? null, text: e.text, data: e.data ?? null }),
    signal: AbortSignal.timeout(5_000),
  })
    .then(async (r) => { if (!r.ok) console.warn(`[records] care_events insert failed ${r.status}: ${(await r.text()).slice(0, 200)}`) })
    .catch((err) => console.warn(`[records] care_events insert failed: ${(err as Error).message}`))
}

export async function loadRecord(elderId: string): Promise<HospitalRecord> {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "")
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (url && key) {
    try {
      const get = async (query: string) => {
        const res = await fetch(`${url}/rest/v1/${query}`, { headers: supabaseAuth(key), signal: AbortSignal.timeout(8_000) })
        if (!res.ok) throw new Error(`${res.status} on ${query.split("?")[0]}`)
        return res.json()
      }
      const id = encodeURIComponent(elderId)
      const [patients, prescriptions, clinical_notes] = await Promise.all([
        get(`patients?id=eq.${id}&select=*`),
        get(`prescriptions?patient_id=eq.${id}&select=*`),
        get(`clinical_notes?patient_id=eq.${id}&select=*&order=created_at.desc&limit=5`),
      ])
      if (patients[0]) return { patient: patients[0], prescriptions, clinical_notes, source: "supabase" }
      console.warn(`[records] no Supabase patient ${elderId}, using seed.json`)
    } catch (e) {
      console.warn(`[records] Supabase read failed (${(e as Error).message}), using seed.json`)
    }
  }
  try {
    const seed = await Bun.file(SEED).json()
    return {
      patient: seed.patients.find((p: Patient) => p.id === elderId) ?? null,
      prescriptions: seed.prescriptions.filter((p: Prescription) => p.patient_id === elderId),
      clinical_notes: seed.clinical_notes.filter((n: ClinicalNote) => n.patient_id === elderId),
      source: "seed",
    }
  } catch (e) {
    console.warn(`[records] cannot read ${SEED.pathname} (${(e as Error).message}); continuing without a record`)
    return { patient: null, prescriptions: [], clinical_notes: [], source: "none" }
  }
}
