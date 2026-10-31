// The case flow: four agents on Agent Relay, each reacting only to the relay messages meant for it.
// caretaker posts the case -> doctor triages with the hospital record and replies { urgency, actions } ->
// pharmacy confirms the refill -> family agent drafts the family text. Every message is mirrored to the actor (the Care Feed).
import type { Agent, Relay } from "./relay"
import type { ActorBridge } from "./actor"
import { loadRecord, saveCareEvent } from "./records"
import { bare, caseNote, clip, triage, refillNote, familyText, type Urgency } from "./brain"

export const KINDS = ["symptom", "refill", "vitals", "summary", "teach_back"] as const
export type Escalation = { elderId: string; kind: (typeof KINDS)[number]; reason: string; details?: Record<string, unknown> }
type Lane = "doctor" | "pharmacy" | "family"
type Case = { id: string; lastAt: number; refills: Set<string>; urgency: Urgency }

const RANK: Record<Urgency, number> = { ok: 0, watch: 1, urgent: 2 }
const medKey = (med: unknown) => String(med ?? "").trim().split(/\s+/)[0].toLowerCase()

export const channelFor = (elderId: string) => `care-${elderId.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`

// POST /escalate body check (trust boundary): returns an error message, or null when valid.
export function invalid(b: any): string | null {
  if (!b || typeof b !== "object") return "body must be a JSON object"
  if (typeof b.elderId !== "string" || !b.elderId.trim()) return "elderId is required"
  if (!KINDS.includes(b.kind)) return `kind must be one of ${KINDS.join(", ")}`
  if (typeof b.reason !== "string" || !b.reason.trim()) return "reason is required"
  if (b.details !== undefined && (typeof b.details !== "object" || b.details === null || Array.isArray(b.details))) return "details must be an object"
  return null
}

export function startCareTeam(relay: Relay, actor: ActorBridge, records = loadRecord) {
  // Sends over the relay, then mirrors that message to the actor timeline. A failed mirror never blocks the case.
  async function send(from: Agent, to: string, lane: Lane, text: string, data: Record<string, any>, dmTo?: Agent) {
    if (text.length > 240) console.warn(`[care-team] ${from}: clipped a ${text.length}-char message for the Care Feed`)
    text = clip(text)
    const channel = channelFor(data.elderId)
    const msg = dmTo ? await relay.dm(from, dmTo, text, data) : await relay.post(from, channel, text, data)
    console.log(`[relay] ${msg.id} ${msg.ts} ${from} -> ${dmTo ? `@${dmTo}` : `#${channel}`}: ${text}`)
    const event = { kind: "agent_msg" as const, from, to, text, data: { ...data, lane, relay: relay.mode, relayId: msg.id, relayTs: msg.ts, via: dmTo ? "dm" : channel } }
    await actor.logEvent(data.elderId, event).catch((e) => console.warn(`[actor] logEvent failed: ${(e as Error).message}`))
    void saveCareEvent(data.elderId, event)
  }

  const owner = (kind: Escalation["kind"]): Lane => (kind === "refill" ? "pharmacy" : kind === "summary" || kind === "teach_back" ? "family" : "doctor")

  // One case per call: escalations for an elder within CASE_WINDOW_MS join the open case, so one call is one thread.
  const open = new Map<string, Case>() // by elderId
  const byId = new Map<string, Case>()
  function caseFor(elderId: string): Case {
    const now = Date.now()
    const c = open.get(elderId)
    if (c && now - c.lastAt < Number(process.env.CASE_WINDOW_MS || 180_000)) return Object.assign(c, { lastAt: now })
    if (c) byId.delete(c.id)
    const fresh: Case = { id: crypto.randomUUID().slice(0, 8), lastAt: now, refills: new Set(), urgency: "ok" }
    open.set(elderId, fresh)
    byId.set(fresh.id, fresh)
    return fresh
  }
  // Each med is refilled once per case: the first request wins. Synchronous check-and-mark, so two requests cannot race.
  function firstRefill(k: Case | undefined, med: unknown): boolean {
    const key = medKey(med)
    if (!k || !key) return true
    if (k.refills.has(key)) return false
    k.refills.add(key)
    return true
  }

  // Returns at once with the case id; the agents work the case asynchronously.
  function escalate(e: Escalation): string {
    const k = caseFor(e.elderId)
    const caseId = k.id
    if (e.kind === "refill" && !firstRefill(k, e.details?.med)) {
      console.log(`[care-team] case ${caseId}: ${e.details?.med} refill already requested, skipping`)
      return caseId
    }
    const c = { type: "case", caseId, elderId: e.elderId, kind: e.kind, reason: e.reason, details: e.details ?? {}, for: owner(e.kind) }
    void (async () => {
      await relay.ensureChannel(channelFor(e.elderId))
      await send("caretaker", c.for, c.for, await caseNote(c, await records(e.elderId)), c)
    })().catch((err) => console.error(`[care-team] case ${caseId} failed:`, err))
    return caseId
  }

  relay.listen("doctor", async (m) => {
    if (m.data.type !== "case" || m.data.for !== "doctor") return
    const { caseId, elderId } = m.data
    const record = await records(elderId)
    const d = await triage(m.data, record)
    const k = byId.get(caseId)
    if (k && RANK[k.urgency] > RANK[d.urgency]) d.urgency = k.urgency // within a case, urgency never goes down
    if (k) k.urgency = d.urgency
    const name = record.patient?.name ?? elderId
    await send("doctor", "caretaker", "doctor", d.text, { type: "decision", caseId, elderId, urgency: d.urgency, reason: d.reason, actions: d.actions, recheck: d.recheck, refillMed: d.refillMed, notifyFamily: d.notifyFamily })
    if (d.refillMed && firstRefill(k, d.refillMed)) await send("doctor", "pharmacy", "pharmacy", `Please refill ${d.refillMed} for ${name} today.`, { type: "refill_request", caseId, elderId, med: d.refillMed }, "pharmacy")
    const plan = d.actions.length ? ` Plan: ${d.actions.map(bare).join("; ")}.` : ""
    if (d.notifyFamily) await send("doctor", "family", "family", `Please update ${record.patient?.family_name ?? `${name}'s family`}: ${name} is on ${d.urgency.toUpperCase()}. ${bare(d.reason)}.${plan}`, { type: "notify_family", caseId, elderId, urgency: d.urgency, reason: d.reason, actions: d.actions }, "family")
  })

  relay.listen("caretaker", async (m) => {
    if (m.data.type !== "decision") return
    await actor.setStatus(m.data.elderId, m.data.urgency, m.data.reason)
    const secs = m.data.urgency === "urgent" ? Number(process.env.URGENT_RECHECK_SECONDS || 60) : Number(process.env.RECHECK_SECONDS || 120)
    if (m.data.recheck) await actor.scheduleCheckIn(m.data.elderId, Date.now() + secs * 1000, "Doctor asked for a recheck")
  })

  relay.listen("pharmacy", async (m) => {
    const { type, caseId, elderId } = m.data
    if (type !== "refill_request" && !(type === "case" && m.data.for === "pharmacy")) return
    const r = await refillNote(m.data.med ?? m.data.details?.med, await records(elderId))
    await send("pharmacy", m.from, "pharmacy", r.text, { type: "refill_ready", caseId, elderId, med: r.med })
  })

  relay.listen("family", async (m) => {
    const { type, caseId, elderId } = m.data
    if (type !== "notify_family" && !(type === "case" && m.data.for === "family")) return
    const record = await records(elderId)
    await send("family", "family-contact", "family", await familyText(m.data, record), { type: "family_message", caseId, elderId, contact: record.patient?.family_name ?? null, relation: record.patient?.family_relation ?? null })
  })

  return { escalate }
}
