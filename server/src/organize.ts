// Records agent: turns an uploaded patient document (discharge summary, lab report, pharmacy list)
// into the structured patient record, then into Supabase rows. OpenAI when a key is set, rules otherwise.

export type Medication = { name: string; dose: string; times: string[]; purpose: string; refills_left?: number }
export type Organized = { summary: string; conditions: string[]; allergies: string[]; medications: Medication[]; notes: string[]; follow_ups: string[] }
type Section = "conditions" | "allergies" | "medications" | "notes" | "follow_ups"

const MAX_TEXT = 12000, MAX_ITEMS = 20, MAX_LEN = 300
const env = (k: string) => process.env[k]?.trim() ?? ""

const SYSTEM = `You are Troska's records agent. You turn one patient document (a discharge summary, lab report or pharmacy list) into a JSON patient record.
Rules:
- Extract ONLY what the document states. Never invent, guess or infer a condition, allergy, medication, dose, time or appointment.
- Use plain words a family member understands.
- Write times as 24-hour "HH:MM" only when the document states a time. Otherwise leave "times" empty.
- "summary" is at most 2 sentences.
- Use [] or "" when the document does not say.
Return only this JSON object:
{"summary": string, "conditions": string[], "allergies": string[], "medications": [{"name": string, "dose": string, "times": string[], "purpose": string, "refills_left": number (only when stated)}], "notes": string[], "follow_ups": string[]}`

export async function organizeRecord(text: string, patient?: { name?: string; conditions?: string[] } | null): Promise<{ organized: Organized; source: "openai" | "rules" }> {
  const doc = String(text ?? "").slice(0, MAX_TEXT)
  const key = env("OPENAI_API_KEY")
  if (key) {
    try { return { organized: await viaOpenAI(doc, patient, key), source: "openai" } }
    catch (e) { console.warn("organize: OpenAI failed, using rules:", (e as Error).message) }
  }
  return { organized: byRules(doc), source: "rules" }
}

async function viaOpenAI(doc: string, patient: { name?: string; conditions?: string[] } | null | undefined, key: string): Promise<Organized> {
  const context = patient?.name || patient?.conditions?.length
    ? `Known patient (context only, do not copy it unless the document states it): ${patient.name || "unknown"}; known conditions: ${patient.conditions?.join(", ") || "none listed"}.\n\n`
    : ""
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env("OPENAI_MODEL") || "gpt-6-luna",
      reasoning_effort: "none",
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `${context}Document:\n${doc}` }],
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as any
  return clamp(JSON.parse(data?.choices?.[0]?.message?.content ?? ""))
}

const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "").trim().slice(0, MAX_LEN)
const strs = (v: unknown) => (Array.isArray(v) ? v : []).map(str).filter(Boolean).slice(0, MAX_ITEMS)

// Model output is untrusted: keep only strings, at most 20 per list, 300 chars each, times as HH:MM.
export function clamp(raw: unknown): Organized {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>
  const medications = (Array.isArray(r.medications) ? r.medications : [])
    .filter((m: any) => m && typeof m === "object" && str(m.name))
    .slice(0, MAX_ITEMS)
    .map((m: any): Medication => {
      const refills = Number.parseInt(String(m.refills_left ?? ""), 10)
      return {
        name: str(m.name), dose: str(m.dose), times: strs(m.times).flatMap(clockTimes).slice(0, MAX_ITEMS), purpose: str(m.purpose),
        ...(refills >= 0 ? { refills_left: Math.min(refills, 99) } : {}),
      }
    })
  return { summary: str(r.summary), conditions: strs(r.conditions), allergies: strs(r.allergies), medications, notes: strs(r.notes), follow_ups: strs(r.follow_ups) }
}

// "08:00", "8 am", "6 p.m." -> "HH:MM". A bare number such as "500" is not a time.
function clockTimes(s: string): string[] {
  const out: string[] = []
  for (const [, h, min, ap] of s.matchAll(/\b(\d{1,2})(?::([0-5]\d))?(?:\s*([ap])\.?m\b\.?)?/gi)) {
    if (min === undefined && !ap) continue
    let hour = Number(h)
    if (ap) { if (hour < 1 || hour > 12) continue; hour = (hour % 12) + (ap.toLowerCase() === "p" ? 12 : 0) }
    if (hour <= 23) out.push(`${String(hour).padStart(2, "0")}:${min ?? "00"}`)
  }
  return out
}

const SECTIONS: [Section, RegExp][] = [
  ["allergies", /\ballerg(?:y|ies)\b/i],
  ["medications", /\b(?:medications?|meds|medicines?|prescriptions?)\b/i],
  ["conditions", /\b(?:diagnos[ie]s|conditions?|problems?|medical history)\b/i],
  ["follow_ups", /\b(?:follow[ -]?ups?|appointments?|next steps)\b/i],
]
const sectionOf = (label: string) => SECTIONS.find(([, re]) => re.test(label))?.[0]

// A heading starts a section: "Medications:", "Allergies: penicillin", "## Diagnoses", "FOLLOW-UP".
// Other "Label:" lines go to notes, but a one-word "Metformin: 500 mg" inside a section stays an item.
function heading(line: string, inSection: boolean): { key: Section; rest: string } | null {
  const t = line.replace(/\*\*/g, "").replace(/^\s*#+\s*/, "").trim()
  const m = /^([A-Za-z][A-Za-z ,/&()'-]{0,48}?)\s*:\s*(.*)$/.exec(t)
  if (m) {
    const key = sectionOf(m[1])
    if (key) return { key, rest: m[2] }
    if (!m[2] || m[1].includes(" ") || !inSection) return { key: "notes", rest: m[2] ? t : "" }
    return null
  }
  const bare = /^\s*#/.test(line) || t === t.toUpperCase() || /^(?:[a-z]+\s+)?(?:medications|allergies|diagnoses|conditions|problems|follow[ -]?ups?)$/i.test(t)
  const key = sectionOf(t)
  return key && bare && !/\d/.test(t) ? { key, rest: "" } : null
}

const DOSE = /\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|ml|units?|iu|tablets?|tabs?|capsules?|puffs?|drops?)(?![a-z])/i

function parseMed(line: string): Medication {
  const dose = DOSE.exec(line)
  const name = (dose ? line.slice(0, dose.index) : line.split(/\s[-–]\s|[,(:;]/)[0]).replace(/[\s:,–-]+$/, "").trim() || line
  const refills = /refills?\D{0,10}?(\d+)|(\d+)\s*refills?/i.exec(line)
  const purpose = /\bfor\s+(?!\d)(.+?)(?=\s[-–]\s|[,;()]|\s+refills?\b|$)/i.exec(line)?.[1] ?? /\(([^)]*[a-z][^)]*)\)/i.exec(line)?.[1] ?? ""
  return { name, dose: dose?.[0] ?? "", times: clockTimes(line), purpose: purpose.replace(/[.\s]+$/, ""), refills_left: refills ? Number(refills[1] ?? refills[2]) : undefined }
}

// Deterministic fallback: collect lines under known headings, then parse medication lines with regexes.
function byRules(doc: string): Organized {
  const lists: Record<Section, string[]> = { conditions: [], allergies: [], medications: [], notes: [], follow_ups: [] }
  let key: Section | null = null
  for (const line of doc.split(/\r?\n/)) {
    if (!line.trim()) continue
    const h = heading(line, key !== null)
    if (h) key = h.key
    const item = (h ? h.rest : line).replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, "").trim()
    if (!key || !item) continue
    // Inline lists after a heading ("Allergies: penicillin (rash), sulfa") split on commas outside parentheses.
    const parts = h && (key === "allergies" || key === "conditions") ? item.split(/[;,](?![^(]*\))/) : [item]
    lists[key].push(...parts.map(p => p.trim()).filter(Boolean))
  }
  const o = clamp({ ...lists, medications: lists.medications.map(parseMed) })
  o.summary = `Found ${o.medications.length} medications, ${o.allergies.length} allergies, ${o.conditions.length} conditions and ${o.follow_ups.length} follow-ups in this document.`
  return o
}

export function toRows(elderId: string, author: string, o: Organized) {
  const prescriptions = o.medications.map(m => ({
    patient_id: elderId, name: m.name, dose: m.dose, times: m.times, purpose: m.purpose, prescriber: author, refills_left: m.refills_left ?? null,
  }))
  const note = [
    o.summary,
    o.allergies.length ? `Allergies: ${o.allergies.join(", ")}.` : "",
    o.conditions.length ? `Conditions: ${o.conditions.join(", ")}.` : "",
    o.follow_ups.length ? `Follow-ups: ${o.follow_ups.join("; ")}.` : "",
  ].filter(Boolean).join(" ")
  return { prescriptions, clinical_notes: note ? [{ patient_id: elderId, author, note }] : [] }
}
