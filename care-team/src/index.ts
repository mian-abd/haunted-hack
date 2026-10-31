// care-team HTTP service (:8788): POST /escalate (202, worked asynchronously over Agent Relay) and GET /health.
import { connectAgentRelay, localRelay } from "./relay"
import { createActorBridge } from "./actor"
import { startCareTeam, invalid } from "./flow"
import { brainMode, MODEL, stats } from "./brain"

const relay = process.env.RELAY_MODE === "local" ? localRelay() : await connectAgentRelay().catch((e) => {
  console.error(`[care-team] cannot reach Agent Relay (${e.message}). Offline? RELAY_MODE=local starts the LOCAL FALLBACK bus.`)
  process.exit(1)
})
if (relay.mode === "local") console.warn("[care-team] RELAY_MODE=local: LOCAL FALLBACK bus, messages do NOT go through Agent Relay")
const actor = await createActorBridge()
const team = startCareTeam(relay, actor)

const server = Bun.serve({
  port: Number(process.env.PORT || 8788),
  async fetch(req) {
    const { pathname } = new URL(req.url)
    if (req.method === "GET" && pathname === "/health")
      return Response.json({ ok: true, relay: relay.mode, ...relay.info, actor: actor.mode, brain: brainMode(), model: MODEL, fallbacks: stats.fallbacks })
    if (req.method === "POST" && pathname === "/escalate") {
      const body = await req.json().catch(() => null)
      const error = invalid(body)
      if (error) return Response.json({ error }, { status: 400 })
      return Response.json({ accepted: true, caseId: team.escalate(body) }, { status: 202 })
    }
    return Response.json({ error: "not found" }, { status: 404 })
  },
})
console.log(`[care-team] :${server.port} relay=${relay.mode} ${JSON.stringify(relay.info)} actor=${actor.mode} brain=${brainMode()} model=${MODEL}`)
