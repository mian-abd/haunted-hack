import { describe, expect, test } from "bun:test"
import { RecordingActors } from "../src/actor.ts"
import { createApp, DEMO_STORYLINE } from "../src/app.ts"
import { createOpenAIBrains, createScriptedBrains } from "../src/brains.ts"
import { CareTeam } from "../src/careTeam.ts"
import { BUILTIN_SEED, type Records } from "../src/records.ts"
import { MemoryTransport, type MemoryOptions } from "../src/relay/memory.ts"
import type { HospitalRecord, LogEventInput } from "../src/types.ts"

const RECHECK = { recheckSeconds: 90, urgentRecheckSeconds: 60 }

const records: Records = {
  source: "builtin",
  async get(elderId) {
    const patient = BUILTIN_SEED.patients.find((p) => p.id === elderId)
    if (!patient) return null
    return {
      patient,
      prescriptions: BUILTIN_SEED.prescriptions.filter((p) => p.patient_id === elderId),
      notes: BUILTIN_SEED.clinical_notes.filter((n) => n.patient_id === elderId),
      source: "builtin",
    } satisfies HospitalRecord
  },
}

async function setup(opts: MemoryOptions = {}, brains = createScriptedBrains(RECHECK)) {
  const transport = new MemoryTransport(opts)
  const actors = new RecordingActors(true)
  const team = new CareTeam({ transport, actors, brains, records, config: { stepDelayMs: 0, caseWindowMs: 180_000 } })
  await team.start()
  const events = () => actors.calls.filter((c) => c.method === "logEvent").map((c) => c.args[0] as LogEventInput)
  return { team, transport, actors, events }
}

describe("care team on the relay", () => {
  test("symptom: caretaker -> doctor -> status + recheck -> pharmacy + family draft", async () => {
    const { team, transport, actors, events } = await setup()
    const before = Date.now()
    await team.escalate({ elderId: "grandpa-joe", kind: "symptom", reason: "Dizzy, ran out of his blood-pressure pills", details: { severity: "medium" } })
    await team.whenIdle()

    const steps = transport.sent.map((s) => `${s.from}->${s.meta.to}:${s.meta.step}`)
    expect(steps).toEqual(expect.arrayContaining([
      "caretaker->doctor:case",
      "doctor->caretaker:triage",
      "caretaker->doctor:recheck",
      "caretaker->pharmacy:refill_request",
      "caretaker->family:family_brief",
      "pharmacy->caretaker:refill_confirmed",
      "family->family-contact:family_draft",
    ]))
    expect(steps[0]).toBe("caretaker->doctor:case")

    const triage = transport.sent.find((s) => s.meta.step === "triage")!
    expect(triage.meta.urgency).toBe("watch")
    expect(triage.text).toContain("lisinopril")

    const status = actors.calls.find((c) => c.method === "setStatus")!
    expect(status.args[0]).toBe("watch")
    const recheck = actors.calls.find((c) => c.method === "scheduleCheckIn")!
    expect(recheck.args[0] as number).toBeGreaterThanOrEqual(before + 90_000)

    expect(transport.sent.find((s) => s.meta.step === "refill_confirmed")!.text).toContain("5 pm")
    expect(transport.sent.find((s) => s.meta.step === "family_draft")!.text).toContain("Linda")

    // Every relay message mirrored exactly once, with the right lane.
    const mirrored = events()
    expect(mirrored).toHaveLength(transport.sent.length)
    expect(mirrored.every((e) => e.kind === "agent_msg")).toBe(true)
    const lanes = new Set(mirrored.map((e) => e.data?.lane))
    expect(lanes).toEqual(new Set(["doctor", "pharmacy", "family"]))
    expect(mirrored.find((e) => e.to === "family-contact")?.data?.lane).toBe("family")
  })

  test("duplicate deliveries (SDK fan-in) are acted on and mirrored once", async () => {
    const { team, transport, events } = await setup({ duplicates: 3 })
    await team.escalate({ elderId: "grandpa-joe", kind: "symptom", reason: "Dizzy", details: { severity: "medium" } })
    await team.whenIdle()
    expect(transport.sent.filter((s) => s.meta.step === "triage")).toHaveLength(1)
    expect(events()).toHaveLength(transport.sent.length)
  })

  test("routing survives if Agent Relay drops message metadata", async () => {
    const { team, transport } = await setup({ stripMetadata: true })
    await team.escalate({ elderId: "grandpa-joe", kind: "symptom", reason: "Dizzy, out of lisinopril", details: { severity: "medium" } })
    await team.whenIdle()
    expect(transport.sent.some((s) => s.meta.step === "family_draft")).toBe(true)
    expect(transport.sent.some((s) => s.meta.step === "refill_confirmed")).toBe(true)
  })

  test("danger vitals go urgent with a 60 s recheck", async () => {
    const { team, actors, transport } = await setup()
    await team.escalate({ elderId: "grandpa-joe", kind: "vitals", reason: "Heart rate spike", details: { heartRate: 142 } })
    await team.whenIdle()
    expect(actors.calls.find((c) => c.method === "setStatus")!.args[0]).toBe("urgent")
    expect(transport.sent.find((s) => s.meta.step === "triage")!.text).toContain("911")
  })

  test("full demo storyline in one case: refill requested once, teach-back + summary reach the family lane", async () => {
    const { team, transport } = await setup()
    for (const s of DEMO_STORYLINE) {
      await team.escalate({ elderId: "grandpa-joe", kind: s.kind, reason: s.reason, details: s.details })
      await team.whenIdle()
    }
    expect(new Set(transport.sent.map((s) => s.meta.caseId)).size).toBe(1)
    expect(transport.sent.filter((s) => s.meta.step === "refill_request")).toHaveLength(1)
    const drafts = transport.sent.filter((s) => s.meta.step === "family_draft").map((s) => s.text)
    expect(drafts.length).toBeGreaterThanOrEqual(3)
    expect(new Set(drafts).size).toBe(drafts.length)
    expect(drafts.some((d) => d.includes("metformin") && d.includes("breakfast"))).toBe(true)
  })
})

describe("OpenAI brains", () => {
  const view = async () => ({
    elderId: "grandpa-joe",
    caseId: "c1",
    record: await records.get("grandpa-joe"),
    escalations: [{ elderId: "grandpa-joe", kind: "symptom" as const, reason: "chest pain and dizzy", details: { severity: "medium" } }],
  })

  test("never downgrades a rule-based danger sign", async () => {
    const fakeFetch = (async () => Response.json({
      choices: [{ message: { content: JSON.stringify({ urgency: "ok", reason: "fine", actions: ["rest"], needsRefill: null, familyHeadline: "All good." }) } }],
    })) as unknown as typeof fetch
    const brains = createOpenAIBrains({ openaiApiKey: "test", openaiModel: "m", openaiTimeoutMs: 1000, ...RECHECK }, fakeFetch)
    const t = await brains.triage(await view())
    expect(t.urgency).toBe("urgent")
    expect(t.recheckInSec).toBe(60)
  })

  test("falls back to scripted text when the API fails", async () => {
    const failing = (async () => new Response("down", { status: 500 })) as unknown as typeof fetch
    const brains = createOpenAIBrains({ openaiApiKey: "test", openaiModel: "m", openaiTimeoutMs: 1000, ...RECHECK }, failing)
    const text = await brains.pharmacy(await view(), "lisinopril")
    expect(text).toContain("Ready for pickup at 5 pm")
  })
})

describe("HTTP", () => {
  test("POST /escalate validates and returns 202; GET /health reports modes", async () => {
    const { team } = await setup()
    const app = createApp(team, { relay: "memory", actor: "console", llm: "scripted", records: "builtin" })
    const bad = await app(new Request("http://x/escalate", { method: "POST", body: JSON.stringify({ elderId: "grandpa-joe", kind: "nope" }) }))
    expect(bad.status).toBe(400)
    const ok = await app(new Request("http://x/escalate", { method: "POST", body: JSON.stringify({ elderId: "grandpa-joe", kind: "refill", reason: "out of pills", details: { med: "lisinopril" } }) }))
    expect(ok.status).toBe(202)
    expect(((await ok.json()) as { caseId: string }).caseId).toStartWith("case_grandpa-joe_")
    const health = (await (await app(new Request("http://x/health"))).json()) as { relay: string; warning?: string }
    expect(health.relay).toBe("memory")
    expect(health.warning).toBeTruthy()
    await team.whenIdle()
  })
})
