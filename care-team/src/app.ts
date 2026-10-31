// HTTP surface of care-team/ (PLAN.md): POST /escalate -> 202, GET /health.
// Extra (additive): POST /demo/storyline, GET /debug/feed, GET /debug/cases.

import { z } from "zod"
import type { CareTeam } from "./careTeam.ts"
import { ESCALATION_KINDS, type Escalation } from "./types.ts"

const EscalationSchema = z.object({
  elderId: z.string().min(1),
  kind: z.enum(ESCALATION_KINDS as unknown as [string, ...string[]]),
  reason: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
})

export interface HealthInfo {
  relay: string
  actor: string
  llm: string
  records: string
}

/** The scripted demo from PLAN.md, as the escalations server/ would send during Grandpa Joe's call. */
export const DEMO_STORYLINE: Array<{ afterMs: number; kind: Escalation["kind"]; reason: string; details?: Record<string, unknown> }> = [
  { afterMs: 0, kind: "symptom", reason: "Feels dizzy since this morning; ran out of his blood-pressure pills two days ago", details: { symptom: "dizziness", severity: "medium" } },
  { afterMs: 2500, kind: "refill", reason: "Out of blood-pressure pills", details: { med: "lisinopril" } },
  { afterMs: 6000, kind: "teach_back", reason: "Said he takes metformin at bedtime; it is with breakfast and dinner", details: { med: "metformin", understood: false } },
  { afterMs: 11000, kind: "summary", reason: "Dizzy but alert and talking clearly; out of lisinopril, refill arranged; metformin timing corrected", details: { mood: "tired but cheerful" } },
]

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors })

export function createApp(team: CareTeam, info: HealthInfo) {
  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })

    if (req.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        service: "care-team",
        ...info,
        agents: ["caretaker", "doctor", "pharmacy", "family"],
        warning: info.relay === "memory" ? "Agent Relay is NOT connected (set RELAY_WORKSPACE_KEY). Messages are in-process only." : undefined,
      })
    }

    if (req.method === "POST" && url.pathname === "/escalate") {
      let body: unknown
      try {
        body = await req.json()
      } catch {
        return json({ error: "body must be JSON" }, 400)
      }
      const parsed = EscalationSchema.safeParse(body)
      if (!parsed.success) return json({ error: "invalid escalation", issues: parsed.error.issues }, 400)
      const { caseId } = await team.escalate(parsed.data as Escalation)
      return json({ accepted: true, caseId }, 202)
    }

    if (req.method === "POST" && url.pathname === "/demo/storyline") {
      const body = (await req.json().catch(() => ({}))) as { elderId?: string; speed?: number }
      const elderId = body.elderId || "grandpa-joe"
      const speed = body.speed && body.speed > 0 ? body.speed : 1
      for (const step of DEMO_STORYLINE) {
        setTimeout(() => {
          team.escalate({ elderId, kind: step.kind, reason: step.reason, details: step.details }).catch((e) => console.error(e))
        }, step.afterMs / speed)
      }
      return json({ accepted: true, elderId, steps: DEMO_STORYLINE.length }, 202)
    }

    if (req.method === "GET" && url.pathname === "/debug/feed") {
      const elderId = url.searchParams.get("elderId")
      return json(elderId ? team.feed.filter((f) => f.elderId === elderId) : team.feed)
    }

    if (req.method === "GET" && url.pathname === "/debug/cases") {
      return json(team.casesFor(url.searchParams.get("elderId") || "grandpa-joe"))
    }

    return json({ error: "not found" }, 404)
  }
}
