// What each agent says. Scripted rules always run (mock mode and safety floor);
// with OPENAI_API_KEY the doctor, pharmacy and family agents write their turns with an LLM.

import type { Config } from "./config.ts"
import type { Escalation, HospitalRecord, Prescription, Status, Triage } from "./types.ts"

export interface CaseView {
  elderId: string
  caseId: string
  escalations: Escalation[]
  record: HospitalRecord | null
  triage?: Triage
  nextCheckInAt?: number
}

export type BriefKind = "triage" | "teach_back" | "summary"

export interface Brains {
  readonly mode: "openai" | "scripted"
  triage(c: CaseView): Promise<Triage>
  pharmacy(c: CaseView, med: string): Promise<string>
  familyDraft(c: CaseView, brief: string, kind: BriefKind): Promise<string>
}

function timeOfDay(hhmm: string): string {
  const h = Number(hhmm.split(":")[0])
  if (!Number.isFinite(h)) return hhmm
  return h < 11 ? "with breakfast" : h < 15 ? "with lunch" : h < 21 ? "with dinner" : "at bedtime"
}

// ---------- shared helpers ----------

const DANGER = /chest pain|can'?t breathe|cannot breathe|short(ness)? of breath|faint|passed out|fell|a fall|fallen|slurred|confus|one side|numb|unresponsive|stroke|seizure/i
const OUT_OF = /(ran out|run out|out of|no more|finished (my|his|her)|empty)/i

export const displayTz = () => process.env.DISPLAY_TZ || "America/Los_Angeles"
export const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: displayTz() })

export function caseText(c: CaseView): string {
  return c.escalations.map((e) => `${e.reason} ${JSON.stringify(e.details ?? {})}`).join(" ").toLowerCase()
}

export function heartRate(c: CaseView): number | null {
  for (const e of [...c.escalations].reverse()) {
    const hr = Number((e.details as { heartRate?: unknown } | undefined)?.heartRate)
    if (Number.isFinite(hr) && hr > 0) return hr
  }
  return null
}

export function findMed(c: CaseView, hint: string): Prescription | undefined {
  const meds = c.record?.prescriptions ?? []
  const h = hint.toLowerCase()
  return meds.find((m) => h.includes(m.name.toLowerCase()) || m.name.toLowerCase().includes(h))
    ?? (/(blood[- ]?pressure|\bbp\b)/.test(h) ? meds.find((m) => /blood pressure/i.test(m.purpose)) : undefined)
}

/** Which medication (exact record name) the elder is out of, if any. */
export function refillNeeded(c: CaseView): string | null {
  for (const e of c.escalations) {
    const med = (e.details as { med?: unknown } | undefined)?.med
    if (e.kind === "refill" && typeof med === "string") return findMed(c, med)?.name ?? med
  }
  const text = caseText(c)
  if (!OUT_OF.test(text)) return null
  return findMed(c, text)?.name ?? null
}

export function scriptedUrgency(c: CaseView): Status {
  const text = caseText(c)
  const hr = heartRate(c)
  const high = c.escalations.some((e) => (e.details as { severity?: unknown } | undefined)?.severity === "high")
  if (high || DANGER.test(text) || (hr !== null && (hr >= 130 || hr <= 40))) return "urgent"
  const concerning = c.escalations.some((e) => e.kind === "symptom" || e.kind === "vitals")
  return concerning ? "watch" : "ok"
}

const rank: Record<Status, number> = { ok: 0, watch: 1, urgent: 2 }
const maxStatus = (a: Status, b: Status): Status => (rank[a] >= rank[b] ? a : b)

function name(c: CaseView) {
  return c.record?.patient.name.split(" ")[0] ?? "Your parent"
}
function parentWord(c: CaseView) {
  return c.record?.patient.family_relation === "son" || c.record?.patient.family_relation === "daughter" ? "Dad" : name(c)
}

// ---------- scripted brains (mock mode, and fallback for every LLM turn) ----------

export function createScriptedBrains(config: Pick<Config, "recheckSeconds" | "urgentRecheckSeconds">): Brains {
  return {
    mode: "scripted",

    async triage(c) {
      const urgency = scriptedUrgency(c)
      const refill = refillNeeded(c)
      const med = refill ? findMed(c, refill) : undefined
      const doctor = c.record?.patient.primary_doctor ?? "the primary doctor"
      const text = caseText(c)
      const dizzy = /dizz|lighthead/.test(text)
      const hr = heartRate(c)

      if (urgency === "urgent") {
        return {
          urgency,
          reason: hr !== null ? `Heart rate ${hr} bpm reported` : "Danger sign reported on the call",
          actions: [
            "Call 911 now if he is unresponsive, has chest pain or cannot stand",
            `Page ${doctor}'s on-call clinician (human) now`,
            "Family: go to him or stay on the phone with him",
          ],
          recheckInSec: config.urgentRecheckSeconds,
          needsRefill: refill,
          familyHeadline: `${parentWord(c)} needs attention now: ${hr !== null ? `his heart rate is ${hr}` : "he reported a warning sign"}. The care team has paged his doctor.`,
        }
      }
      if (urgency === "watch") {
        const symptom = dizzy ? "Dizziness" : "New symptom"
        const why = med ? ` after running out of ${med.name} (${med.purpose})` : ""
        const actions = [
          ...(med ? [`Restart ${med.name} ${med.dose} once picked up; do not double doses`] : []),
          ...(dizzy ? ["Sit or lie down when dizzy, stand up slowly, drink water"] : ["Rest and keep fluids up"]),
          `Escalate to ${doctor} (human) if it persists or worsens`,
        ]
        return {
          urgency,
          reason: `${symptom}${why}. Watch, not an emergency.`,
          actions,
          recheckInSec: config.recheckSeconds,
          needsRefill: refill,
          familyHeadline: `${parentWord(c)} is OK but ${dizzy ? "dizzy" : "not feeling great"}${med ? `. He ran out of his ${med.purpose} pills and a refill is being arranged` : ""}.`,
        }
      }
      return {
        urgency: "ok",
        reason: "Routine check-in, nothing concerning",
        actions: ["Continue current medications as prescribed"],
        recheckInSec: null,
        needsRefill: refill,
        familyHeadline: `${parentWord(c)} is doing well today.`,
      }
    },

    async pharmacy(c, medName) {
      const med = findMed(c, medName)
      if (!med) return `Refill request for ${medName} received. Checking the prescription with the doctor's office now.`
      if (med.refills_left <= 0) {
        return `${med.name} ${med.dose}: no refills left. Renewal request sent to ${med.prescriber}; ready tomorrow 10 am once approved.`
      }
      const left = med.refills_left - 1
      return `Refill ready: ${med.name} ${med.dose}, approved by ${med.prescriber} (${left} refill${left === 1 ? "" : "s"} left after this). Ready for pickup at 5 pm today, delivery available.`
    },

    async familyDraft(c, brief, kind) {
      const family = c.record?.patient.family_name ?? "there"
      const next = c.nextCheckInAt ? ` Next check-in call at ${clock(c.nextCheckInAt)}.` : ""
      if (kind === "teach_back") {
        const tb = [...c.escalations].reverse().find((e) => e.kind === "teach_back")
        const med = findMed(c, tb ? `${tb.reason} ${JSON.stringify(tb.details ?? {})}` : brief)
        const timing = med ? ` ${med.name} (it's ${med.times.map(timeOfDay).join(" and ")}, for ${med.purpose})` : " a medication"
        return `Hi ${family}, quick note: ${parentWord(c)} mixed up when to take${timing}. The call walked him through it; a reminder at mealtime would help. — Unc care team`
      }
      if (kind === "summary") {
        const s = [...c.escalations].reverse().find((e) => e.kind === "summary")
        return `Hi ${family}, today's check-in with ${parentWord(c)} is done: ${s?.reason ?? brief}.${next} — Unc care team`
      }
      if (c.triage) return `Hi ${family}, ${c.triage.familyHeadline} We're on it and will call him again soon.${next} — Unc care team`
      return `Hi ${family}, update from today's check-in: ${brief}${next} — Unc care team`
    },
  }
}

// ---------- OpenAI brains ----------

const TRIAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["urgency", "reason", "actions", "needsRefill", "familyHeadline"],
  properties: {
    urgency: { type: "string", enum: ["ok", "watch", "urgent"] },
    reason: { type: "string" },
    actions: { type: "array", items: { type: "string" } },
    needsRefill: { type: ["string", "null"] },
    familyHeadline: { type: "string" },
  },
} as const

function recordSummary(c: CaseView): string {
  const r = c.record
  if (!r) return "No hospital record on file."
  const meds = r.prescriptions.map((m) => `${m.name} ${m.dose} at ${m.times.join(", ")} for ${m.purpose} (prescriber ${m.prescriber}, refills left ${m.refills_left})`)
  const notes = r.notes.slice(-3).map((n) => `${n.author}: ${n.note}`)
  return [
    `Patient: ${r.patient.name}, ${r.patient.age}. Conditions: ${r.patient.conditions.join(", ")}. Primary doctor: ${r.patient.primary_doctor}. Family contact: ${r.patient.family_name} (${r.patient.family_relation}).`,
    `Medications: ${meds.join("; ") || "none"}.`,
    `Clinical notes: ${notes.join(" | ") || "none"}.`,
  ].join("\n")
}

function escalationSummary(c: CaseView): string {
  return c.escalations.map((e, i) => `${i + 1}. [${e.kind}] ${e.reason}${e.details ? ` ${JSON.stringify(e.details)}` : ""}`).join("\n")
}

export function createOpenAIBrains(
  config: Pick<Config, "openaiApiKey" | "openaiModel" | "openaiTimeoutMs" | "recheckSeconds" | "urgentRecheckSeconds">,
  fetchImpl: typeof fetch = fetch,
): Brains {
  const scripted = createScriptedBrains(config)

  async function chat(system: string, user: string, schema?: object): Promise<string> {
    const body: Record<string, unknown> = {
      model: config.openaiModel,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      max_completion_tokens: 400,
    }
    if (schema) body.response_format = { type: "json_schema", json_schema: { name: "result", strict: true, schema } }
    const res = await fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openaiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.openaiTimeoutMs),
    })
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = json.choices?.[0]?.message?.content?.trim()
    if (!content) throw new Error("OpenAI returned no content")
    return content
  }

  async function orFallback<T>(label: string, llm: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    try {
      return await llm()
    } catch (err) {
      console.warn(`[brains] ${label} LLM turn failed, using scripted text: ${String(err).slice(0, 200)}`)
      return fallback()
    }
  }

  return {
    mode: "openai",

    triage: (c) => orFallback("doctor", async () => {
      const floor = await scripted.triage(c)
      const raw = await chat(
        [
          "You are the doctor agent on an elder-care team. You triage; you never diagnose, never change prescriptions, and you hand anything serious to a human clinician.",
          "Decide urgency: ok (routine), watch (needs a recheck call soon and family awareness), urgent (possible emergency: advise calling 911 and paging the human clinician).",
          "Danger signs are always urgent: chest pain, trouble breathing, fainting, a fall, confusion, slurred speech, one-sided weakness, heart rate over 130 or under 40.",
          "actions: 2 to 4 concrete steps, each under 15 words.",
          "reason: one short line a busy nurse can read in 3 seconds.",
          "needsRefill: the exact medication name from the record if he is out of it, otherwise null.",
          "familyHeadline: one warm, calm, plain-words sentence for the adult child, e.g. 'Dad is OK but dizzy.'",
        ].join("\n"),
        `Hospital record:\n${recordSummary(c)}\n\nWhat the check-in call reported:\n${escalationSummary(c)}`,
        TRIAGE_SCHEMA,
      )
      const t = JSON.parse(raw) as Omit<Triage, "recheckInSec">
      const meds = c.record?.prescriptions.map((m) => m.name.toLowerCase()) ?? []
      const llmRefill = t.needsRefill && meds.includes(t.needsRefill.toLowerCase()) ? t.needsRefill : null
      // Safety floor: the LLM can raise urgency, never lower it below the rule-based reading.
      const urgency = maxStatus(t.urgency, floor.urgency)
      return {
        urgency,
        reason: t.reason || floor.reason,
        actions: t.actions?.length ? t.actions.slice(0, 4) : floor.actions,
        recheckInSec: urgency === "urgent" ? config.urgentRecheckSeconds : urgency === "watch" ? config.recheckSeconds : null,
        needsRefill: llmRefill ?? floor.needsRefill,
        familyHeadline: urgency === floor.urgency || urgency !== "urgent" ? t.familyHeadline || floor.familyHeadline : floor.familyHeadline,
      }
    }, () => scripted.triage(c)),

    pharmacy: (c, med) => orFallback("pharmacy", async () => {
      const m = findMed(c, med)
      return chat(
        "You are the pharmacy agent on an elder-care team. Reply in 1-2 short sentences confirming the refill: medication, dose, prescriber approval, refills left after this one, and a pickup time today (say 'Ready at 5 pm'). If refills left is 0, say you sent a renewal request to the prescriber instead. No greetings.",
        m ? `Refill request: ${m.name} ${m.dose} for ${m.purpose}. Prescriber: ${m.prescriber}. Refills left: ${m.refills_left}.` : `Refill request: ${med}. Not found in the record.`,
      )
    }, () => scripted.pharmacy(c, med)),

    familyDraft: (c, brief, kind) => orFallback("family", async () => {
      const p = c.record?.patient
      const next = c.nextCheckInAt ? `The next check-in call is at ${clock(c.nextCheckInAt)}.` : ""
      const focus = kind === "teach_back"
        ? "This note is only about the medication timing mix-up and how the family can help remember it."
        : kind === "summary"
          ? "This note is the end-of-call summary."
          : "This note is about the doctor agent's triage decision."
      return chat(
        [
          `You are the family liaison agent. Write the text message that goes to ${p?.family_name ?? "the family"} (${p?.family_relation ?? "family"}) about their parent ${p?.name ?? ""}.`,
          `2-3 short sentences. Warm, calm, plain words, no jargon, no diagnosis. Start with 'Hi ${p?.family_name ?? "there"},'. Say what happened, what the care team is doing, and when the next check-in is if known. End with '— Unc care team'.`,
          focus,
        ].join("\n"),
        `Care team brief:\n${brief}\n${kind === "triage" && c.triage ? `Doctor agent headline: ${c.triage.familyHeadline}` : ""}\n${next}`,
      )
    }, () => scripted.familyDraft(c, brief, kind)),
  }
}

export function createBrains(config: Config): Brains {
  return config.openaiApiKey ? createOpenAIBrains(config) : createScriptedBrains(config)
}
