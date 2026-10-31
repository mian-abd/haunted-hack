import { expect, test } from "bun:test"
import { heard, recap } from "./CallPanel.tsx"
import { mockFixture } from "./mock.ts"
import type { TimelineEvent } from "./state.ts"

const ev = (id: string, kind: TimelineEvent["kind"], text: string, data?: TimelineEvent["data"]): TimelineEvent => ({ id, ts: 0, kind, text, data })

test("What Troska heard: plain sentences from the latest call only, plus its recap", () => {
  const s = mockFixture(0)
  s.timeline = [
    ev("old", "med", "Metformin: taken", { med: "Metformin", taken: true }), // an earlier call: not shown
    ev("start", "call_started", "Check-in call started"),
    ev("m1", "med", "Amlodipine: not taken (ran out)", { med: "Amlodipine", taken: false, note: "ran out two days ago" }),
    ev("s1", "symptom", "Dizzy since this morning", { severity: "medium" }),
    ev("t1", "teach_back", "Metformin: not understood", { med: "Metformin", understood: false }),
    ev("a1", "agent_msg", "New case for the doctor", { lane: "doctor" }), // the care team's messages are not "heard"
    ev("end", "call_ended", "Dizzy, out of amlodipine."),
  ]
  expect(heard(s).map(h => [h.text, h.tone])).toEqual([
    ["Joe has not taken Amlodipine, for blood pressure.", "bad"],
    ["Joe reported a moderate symptom: dizzy since this morning.", "warn"],
    ["Joe mixed up how to take Metformin, so Troska went over it again.", "warn"],
    ["Troska's summary: Dizzy, out of amlodipine.", "neutral"],
  ])
  expect(heard(s)[0].detail).toBe("ran out two days ago")

  // The phone's post-call recap wins over the agent's own summary.
  s.timeline.push(ev("note", "note", "Call recap: Joe felt dizzy; refill is ready at 5 pm."))
  expect(recap(s.timeline)?.text).toBe("Joe felt dizzy; refill is ready at 5 pm.")
})

test("no call yet: nothing heard, no recap; junk data never crashes", () => {
  const s = mockFixture(0)
  s.timeline = []
  expect(heard(s)).toEqual([])
  expect(recap(s.timeline)).toBeUndefined()
  s.timeline = [ev("x", "symptom", "Tired"), ev("y", "med", "?", {})]
  expect(heard(s).map(h => h.text)).toEqual(["Joe reported a symptom: tired.", "Joe has not taken a medicine."])
})
