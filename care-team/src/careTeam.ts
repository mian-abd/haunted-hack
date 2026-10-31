// The care team. Turn order:
//
//   POST /escalate
//     symptom | vitals  -> caretaker #care-<elder>  -> doctor           (case: triage packet)
//     refill            -> caretaker @pharmacy                          (refill_request)
//     teach_back|summary-> caretaker @family                            (family_brief)
//   doctor receives case       -> #channel -> caretaker   (triage: urgency, actions, recheck)
//   caretaker receives triage  -> actor.setStatus + actor.scheduleCheckIn, #channel recheck note,
//                                 @pharmacy refill_request (if out of a med), @family family_brief
//   pharmacy receives request  -> #channel -> caretaker   (refill_confirmed)
//   family receives brief      -> #channel -> family-contact (family_draft: the text to the daughter)
//
// Every agent acts only on a message Agent Relay delivered to it. Every delivered message is
// mirrored once to ElderActor.logEvent({ kind: "agent_msg", data: { lane } }) for the Care Feed.

import type { ActorDirectory } from "./actor.ts"
import { clock, findMed, type BriefKind, type Brains } from "./brains.ts"
import { channelFor, type Config } from "./config.ts"
import type { Records } from "./records.ts"
import type { Destination, InboundMessage, RelayTransport } from "./relay/transport.ts"
import {
  CARE_AGENTS, STEP_LANE,
  type AgentName, type CareAgent, type Escalation, type HospitalRecord, type Status, type Step, type Triage, type UncMeta,
} from "./types.ts"

interface CaseState {
  id: string
  elderId: string
  openedAt: number
  lastAt: number
  escalations: Escalation[]
  record: HospitalRecord | null
  triage?: Triage
  nextCheckInAt?: number
  refillsRequested: Set<string>
}

export interface FeedEntry {
  id: string
  ts: number
  elderId: string
  from: string
  to?: AgentName
  lane?: string
  step?: Step
  urgency?: Status
  text: string
}

export type CareTeamConfig = Pick<Config, "stepDelayMs" | "caseWindowMs">

export interface CareTeamDeps {
  transport: RelayTransport
  actors: ActorDirectory
  brains: Brains
  records: Records
  config: CareTeamConfig
  now?: () => number
}

const isCareAgent = (s: string): s is CareAgent => (CARE_AGENTS as readonly string[]).includes(s)

export class CareTeam {
  readonly feed: FeedEntry[] = []
  private cases = new Map<string, CaseState>()
  private openByElder = new Map<string, string>()
  private seen = new Set<string>()
  private seenOrder: string[] = []
  private sentMeta = new Map<string, UncMeta>()
  private inflight = 0
  private started = false
  private readonly now: () => number

  constructor(private readonly deps: CareTeamDeps) {
    this.now = deps.now ?? Date.now
  }

  get relayMode() {
    return this.deps.transport.mode
  }

  async start() {
    if (this.started) return
    this.deps.transport.onMessage((m) => this.track(this.onInbound(m)))
    await this.deps.transport.start()
    this.started = true
  }

  async stop() {
    await this.deps.transport.stop()
  }

  /** Accepts an escalation and returns at once; the conversation runs in the background. */
  async escalate(e: Escalation): Promise<{ caseId: string }> {
    const c = await this.openCase(e)
    this.track(this.dispatch(c, e))
    return { caseId: c.id }
  }

  /** Resolves when no agent turn is running (tests and the demo script). */
  async whenIdle(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs
    let quietTicks = 0
    while (quietTicks < 3) {
      if (Date.now() > deadline) throw new Error(`care team still busy after ${timeoutMs} ms`)
      await Bun.sleep(15)
      quietTicks = this.inflight === 0 ? quietTicks + 1 : 0
    }
  }

  casesFor(elderId: string) {
    return [...this.cases.values()].filter((c) => c.elderId === elderId).map((c) => ({
      id: c.id, openedAt: c.openedAt, escalations: c.escalations, triage: c.triage, nextCheckInAt: c.nextCheckInAt,
    }))
  }

  // ---------- internals ----------

  private track(p: Promise<unknown>) {
    this.inflight++
    p.catch((err) => console.error("[care-team]", err)).finally(() => this.inflight--)
  }

  private async openCase(e: Escalation): Promise<CaseState> {
    const now = this.now()
    const openId = this.openByElder.get(e.elderId)
    const open = openId ? this.cases.get(openId) : undefined
    if (open && now - open.lastAt < this.deps.config.caseWindowMs) {
      open.escalations.push(e)
      open.lastAt = now
      return open
    }
    const c: CaseState = {
      id: `case_${e.elderId}_${now.toString(36)}`,
      elderId: e.elderId,
      openedAt: now,
      lastAt: now,
      escalations: [e],
      record: await this.deps.records.get(e.elderId),
      refillsRequested: new Set(),
    }
    this.cases.set(c.id, c)
    this.openByElder.set(e.elderId, c.id)
    return c
  }

  private async send(from: CareAgent, dest: Destination, to: AgentName, step: Step, c: CaseState, text: string, extra: Pick<UncMeta, "urgency" | "payload"> = {}) {
    const meta: UncMeta = { unc: 1, elderId: c.elderId, caseId: c.id, step, to, lane: STEP_LANE[step], ...extra }
    const id = await this.deps.transport.send(from, dest, text, meta)
    this.sentMeta.set(id, meta)
    if (this.sentMeta.size > 1000) this.sentMeta.delete(this.sentMeta.keys().next().value!)
    return id
  }

  private channel(c: CaseState): Destination {
    return { channel: channelFor(c.elderId) }
  }

  private async dispatch(c: CaseState, e: Escalation) {
    const who = c.record ? `${c.record.patient.name} (${c.record.patient.age})` : e.elderId
    await this.deps.transport.ensureChannel(channelFor(c.elderId), `Care team for ${who}`)

    switch (e.kind) {
      case "symptom":
      case "vitals":
        return this.send("caretaker", this.channel(c), "doctor", "case", c, this.casePacket(c, e))
      case "refill": {
        const med = String((e.details as { med?: unknown } | undefined)?.med ?? e.reason)
        return this.requestRefill(c, med, `Requested on the call: ${e.reason}`)
      }
      case "teach_back":
        return this.send("caretaker", { dm: "family" }, "family", "family_brief", c,
          `@family Teach-back on the call: ${e.reason}. The agent corrected him gently. Please draft a short note for ${c.record?.patient.family_name ?? "the family"}.`,
          { payload: { kind: "teach_back" } })
      case "summary":
        return this.send("caretaker", { dm: "family" }, "family", "family_brief", c,
          `@family Call summary: ${e.reason}${(e.details as { mood?: unknown } | undefined)?.mood ? ` (mood: ${(e.details as { mood?: unknown }).mood})` : ""}. Please draft the update for ${c.record?.patient.family_name ?? "the family"}.`,
          { payload: { kind: "summary" } })
    }
  }

  private casePacket(c: CaseState, e: Escalation): string {
    const r = c.record
    const lines: string[] = []
    lines.push(c.escalations.length > 1 ? `@doctor Update on the open case.` : `@doctor New case for triage.`)
    if (r) lines.push(`Patient: ${r.patient.name}, ${r.patient.age}; ${r.patient.conditions.join(", ")}.`)
    const details = e.details as { severity?: unknown; heartRate?: unknown; note?: unknown } | undefined
    if (e.kind === "vitals") lines.push(`Vitals alert: heart rate ${details?.heartRate ?? "?"} bpm${details?.note ? ` (${details.note})` : ""}.`)
    else lines.push(`Reported on the check-in call: ${e.reason}${details?.severity ? ` (severity ${details.severity})` : ""}.`)
    const earlier = c.escalations.slice(0, -1).map((x) => x.reason)
    if (earlier.length) lines.push(`Earlier this call: ${earlier.join("; ")}.`)
    if (r?.prescriptions.length) lines.push(`Meds on file: ${r.prescriptions.map((m) => `${m.name} ${m.dose} at ${m.times.join("/")} (${m.purpose})`).join("; ")}.`)
    const note = r?.notes.at(-1)
    if (note) lines.push(`Last note, ${note.author}: ${note.note}`)
    lines.push(`Please triage: urgency, actions, recheck.`)
    return lines.join("\n")
  }

  private async requestRefill(c: CaseState, medHint: string, why: string) {
    const med = findMed(this.view(c), medHint)
    const medName = med?.name ?? medHint
    if (c.refillsRequested.has(medName.toLowerCase())) return
    c.refillsRequested.add(medName.toLowerCase())
    const text = med
      ? `@pharmacy Refill needed for ${c.record?.patient.name ?? c.elderId}: ${med.name} ${med.dose} (${med.purpose}), prescriber ${med.prescriber}. ${why}`
      : `@pharmacy Refill needed for ${c.record?.patient.name ?? c.elderId}: ${medHint}. ${why}`
    await this.send("caretaker", { dm: "pharmacy" }, "pharmacy", "refill_request", c, text, { payload: { med: medName } })
  }

  private async waitForMeta(id: string): Promise<UncMeta | undefined> {
    for (let i = 0; i < 40; i++) {
      const m = this.sentMeta.get(id)
      if (m) return m
      await Bun.sleep(50)
    }
    return undefined
  }

  private markSeen(id: string): boolean {
    if (this.seen.has(id)) return false
    this.seen.add(id)
    this.seenOrder.push(id)
    if (this.seenOrder.length > 2000) this.seen.delete(this.seenOrder.shift()!)
    return true
  }

  private async onInbound(m: InboundMessage) {
    if (!m.id || !this.markSeen(m.id)) return
    const from = m.from.replace(/^@/, "")
    const meta = m.meta ?? (await this.waitForMeta(m.id))

    if (!meta) {
      // Not ours (e.g. a human typed in the channel). Mirror it to the thread, no lane.
      const elderId = m.channel?.startsWith("care-") ? m.channel.slice(5) : undefined
      if (elderId) await this.mirror(elderId, { id: m.id, from, text: m.text })
      return
    }

    await this.mirror(meta.elderId, { id: m.id, from, text: m.text, meta, channel: m.channel })
    if (from === meta.to) return
    const c = this.cases.get(meta.caseId)
    if (!c) return

    if (this.deps.config.stepDelayMs > 0) await Bun.sleep(this.deps.config.stepDelayMs)

    switch (`${meta.to}:${meta.step}`) {
      case "doctor:case":
        return this.doctorTriage(c)
      case "caretaker:triage":
        return this.applyDecision(c, c.triage ?? (meta.payload as unknown as Triage))
      case "pharmacy:refill_request":
        return this.pharmacyReply(c, String(meta.payload?.med ?? ""))
      case "family:family_brief":
        return this.familyReply(c, m.text, (meta.payload?.kind as BriefKind | undefined) ?? "triage")
    }
  }

  private async mirror(elderId: string, m: { id: string; from: string; text: string; meta?: UncMeta; channel?: string }) {
    const entry: FeedEntry = {
      id: m.id, ts: this.now(), elderId, from: m.from, to: m.meta?.to,
      lane: m.meta?.lane, step: m.meta?.step, urgency: m.meta?.urgency, text: m.text,
    }
    this.feed.push(entry)
    if (this.feed.length > 200) this.feed.shift()
    await this.deps.actors.forElder(elderId).logEvent({
      kind: "agent_msg",
      text: m.text,
      from: isCareAgent(m.from) ? m.from : "system",
      to: m.meta?.to,
      data: {
        lane: m.meta?.lane,
        urgency: m.meta?.urgency,
        step: m.meta?.step,
        caseId: m.meta?.caseId,
        messageId: m.id,
        channel: m.channel,
        via: this.deps.transport.mode,
      },
    })
  }

  private async doctorTriage(c: CaseState) {
    const t = await this.deps.brains.triage(this.view(c))
    c.triage = t
    const lines = [
      `@caretaker Triage: ${t.urgency.toUpperCase()}. ${t.reason}`,
      ...t.actions.map((a, i) => `${i + 1}. ${a}`),
      t.recheckInSec ? `Recheck call in ${formatDuration(t.recheckInSec)}.` : `No recheck needed.`,
      `Triage only, no diagnosis.${t.urgency === "urgent" ? " A human clinician is being paged." : ""}`,
    ]
    await this.send("doctor", this.channel(c), "caretaker", "triage", c, lines.join("\n"), {
      urgency: t.urgency,
      payload: t as unknown as Record<string, unknown>,
    })
  }

  private async applyDecision(c: CaseState, t: Triage | undefined) {
    if (!t) return
    const actor = this.deps.actors.forElder(c.elderId)
    await actor.setStatus(t.urgency, t.reason)
    if (t.recheckInSec) {
      const at = this.now() + t.recheckInSec * 1000
      c.nextCheckInAt = at
      await actor.scheduleCheckIn(at, `Doctor recheck: ${t.reason}`)
      await this.send("caretaker", this.channel(c), "doctor", "recheck", c,
        `@doctor Recheck call booked for ${clock(at)} (in ${formatDuration(t.recheckInSec)}). Status set to ${t.urgency}.`,
        { urgency: t.urgency })
    }
    const tasks: Promise<unknown>[] = []
    if (t.needsRefill) tasks.push(this.requestRefill(c, t.needsRefill, `Doctor: ${t.reason}`))
    const family = c.record?.patient.family_name ?? "the family"
    tasks.push(this.send("caretaker", { dm: "family" }, "family", "family_brief", c,
      `@family Doctor says ${t.urgency.toUpperCase()}: ${t.reason} Plan: ${t.actions.join("; ")}. Please update ${family}.`,
      { urgency: t.urgency, payload: { kind: "triage" } }))
    await Promise.all(tasks)
  }

  private async pharmacyReply(c: CaseState, med: string) {
    const text = await this.deps.brains.pharmacy(this.view(c), med)
    await this.send("pharmacy", this.channel(c), "caretaker", "refill_confirmed", c, `@caretaker ${text}`)
  }

  private async familyReply(c: CaseState, brief: string, kind: BriefKind) {
    const draft = await this.deps.brains.familyDraft(this.view(c), brief.replace(/^@family\s*/, ""), kind)
    const p = c.record?.patient
    const to = p ? `To ${p.family_name} (${p.family_relation})` : "To the family"
    await this.send("family", this.channel(c), "family-contact", "family_draft", c, `${to}: ${draft}`, { urgency: c.triage?.urgency })
  }

  private view(c: CaseState) {
    return { elderId: c.elderId, caseId: c.id, escalations: c.escalations, record: c.record, triage: c.triage, nextCheckInAt: c.nextCheckInAt }
  }
}

function formatDuration(sec: number) {
  if (sec < 90) return `${sec} s`
  const min = Math.round(sec / 60)
  return `${min} min`
}
