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

export function triage(c: Data, r: HospitalRecord): Promise<Decision> {
  return think("doctor", async () => {
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
  }, () => {
    // shortcut: canned storyline decision (dizziness + missed Amlodipine) whatever the case says; OpenAI mode really triages
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
      req.type === "notify_family"
        ? `${who} is OK but felt dizzy today. He ran out of his blood pressure pill, so the pharmacy is getting a refill ready and we will call him again in 2 hours. No need to rush over; we will text you if anything changes.`
        : req.kind === "teach_back"
          ? `${who} mixed up when to take one of his medicines (${req.reason}). We went over it together; a gentle reminder from you would help too.`
          : `today's check-in with ${who} is done: ${req.reason}.`
    return `Hi ${r.patient?.family_name ?? "there"}, ${body} - Unc`
  })
}
