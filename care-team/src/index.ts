import { createActors } from "./actor.ts"
import { createApp } from "./app.ts"
import { createBrains } from "./brains.ts"
import { CareTeam } from "./careTeam.ts"
import { loadConfig } from "./config.ts"
import { createRecords } from "./records.ts"
import { AgentRelayTransport } from "./relay/agentRelay.ts"
import { MemoryTransport } from "./relay/memory.ts"

const config = loadConfig()

const transport = config.relayWorkspaceKey
  ? new AgentRelayTransport({ workspaceKey: config.relayWorkspaceKey, baseUrl: config.relayBaseUrl, tokenFile: config.relayTokenFile })
  : new MemoryTransport()
if (transport.mode === "memory") {
  console.warn("[care-team] RELAY_WORKSPACE_KEY is not set: running on the in-process relay. This is NOT Agent Relay; do not demo it.")
}

const actors = await createActors(config)
const brains = createBrains(config)
const records = createRecords(config)
const team = new CareTeam({ transport, actors, brains, records, config })
await team.start()

const server = Bun.serve({
  port: config.port,
  fetch: createApp(team, { relay: transport.mode, actor: actors.mode, llm: brains.mode, records: records.source }),
})

console.log(`[care-team] listening on http://localhost:${server.port}  relay=${transport.mode} actor=${actors.mode} llm=${brains.mode} records=${records.source}`)

const shutdown = async () => {
  await team.stop().catch(() => {})
  server.stop()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
