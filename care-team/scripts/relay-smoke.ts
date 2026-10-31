// Proves real Agent Relay traffic before the demo:
//   bun run smoke:relay
// Registers (or reconnects) caretaker/doctor/pharmacy/family, posts one message to #care-smoke,
// waits for Agent Relay to deliver it back, and checks that our routing metadata survives the round trip.

import { loadConfig } from "../src/config.ts"
import { AgentRelayTransport } from "../src/relay/agentRelay.ts"
import type { InboundMessage } from "../src/relay/transport.ts"

const config = loadConfig()
if (!config.relayWorkspaceKey) {
  console.error("RELAY_WORKSPACE_KEY is not set in care-team/.env. Run `npx -y agent-relay@next init --hosted` first.")
  process.exit(1)
}

const transport = new AgentRelayTransport({ workspaceKey: config.relayWorkspaceKey, baseUrl: config.relayBaseUrl, tokenFile: config.relayTokenFile })
const received = new Promise<InboundMessage>((resolve) => transport.onMessage((m) => m.channel === "care-smoke" && resolve(m)))

await transport.start()
await transport.ensureChannel("care-smoke", "care-team smoke test")
const id = await transport.send("caretaker", { channel: "care-smoke" }, "@doctor smoke test from care-team", {
  unc: 1, elderId: "smoke", caseId: "smoke", step: "case", to: "doctor", lane: "doctor",
})
console.log(`sent message ${id}; waiting for delivery...`)

const timeout = new Promise<null>((r) => setTimeout(() => r(null), 15_000))
const got = await Promise.race([received, timeout])
if (!got) {
  console.error("FAIL: no message.created event within 15 s. Check the workspace key and network access to cast.agentrelay.com.")
  process.exit(1)
}
console.log(`OK: delivered by Agent Relay from ${got.from} in #${got.channel}`)
console.log(got.meta ? "OK: routing metadata round-trips" : "NOTE: metadata did not round-trip; care-team falls back to its sent-message record (still works)")
await transport.stop()
process.exit(0)
