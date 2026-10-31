// Real Agent Relay transport (hosted). Four identities live in this process:
// caretaker, doctor, pharmacy, family. Each one sends as itself; every agent reacts
// only to messages Agent Relay delivers back through the listener.

import { AgentRelay, type RelayAgentClient } from "@agent-relay/sdk"
import { resolve } from "node:path"
import { CARE_AGENTS, type CareAgent, type UncMeta } from "../types.ts"
import { parseMeta, type Destination, type InboundMessage, type RelayTransport } from "./transport.ts"

type TokenFile = Partial<Record<CareAgent, string>>

export interface AgentRelayTransportOptions {
  workspaceKey: string
  baseUrl?: string | null
  /** Agent tokens are saved here (git-ignored) so a restart reconnects instead of hitting name_conflict. */
  tokenFile: string
}

export class AgentRelayTransport implements RelayTransport {
  readonly mode = "agent-relay" as const
  private relay: AgentRelay
  private agents = new Map<CareAgent, RelayAgentClient>()
  private handlers: Array<(m: InboundMessage) => void> = []
  private unsubscribers: Array<() => void> = []
  private joined = new Set<string>()
  private tokenPath: string

  constructor(private readonly opts: AgentRelayTransportOptions) {
    const options: Record<string, unknown> = { workspaceKey: opts.workspaceKey }
    if (opts.baseUrl) options.baseUrl = opts.baseUrl
    this.relay = new AgentRelay(options as ConstructorParameters<typeof AgentRelay>[0])
    this.tokenPath = resolve(process.cwd(), opts.tokenFile)
  }

  private async readTokens(): Promise<TokenFile> {
    const f = Bun.file(this.tokenPath)
    return (await f.exists()) ? ((await f.json()) as TokenFile) : {}
  }

  private async connect(name: CareAgent, tokens: TokenFile): Promise<RelayAgentClient> {
    const token = tokens[name]
    if (token) {
      try {
        return await this.relay.workspace.reconnect({ apiToken: token })
      } catch (err) {
        console.warn(`[relay] reconnect for ${name} failed (${String(err)}); registering again`)
      }
    }
    try {
      return await this.relay.workspace.register({ name, type: "agent" })
    } catch (err) {
      if (!/conflict|409/i.test(String(err))) throw err
      // The name exists but we lost its token: release it and register again.
      console.warn(`[relay] ${name} already exists without a saved token; releasing and re-registering`)
      await this.relay.workspace.release({ name, reason: "care-team restart", deleteAgent: true })
      return await this.relay.workspace.register({ name, type: "agent" })
    }
  }

  async start() {
    const tokens = await this.readTokens()
    for (const name of CARE_AGENTS) {
      const client = await this.connect(name, tokens)
      this.agents.set(name, client)
      if (client.token) tokens[name] = client.token
    }
    await Bun.write(this.tokenPath, JSON.stringify(tokens, null, 2))

    const forward = (ev: { message?: { messageId?: string; id?: string; text?: string; metadata?: unknown; from?: { name?: string } }; envelope?: { from?: { name?: string }; channel?: { name?: string } } }) => {
      const msg = ev.message
      if (!msg) return
      const inbound: InboundMessage = {
        id: String(msg.messageId ?? msg.id ?? ""),
        from: ev.envelope?.from?.name ?? msg.from?.name ?? "unknown",
        channel: ev.envelope?.channel?.name,
        text: msg.text ?? "",
        meta: parseMeta(msg.metadata),
      }
      if (!inbound.id) return
      for (const h of this.handlers) h(inbound)
    }
    for (const type of ["message.created", "dm.received", "thread.reply"] as const) {
      this.unsubscribers.push(this.relay.addListener(type, forward as never))
    }
    console.log(`[relay] connected to Agent Relay as ${CARE_AGENTS.join(", ")}`)
  }

  async ensureChannel(channel: string, topic?: string) {
    if (this.joined.has(channel)) return
    const caretaker = this.agent("caretaker")
    try {
      await caretaker.channels.create({ name: channel, topic: topic ?? "Unc care team" })
    } catch (err) {
      if (!/exist|conflict|409/i.test(String(err))) console.warn(`[relay] create #${channel}: ${String(err)}`)
    }
    await Promise.all(CARE_AGENTS.map(async (name) => {
      try {
        await this.agent(name).channels.join(channel)
      } catch (err) {
        if (!/already|member|409/i.test(String(err))) console.warn(`[relay] ${name} join #${channel}: ${String(err)}`)
      }
    }))
    this.joined.add(channel)
  }

  async send(from: CareAgent, to: Destination, text: string, meta: UncMeta) {
    const client = this.agent(from)
    const target = "channel" in to ? `#${to.channel}` : `@${to.dm}`
    const sent = await client.sendMessage({ to: target, text, metadata: meta as unknown as Record<string, unknown> })
    return String(sent.messageId ?? sent.id)
  }

  onMessage(handler: (m: InboundMessage) => void) {
    this.handlers.push(handler)
  }

  async stop() {
    this.unsubscribers.forEach((u) => u())
    this.unsubscribers = []
  }

  private agent(name: CareAgent): RelayAgentClient {
    const a = this.agents.get(name)
    if (!a) throw new Error(`Agent Relay identity ${name} is not connected; call start() first`)
    return a
  }
}
