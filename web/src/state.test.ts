import { expect, test } from "bun:test"
import { EMPTY, agentThread, countdown, groupLanes, medBadge, reduce, signals, tone, type ActorMessage, type Med, type TimelineEvent } from "./state"

const ev = (id: string, kind: TimelineEvent["kind"], data?: TimelineEvent["data"]): TimelineEvent => ({ id, ts: 0, kind, text: id, data })

test("state replaces with defaults, state_update merges and resets removed fields, call_due rings", () => {
  let s = reduce(EMPTY, { type: "state", state: { status: "watch", statusReason: "dizzy", timeline: [ev("a", "note")] }, version: 3 })
  expect(s.statusReason).toBe("dizzy")
  expect(s.meds).toEqual([]) // missing field filled from defaults

  s = reduce(s, { type: "state_update", changes: { status: "ok", nextCheckInAt: 99 }, removed: ["statusReason", "constructor"], version: 4 })
  expect(s.status).toBe("ok")
  expect(s.nextCheckInAt).toBe(99)
  expect(s.statusReason).toBe("") // removed → default
  expect(Object.hasOwn(s, "constructor")).toBe(false) // unknown removed key ignored
  expect(s.timeline.map(e => e.id)).toEqual(["a"]) // untouched field kept

  s = reduce(s, { type: "call_due" })
  expect(s.callState).toBe("due")
  expect(reduce(s, { type: "pong" } as unknown as ActorMessage)).toBe(s) // unknown messages are ignored
})

test("lanes group agent_msg by data.lane newest first; thread keeps order; chips are the non-agent signals", () => {
  const t = [
    ev("d1", "agent_msg", { lane: "doctor" }),
    ev("s1", "symptom"),
    ev("p1", "agent_msg", { lane: "pharmacy" }),
    ev("n1", "note"),
    ev("d2", "agent_msg", { lane: "doctor" }),
    ev("x1", "agent_msg"), // no lane: thread only
    ev("bad", "agent_msg", { lane: "constructor" as never }), // junk lane must not throw
    ev("m1", "med", { taken: false }),
  ]
  const lanes = groupLanes(t)
  expect(lanes.doctor.map(e => e.id)).toEqual(["d2", "d1"])
  expect(lanes.pharmacy.map(e => e.id)).toEqual(["p1"])
  expect(lanes.family).toEqual([])
  expect(agentThread(t).map(e => e.id)).toEqual(["d1", "p1", "d2", "x1", "bad"])
  expect(signals(t).map(e => e.id)).toEqual(["m1", "s1"])
})

test("tone, med badges and countdown", () => {
  expect(tone(ev("a", "med", { taken: false }))).toBe("bad")
  expect(tone(ev("b", "symptom", { severity: "medium" }))).toBe("warn")
  expect(tone(ev("c", "teach_back", { understood: false }))).toBe("warn")
  expect(tone(ev("d", "status", { urgency: "ok" }))).toBe("good")
  expect(tone(ev("e", "vitals"))).toBe("neutral")

  const now = new Date(2026, 9, 31, 14, 0).getTime()
  const med: Med = { name: "Metformin", dose: "500 mg", times: ["08:00"], purpose: "", lastTakenAt: null, missedCount: 0 }
  expect(medBadge(med, now)).toBe("due")
  expect(medBadge({ ...med, lastTakenAt: now - 3600_000 }, now)).toBe("taken")
  expect(medBadge({ ...med, lastTakenAt: now - 24 * 3600_000 }, now)).toBe("due") // yesterday
  expect(medBadge({ ...med, lastTakenAt: now, missedCount: 1 }, now)).toBe("missed")

  expect(countdown(null, now)).toBe("Not scheduled")
  expect(countdown(now + 15_000, now)).toBe("0:15")
  expect(countdown(now + 14_001, now)).toBe("0:15") // rounds up
  expect(countdown(now + 1, now)).toBe("0:01")
  expect(countdown(now, now)).toBe("Now")
  expect(countdown(now + 2 * 3600_000, now)).toBe("2:00:00")
})
