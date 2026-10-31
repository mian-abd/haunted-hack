// Each agent's brain: OpenAI Chat Completions with a short role prompt, or MOCK canned replies (the PLAN.md storyline)
// when OPENAI_API_KEY is unset. A failed OpenAI call also falls back to the mock so the demo never stalls.
import type { HospitalRecord } from "./records"

export const MODEL = process.env.OPENAI_MODEL || "gpt-6-luna"
// "none" measured fastest on gpt-6-luna with the same output quality; some models (gpt-6.1-sol) only accept "low" and up.
const REASONING = process.env.OPENAI_REASONING_EFFORT || "none"
export const brainMode = () => (process.env.OPENAI_API_KEY ? "openai" : "mock")
export const stats = { fallbacks: 0 } // OpenAI calls that failed and used the mock reply (shown in /health)

export type Urgency = "ok" | "watch" | "urgent"
export type Decision = { text: string; urgency: Urgency; reason: string; actions: string[]; refillMed: string | null; notifyFamily: boolean; recheck: boolean }
type Data = Record<string, any>

// Length limits matter: every reply is shown as a card in the live Care Feed.
export const ROLE = {
  doctor: `You are the doctor agent on Unc, an AI care team for an aging parent. Triage the case with the hospital record. You never diagnose or start new drugs, you never tell anyone to double a missed dose, and you escalate to humans when in doubt. Reply with JSON only: {"urgency":"ok"|"watch"|"urgent","reason":"under 80 characters","actions":["at most 3 short steps, under 40 characters each"],"refill_med":"a medicine to refill only if the case says they are out of it, else null","notify_family":true,"recheck":true,"message":"one or two plain sentences for the care team, under 200 characters, starting with the urgency in capitals, like WATCH:"}`,
  pharmacy: "You are the pharmacy agent on Unc. Confirm the refill in one plain sentence under 120 characters: medicine, dose, ready time and pickup place.",
  family: "You are the family agent on Unc. Write a warm, plain-English text to the elder's family contact, starting with 'Hi <their first name>,': at most two short sentences, under 220 characters. Say what happened and what the care team is doing, using only facts from the request; invent no tests, times or plans. No jargon, no alarm. End with '- Unc'.",
}

async function llm(system: string, context: unknown, json = false): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      reasoning_effort: REASONING, // latency matters more than depth for these short replies
      messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(context) }],
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const out = (await res.json()).choices?.[0]?.message?.content?.trim()
  if (!out) throw new Error("OpenAI returned no content")
  return out
}

async function think<T>(role: string, live: () => Promise<T>, mock: () => T): Promise<T> {
  if (!process.env.OPENAI_API_KEY) return mock()
  try {
    return await live()
  } catch (e) {
    stats.fallbacks++
    console.warn(`[brain] ${role}: OpenAI failed, using the mock reply (${(e as Error).message})`)
    return mock()
  }
}

const nameOf = (r: HospitalRecord, fallback: string) => r.patient?.name ?? fallback
/** Hard length cap at a word boundary: the safety net when a model ignores its length limit. */
export const clip = (s: string, max = 240) => (s.length <= max ? s : `${s.slice(0, max - 1).replace(/\s+\S*$/, "")}…`)
const findMed = (r: HospitalRecord, med?: string) =>
  med ? r.prescriptions.find((p) => p.name.toLowerCase().startsWith(med.toLowerCase().split(" ")[0])) : undefined

/** Drops trailing punctuation so a phrase can be joined into a sentence without "..", ".;" or ". ." */
export const bare = (s: string) => String(s).trim().replace(/[\s.;,:]+$/, "")

// The caretaker routes and does not need an LLM: a fixed handoff is instant (an LLM hop cost ~3 s per case) and always
// addresses the right teammate (the LLM version wrote to the daughter instead of the family agent).
export function caseNote(c: Data, r: HospitalRecord): string {
  const who = r.patient ? `${r.patient.name}, ${r.patient.age}` : c.elderId
  const severity = c.details?.severity ? ` (${c.details.severity})` : ""
  const ask = c.for === "doctor" ? "Doctor, please triage." : c.for === "pharmacy" ? "Pharmacy, please fill it today." : `Family agent, please update ${r.patient?.family_name ?? "the family"}.`
  return `Case for ${who}: ${bare(c.reason)}${severity}. ${ask}`
}

// Safety floor: rule-based danger signs are always urgent. The LLM may raise urgency, never lower it.
const DANGER = /chest pain|trouble breathing|can'?t breathe|cannot breathe|short(ness)? of breath|faint|passed out|\bfell\b(?! asleep)|\ba fall\b|fallen|slurred/i

export function dangerSign(c: Data): string | null {
  const hr = Number(c.details?.heartRate)
  if (Number.isFinite(hr) && hr > 0 && (hr >= 130 || hr <= 40)) return `Heart rate ${hr} bpm`
  if (c.details?.severity === "high") return `High-severity symptom: ${c.reason}`
  return DANGER.test(`${c.reason} ${Object.values(c.details ?? {}).join(" ")}`) ? `Danger sign: ${c.reason}` : null
}

// Canned urgent decision (mock mode, and whenever the floor overrides the LLM). Refill only if the case mentions running out.
function urgentDecision(c: Data, r: HospitalRecord, danger: string): Decision {
  const text = `${c.reason} ${Object.values(c.details ?? {}).join(" ")}`.toLowerCase()
  const p = /ran out|run out|out of|refill/.test(text) ? r.prescriptions.find((x) => text.includes(x.name.toLowerCase().split(" ")[0])) : undefined
  const clinician = r.patient?.primary_doctor ?? "the on-call clinician"
  return {
    urgency: "urgent",
    reason: danger,
    actions: ["Call 911 if chest pain, trouble breathing or he can't stand", `Page ${clinician} (a human) now`, "Family: call him or go to him now", "Quick recheck call"],
    refillMed: p?.name ?? null,
    notifyFamily: true,
    recheck: true,
    text: `Triage for ${nameOf(r, c.elderId)}: URGENT. ${danger}. This needs a human now: call 911 if he has chest pain, trouble breathing or can't stand, and I'm paging ${clinician}. Family should call him or go to him now.`,
  }
}

export async function triage(c: Data, r: HospitalRecord): Promise<Decision> {
  const danger = dangerSign(c)
  const d = await think("doctor", async (): Promise<Decision> => {
    const j = JSON.parse(await llm(ROLE.doctor, { case: c, record: r }, true))
    return {
      urgency: ["ok", "watch", "urgent"].includes(j.urgency) ? j.urgency : "watch",
      reason: clip(bare(j.reason ?? c.reason), 120), // also the status reason on the dashboard
      actions: Array.isArray(j.actions) ? j.actions.slice(0, 3).map(bare) : [],
      refillMed: j.refill_med ? String(j.refill_med) : null,
      notifyFamily: j.notify_family !== false,
      recheck: Boolean(j.recheck),
      text: String(j.message ?? j.reason ?? ""),
    }
  }, (): Decision => {
    if (danger) return urgentDecision(c, r, danger)
    // shortcut: canned storyline decision (dizziness + missed Amlodipine) for any non-urgent case; OpenAI mode really triages
    const p = findMed(r, "amlodipine")
    const med = p ? `${p.name} ${p.dose}` : "Amlodipine 5 mg"
    return {
      urgency: "watch",
      reason: "Dizzy after missing Amlodipine (blood pressure)",
      actions: [`Refill ${med}`, "Recheck in 2h", "Notify family", "Do not double the dose"],
      refillMed: p?.name ?? "Amlodipine",
      notifyFamily: true,
      recheck: true,
      text: `Triage for ${nameOf(r, c.elderId)}: WATCH. The dizziness most likely comes from the missed Amlodipine, and no red flags were reported. Plan: refill ${med}, recheck in 2h, notify family. Do not double the dose.`,
    }
  })
  if (!danger || d.urgency === "urgent") return d
  console.warn(`[brain] doctor: LLM said ${d.urgency} despite "${danger}"; the safety floor makes it urgent`)
  return urgentDecision(c, r, danger)
}

export function refillNote(med: string | undefined, r: HospitalRecord): Promise<{ text: string; med: string }> {
  const p = findMed(r, med)
  const label = p ? `${p.name} ${p.dose}` : med || "the prescription"
  return think("pharmacy",
    async () => ({ med: label, text: await llm(ROLE.pharmacy, { med: label, prescription: p, ready_at: "5 PM", place: "the corner pharmacy" }) }),
    () => ({ med: label, text: `Refill for ${label} ready at 5 PM at the corner pharmacy.` }))
}

export function familyText(req: Data, r: HospitalRecord): Promise<string> {
  return think("family", () => llm(ROLE.family, { request: req, patient: r.patient }), () => {
    // shortcut: canned copy written for the demo elder (Grandpa Joe, texting his daughter)
    const who = /daughter|son/i.test(r.patient?.family_relation ?? "") ? "Dad" : nameOf(r, req.elderId)
    const body =
      req.type === "notify_family" && req.urgency === "urgent"
        ? `${who} needs attention now: ${req.reason}. The care team has paged his doctor. Please call him or go to him now; if he can't answer or has chest pain, call 911.`
      : req.type === "notify_family"
        ? `${who} is OK but felt dizzy today. He ran out of his blood pressure pill, so the pharmacy is getting a refill ready and we will call him again in 2 hours. No need to rush over; we will text you if anything changes.`
        : req.kind === "teach_back"
          ? `${who} mixed up when to take one of his medicines (${req.reason}). We went over it together; a gentle reminder from you would help too.`
          : `today's check-in with ${who} is done: ${req.reason}.`
    return `Hi ${r.patient?.family_name ?? "there"}, ${body} - Unc`
  })
}
