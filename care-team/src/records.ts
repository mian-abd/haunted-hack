// Hospital records for the doctor and pharmacy agents.
// Order: Supabase (when SUPABASE_URL + key are set) -> supabase/seed.json -> a built-in demo record.

import { resolve } from "node:path"
import type { Config } from "./config.ts"
import type { ClinicalNote, HospitalRecord, Patient, Prescription } from "./types.ts"

interface SeedFile {
  patients: Patient[]
  prescriptions: Prescription[]
  clinical_notes: ClinicalNote[]
}

/**
 * Used only when neither Supabase nor supabase/seed.json is available.
 * The seed owner (P4) keeps supabase/seed.json as the source of truth; keep these names in sync with it.
 */
export const BUILTIN_SEED: SeedFile = {
  patients: [{
    id: "grandpa-joe",
    name: "Joe Miller",
    age: 82,
    conditions: ["hypertension", "type 2 diabetes"],
    family_name: "Linda",
    family_relation: "daughter",
    primary_doctor: "Dr. Patel",
  }],
  prescriptions: [
    { patient_id: "grandpa-joe", name: "lisinopril", dose: "10 mg", times: ["08:00"], purpose: "blood pressure", prescriber: "Dr. Patel", refills_left: 2 },
    { patient_id: "grandpa-joe", name: "metformin", dose: "500 mg", times: ["08:00", "18:00"], purpose: "blood sugar, take with meals", prescriber: "Dr. Patel", refills_left: 3 },
  ],
  clinical_notes: [
    { patient_id: "grandpa-joe", author: "Dr. Patel", note: "BP well controlled on lisinopril 10 mg. Watch for dizziness if doses are missed then doubled. Metformin with breakfast and dinner.", created_at: "2026-10-01T16:00:00Z" },
  ],
}

export interface Records {
  get(elderId: string): Promise<HospitalRecord | null>
  readonly source: string
}

export function createRecords(config: Config, log = console): Records {
  let seedCache: SeedFile | null | undefined

  async function loadSeed(): Promise<{ seed: SeedFile; source: HospitalRecord["source"] }> {
    if (seedCache === undefined) {
      const path = resolve(process.cwd(), config.seedPath)
      try {
        const file = Bun.file(path)
        seedCache = (await file.exists()) ? ((await file.json()) as SeedFile) : null
      } catch (err) {
        log.warn(`[records] could not parse ${path}: ${String(err)}`)
        seedCache = null
      }
      if (!seedCache) log.warn(`[records] ${path} not found; using the built-in demo record`)
    }
    return seedCache ? { seed: seedCache, source: "seed.json" } : { seed: BUILTIN_SEED, source: "builtin" }
  }

  async function fromSupabase(elderId: string): Promise<HospitalRecord | null> {
    const base = config.supabaseUrl!.replace(/\/$/, "")
    const headers = { apikey: config.supabaseKey!, Authorization: `Bearer ${config.supabaseKey}` }
    const q = (table: string, column: string) =>
      fetch(`${base}/rest/v1/${table}?${column}=eq.${encodeURIComponent(elderId)}&select=*`, { headers, signal: AbortSignal.timeout(4000) })
        .then((r) => {
          if (!r.ok) throw new Error(`${table}: HTTP ${r.status}`)
          return r.json() as Promise<unknown[]>
        })
    const [patients, prescriptions, notes] = await Promise.all([
      q("patients", "id"), q("prescriptions", "patient_id"), q("clinical_notes", "patient_id"),
    ])
    const patient = patients[0] as Patient | undefined
    if (!patient) return null
    return { patient, prescriptions: prescriptions as Prescription[], notes: notes as ClinicalNote[], source: "supabase" }
  }

  return {
    get source() {
      return config.supabaseUrl && config.supabaseKey ? "supabase" : "seed.json"
    },
    async get(elderId) {
      if (config.supabaseUrl && config.supabaseKey) {
        try {
          const rec = await fromSupabase(elderId)
          if (rec) return rec
        } catch (err) {
          log.warn(`[records] Supabase read failed, falling back to seed: ${String(err)}`)
        }
      }
      const { seed, source } = await loadSeed()
      const patient = seed.patients.find((p) => p.id === elderId)
      if (!patient) return null
      return {
        patient,
        prescriptions: seed.prescriptions.filter((p) => p.patient_id === elderId),
        notes: seed.clinical_notes.filter((n) => n.patient_id === elderId),
        source,
      }
    },
  }
}
