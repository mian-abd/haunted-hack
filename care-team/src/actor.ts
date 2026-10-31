// Bridge to the ElderActor in ../actor (Terse, :7100). Uses the generated client in care-team/generated
// (`terse actor generate`); falls back to an in-memory fake when TERSE_FAKE=1 or the client is missing.
export type Status = "ok" | "watch" | "urgent"
export type ActorEvent = { kind: "agent_msg"; text: string; from?: string; to?: string; data?: Record<string, unknown> }

export interface ActorBridge {
  mode: "terse" | "fake"
  logEvent(elderId: string, e: ActorEvent): Promise<unknown>
  setStatus(elderId: string, status: Status, reason: string): Promise<unknown>
  scheduleCheckIn(elderId: string, atMs: number, reason?: string): Promise<unknown>
}

export function fakeActor() {
  const calls: { method: string; elderId: string; args: any[] }[] = []
  const record = (method: string) => async (elderId: string, ...args: any[]) => {
    calls.push({ method, elderId, args })
    const [a, b] = args
    const line = method === "logEvent" ? `${a.from} -> ${a.to} [${a.data?.lane}] ${a.text}` : method === "scheduleCheckIn" ? `${new Date(a).toISOString()} (${b})` : `${a}: ${b}`
    console.log(`[actor:fake] ${method} ${elderId} ${line}`)
  }
  return { mode: "fake" as const, calls, logEvent: record("logEvent"), setStatus: record("setStatus"), scheduleCheckIn: record("scheduleCheckIn") }
}

export async function createActorBridge(): Promise<ActorBridge> {
  if (process.env.TERSE_FAKE === "1") return fakeActor()
  let actors: any
  try {
    ;({ actors } = await import("../generated/index.js")) // per actor/README "Using ElderActor from another folder"
  } catch {
    console.warn("[actor] no generated Terse client in care-team/generated (run `terse actor generate`); using the in-memory fake")
    return fakeActor()
  }
  const elder = (id: string) => actors.ElderActor.get(id)
  return {
    mode: "terse",
    logEvent: (id, e) => elder(id).logEvent(e),
    setStatus: (id, status, reason) => elder(id).setStatus(status, reason),
    scheduleCheckIn: (id, atMs, reason) => elder(id).scheduleCheckIn(atMs, reason),
  }
}
