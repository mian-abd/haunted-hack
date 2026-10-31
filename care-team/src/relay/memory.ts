// In-process stand-in for Agent Relay. Tests and offline development only:
// GET /health reports relay: "memory" so nobody demos it by mistake.

import type { CareAgent, UncMeta } from "../types.ts"
import type { Destination, InboundMessage, RelayTransport } from "./transport.ts"

export interface MemoryOptions {
  /** Deliver each message this many times, like the SDK's fan-in through several registered agents. */
  duplicates?: number
  /** Drop metadata on delivery, to prove routing still works from the sender-side record. */
  stripMetadata?: boolean
}

export class MemoryTransport implements RelayTransport {
  readonly mode = "memory" as const
  readonly sent: Array<{ id: string; from: CareAgent; to: Destination; text: string; meta: UncMeta }> = []
  private handlers: Array<(m: InboundMessage) => void> = []
  private seq = 0
  constructor(private readonly opts: MemoryOptions = {}) {}

  async start() {}
  async ensureChannel() {}
  async stop() {}

  onMessage(handler: (m: InboundMessage) => void) {
    this.handlers.push(handler)
  }

  async send(from: CareAgent, to: Destination, text: string, meta: UncMeta) {
    const id = `mem_${++this.seq}`
    this.sent.push({ id, from, to, text, meta })
    const msg: InboundMessage = {
      id,
      from,
      channel: "channel" in to ? to.channel : undefined,
      text,
      meta: this.opts.stripMetadata ? undefined : structuredClone(meta),
    }
    const copies = Math.max(1, this.opts.duplicates ?? 1)
    for (let i = 0; i < copies; i++) {
      setTimeout(() => this.handlers.forEach((h) => h({ ...msg })), 0)
    }
    return id
  }
}
