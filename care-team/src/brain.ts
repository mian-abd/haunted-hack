// Each agent's brain: OpenAI Chat Completions with a short role prompt, or MOCK canned replies (the PLAN.md storyline)
// when OPENAI_API_KEY is unset. A failed OpenAI call also falls back to the mock so the demo never stalls.
import type { HospitalRecord } from "./records"

export const MODEL = process.env.OPENAI_MODEL || "gpt-6-luna"
export const brainMode = () => (process.env.OPENAI_API_KEY ? "openai" : "mock")

export type Urgency = "ok" | "watch" | "urgent"
export type Decision = { text: string; urgency: Urgency; reason: string; actions: string[]; refillMed: string | null; notifyFamily: boolean; recheck: boolean }
type Data = Record<string, any>

const ROLE = {
  caretaker: "You are the caretaker agent on Unc, an AI care team for an aging parent. You hand cases to a doctor, a pharmacy and a family agent. Write one or two short sentences handing this case to the named teammate: who, what happened, what you need. Plain text.",
  doctor: `You are the doctor agent on Unc. You triage with the hospital record; you never diagnose or start new drugs, and you escalate to humans when in doubt. Never tell anyone to double a missed dose. Reply with JSON only: {"urgency":"ok"|"watch"|"urgent","reason":"short reason","actions":["short steps"],"refill_med":"medication name or null","notify_family":true,"recheck":true,"message":"2-3 plain sentences for the care team"}`,
  pharmacy: "You are the pharmacy agent on Unc. Confirm the refill in one short sentence with the medication, dose, ready time and pickup place.",
  family: "You are the family agent on Unc. Write a warm, plain-English text message (2-4 short sentences) to the elder's family contact. No jargon, no alarm: what happened, what the team is doing, when they will hear next. End with '- Unc'.",
}

async function llm(system: string, context: unknown, json = false): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      reasoning_effort: "low", // latency matters more than depth for these short replies
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
    console.warn(`[brain] ${role}: OpenAI failed, using the mock reply (${(e as Error).message})`)
    return mock()
  }
}

const nameOf = (r: HospitalRecord, fallback: string) => r.patient?.name ?? fallback
const findMed = (r: HospitalRecord, med?: string) =>
  med ? r.prescriptions.find((p) => p.name.toLowerCase().startsWith(med.toLowerCase().split(" ")[0])) : undefined

export function caseNote(c: Data, r: HospitalRecord): Promise<string> {
  const details = Object.entries(c.details ?? {}).map(([k, v]) => `${k}: ${v}`).join(", ")
  return think("caretaker", () => llm(ROLE.caretaker, { to: c.for, case: c, patient: r.patient }),
    () => `New ${String(c.kind).replace("_", "-")} case for ${nameOf(r, c.elderId)}: ${c.reason}${details ? ` (${details})` : ""}. @${c.for}, can you take it?`)
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
      reason: String(j.reason ?? c.reason),
      actions: Array.isArray(j.actions) ? j.actions.map(String) : [],
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
