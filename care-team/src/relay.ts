// Agent Relay transport. Default: the hosted Relaycast REST API (the messaging engine behind Agent Relay).
// RELAY_MODE=local swaps in localRelay(), an in-process bus for offline tests only.
export const AGENTS = ["caretaker", "doctor", "pharmacy", "family"] as const
export type Agent = (typeof AGENTS)[number]
export type RelayMsg = { id: string; ts: string; from: string; text: string; data: Record<string, any>; dm: boolean }
export type Handler = (msg: RelayMsg) => unknown

export interface Relay {
  mode: "agent-relay" | "local"
  info: Record<string, unknown>
  ensureChannel(name: string): Promise<void>
  post(from: Agent, channel: string, text: string, data: Record<string, unknown>): Promise<RelayMsg>
  dm(from: Agent, to: Agent, text: string, data: Record<string, unknown>): Promise<RelayMsg>
  listen(agent: Agent, handler: Handler): void
}

const BASE = (process.env.RELAY_BASE_URL || "https://armadillo.agentrelay.com").replace(/\/+$/, "")

async function call(token: string | null, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  let json: any = {}
  try { json = text ? JSON.parse(text) : {} } catch {}
  if (!res.ok) throw Object.assign(new Error(`Agent Relay ${method} ${path} -> ${res.status} ${json.error?.code ?? text.slice(0, 80)}`), { status: res.status })
  return json.data
}

export async function connectAgentRelay(): Promise<Relay> {
  let key = process.env.RELAY_WORKSPACE_KEY?.trim()
  let workspace = "(from RELAY_WORKSPACE_KEY)"
  if (!key) {
    // Anonymous bootstrap needs no login. shortcut: a fresh 24h workspace per boot; set RELAY_WORKSPACE_KEY to keep one.
    workspace = `unc-care-${crypto.randomUUID().slice(0, 8)}`
    key = (await call(null, "POST", "/workspaces", { name: workspace, expires_in_seconds: 86_400 })).api_key as string
  }
  const tokens = {} as Record<Agent, string>
  for (const name of AGENTS) {
    const register = () => call(key!, "POST", "/agents", { name, type: "agent" })
    const agent = await register().catch(async (e) => {
      if (e.status !== 409) throw e
      await call(key!, "DELETE", `/agents/${name}`) // tokens are shown only once, so after a restart re-create the identity
      return register()
    })
    tokens[name] = agent.token
  }

  const joined = new Set<string>()
  let lastActivity = Date.now()
  const sent = (r: any, from: string, text: string, data: Record<string, any>, dm: boolean): RelayMsg => {
    lastActivity = Date.now()
    return { id: r.id, ts: r.created_at, from, text, data, dm }
  }

  return {
    mode: "agent-relay",
    info: { baseUrl: BASE, workspace },
    async ensureChannel(name) {
      if (joined.has(name)) return
      await call(tokens.caretaker, "POST", "/channels", { name, topic: "Unc care team" }).catch((e) => { if (e.status !== 409) throw e })
      for (const a of AGENTS) await call(tokens[a], "POST", `/channels/${name}/join`)
      joined.add(name)
    },
    async post(from, channel, text, data) {
      return sent(await call(tokens[from], "POST", `/channels/${channel}/messages`, { text, data }), from, text, data, false)
    },
    async dm(from, to, text, data) {
      return sent(await call(tokens[from], "POST", "/dm", { to, text, data }), from, text, data, true)
    },
    // Armadillo serves no WebSockets yet (501 websocket_unavailable), so each agent polls its durable delivery queue.
    listen(agent, handler) {
      void (async () => {
        for (;;) {
          try {
            for (const item of await call(tokens[agent], "GET", "/deliveries?limit=50")) {
              const ack = () => call(tokens[agent], "POST", `/deliveries/${item.id}/ack`, {})
              if (!item.message?.id) { await ack(); continue } // not a message: ack so it cannot wedge the queue
              const m = await call(tokens[agent], "GET", `/messages/${item.message.id}`) // deliveries omit metadata
              await ack()
              lastActivity = Date.now()
              console.log(`[relay] ${agent} <- ${m.id} from ${m.agent_name} (sent ${m.created_at})`)
              try {
                await handler({ id: m.id, ts: m.created_at, from: m.agent_name, text: m.text, data: m.metadata ?? {}, dm: String(m.channel_id).startsWith("dmch_") })
              } catch (e) {
                console.error(`[care-team] ${agent} failed on ${m.id}:`, e)
              }
            }
          } catch (e) {
            console.warn(`[relay] ${agent} poll failed: ${(e as Error).message}`)
            await Bun.sleep(2_000)
          }
          // shortcut: fast polling for 60s after any traffic, slower when idle; switch to WebSockets once armadillo serves them
          await Bun.sleep(Date.now() - lastActivity < 60_000 ? 500 : 2_000)
        }
      })()
    },
  }
}

// LOCAL FALLBACK: messages never leave this process. For offline tests only; this is NOT Agent Relay traffic.
export function localRelay(): Relay {
  const handlers = new Map<string, Handler>()
  const queues = new Map<string, Promise<unknown>>()
  let n = 0
  const deliver = (to: readonly string[], msg: RelayMsg) => {
    for (const a of to) {
      const h = handlers.get(a)
      if (!h) continue
      // one message at a time per agent, like the real per-agent poll loop
      queues.set(a, (queues.get(a) ?? Promise.resolve()).then(() => h(msg)).catch((e) => console.error(`[care-team] ${a} failed:`, e)))
    }
  }
  const make = (from: string, text: string, data: Record<string, any>, dm: boolean): RelayMsg =>
    ({ id: `local-${++n}`, ts: new Date().toISOString(), from, text, data, dm })
  return {
    mode: "local",
    info: { warning: "LOCAL FALLBACK: in-process bus, not Agent Relay" },
    async ensureChannel() {},
    async post(from, _channel, text, data) {
      const msg = make(from, text, data, false)
      deliver(AGENTS.filter((a) => a !== from), msg)
      return msg
    },
    async dm(from, to, text, data) {
      const msg = make(from, text, data, true)
      deliver([to], msg)
      return msg
    },
    listen(agent, handler) { handlers.set(agent, handler) },
  }
}
