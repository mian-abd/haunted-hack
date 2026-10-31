import { expect, test } from "bun:test"
import { heard } from "./CallPanel.tsx"
import { storyline } from "./script.ts"
import { mockFixture } from "./mock.ts"

test("every scripted tool call becomes one fact row, in order, with no transcript text", () => {
  const steps = storyline(mockFixture(0))
  const rows = steps.flatMap((s, i) => ("tool" in s ? [heard(`script-${i}`, ...s.tool)] : []))
  expect(rows.map(r => r?.kind)).toEqual(["med", "med", "symptom", "teach_back", "refill", "summary"])
  expect(rows[0]).toMatchObject({ text: "Amlodipine missed", detail: "Ran out two days ago", tone: "bad" })
  expect(rows[1]).toMatchObject({ text: "Metformin taken", tone: "good" })
  expect(rows[2]).toMatchObject({ text: "Dizzy since this morning", detail: "medium severity", tone: "warn" })
  expect(rows[3]).toMatchObject({ text: "Metformin: mixed up, then corrected", tone: "warn" })
  expect(rows[4]).toMatchObject({ text: "Amlodipine", tone: "neutral" })
  expect(rows[5]?.detail).toBe("Mood: tired but in good spirits")
})

test("unknown tools are skipped; missing args never crash", () => {
  expect(heard("x", "something_else", {})).toBeNull()
  expect(heard("x", "report_symptom", {})).toMatchObject({ text: "", detail: undefined, tone: "neutral" })
  expect(heard("x", "end_call", { summary: "ok" })?.detail).toBeUndefined()
  expect(heard("x", "teach_back_result", { med: "Metformin", understood: true })).toMatchObject({ text: "Metformin: explained it right", tone: "good" })
})
