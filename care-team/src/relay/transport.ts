import type { CareAgent, UncMeta } from "../types.ts"

/** A message as seen by the care team when Agent Relay delivers it. */
export interface InboundMessage {
  id: string
  from: string
  channel?: string
  text: string
  meta?: UncMeta
}

export type Destination = { channel: string } | { dm: CareAgent }

export interface RelayTransport {
  /** "agent-relay" is real hosted Agent Relay traffic. "memory" is for tests and offline dev only. */
  readonly mode: "agent-relay" | "memory"
  start(): Promise<void>
  ensureChannel(channel: string, topic?: string): Promise<void>
  /** Sends as `from`. Returns the Agent Relay message id. */
  send(from: CareAgent, to: Destination, text: string, meta: UncMeta): Promise<string>
  onMessage(handler: (m: InboundMessage) => void): void
  stop(): Promise<void>
}

export function parseMeta(raw: unknown): UncMeta | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const m = raw as Partial<UncMeta>
  return m.unc === 1 && typeof m.caseId === "string" && typeof m.step === "string" ? (m as UncMeta) : undefined
}
