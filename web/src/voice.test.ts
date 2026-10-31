import { expect, test } from "bun:test"
import { mockFixture } from "./mock"
import { storyline } from "./script"
import { applyVoiceEvent, functionCalls, sessionUpdate, toolLabel, type Line } from "./voice"

const CONTRACT_TOOLS = ["confirm_medication", "end_call", "report_symptom", "request_refill", "teach_back_result"]
const joe = mockFixture(0) // same profile and meds as supabase/seed.json

test("session.update: GA realtime shape, the 5 contract tools, transcription, instructions from live state", () => {
  const { type, session } = sessionUpdate({ ...joe, statusReason: "Dizzy earlier" })
  expect(type).toBe("session.update")
  expect(session.type).toBe("realtime")
  expect(session.tools.map(t => t.name).sort()).toEqual(CONTRACT_TOOLS)
  expect(session.tools.every(t => t.type === "function" && t.parameters.type === "object")).toBe(true)
  expect(session.audio.input.transcription.model).toBeTruthy()
  for (const s of ["Joe", "Amlodipine", "Metformin", "Atorvastatin", "Dizzy earlier", "Teach-back", "911", "end_call", "report_symptom"])
    expect(session.instructions).toContain(s)
  expect(session.instructions).toContain("how they take Metformin") // teach-back picks the twice-a-day med
  expect(session.tools.find(t => t.name === "confirm_medication")!.parameters.properties.med).toMatchObject({ description: expect.stringContaining("Exact medicine name") })
})

test("instructions carry the local time so the agent skips doses that are due later", async () => {
  const { buildInstructions } = await import("./voice")
  const text = buildInstructions(joe, new Date(2026, 9, 31, 14, 5))
  expect(text).toContain("Current local time: 14:05.")
  expect(text).toContain("Never call confirm_medication for a dose that is due later today.")
  expect(text).toContain("- Amlodipine: 5 mg at 08:00")
})

test("transcript: elder placeholder keeps turn order, deltas stream, empty transcripts vanish", () => {
  const events = [
    { type: "response.output_audio_transcript.delta", item_id: "a1", delta: "Hi Joe, " },
    { type: "response.output_audio_transcript.done", item_id: "a1", transcript: "Hi Joe, how are you?" },
    { type: "input_audio_buffer.speech_started", item_id: "u1" },
    { type: "response.output_audio_transcript.delta", item_id: "a2", delta: "I'm sorry" }, // reply starts before ASR finishes
    { type: "conversation.item.input_audio_transcription.delta", item_id: "u1", delta: "A bit " },
    { type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: " A bit dizzy. " },
    { type: "input_audio_buffer.speech_started", item_id: "u2" }, // a cough
    { type: "conversation.item.input_audio_transcription.completed", item_id: "u2", transcript: "" },
    { type: "rate_limits.updated" },
  ]
  const lines = events.reduce<Line[]>(applyVoiceEvent, [])
  expect(lines.map(l => [l.who, l.text, l.final])).toEqual([
    ["agent", "Hi Joe, how are you?", true],
    ["elder", "A bit dizzy.", true],
    ["agent", "I'm sorry", false],
  ])
  const same: Line[] = []
  expect(applyVoiceEvent(same, { type: "session.updated" })).toBe(same) // no re-render for ignored events
})

test("function calls come complete from response.done; cut-off arguments are skipped", () => {
  const done = {
    type: "response.done",
    response: {
      id: "resp_1",
      output: [
        { type: "message", id: "m1" },
        { type: "function_call", call_id: "c1", name: "confirm_medication", arguments: '{"med":"Amlodipine","taken":false}' },
        { type: "function_call", call_id: "c2", name: "report_symptom", arguments: '{"symptom":"dizz' },
      ],
    },
  }
  expect(functionCalls(done)).toEqual([{ call_id: "c1", name: "confirm_medication", args: { med: "Amlodipine", taken: false } }])
  expect(functionCalls({ type: "response.function_call_arguments.done" })).toEqual([])
  const lines = applyVoiceEvent([], done)
  expect(lines).toEqual([{ id: "c1", who: "tool", text: "confirm_medication · Amlodipine · not taken", final: true }])
  expect(toolLabel("teach_back_result", { med: "Metformin", understood: true })).toBe("teach_back_result · Metformin · understood")
})

test("scripted demo follows the storyline with contract tools only, using the live med names", () => {
  const steps = storyline(joe)
  const tools = steps.flatMap(s => ("tool" in s ? [s.tool] : []))
  expect(tools.every(([name]) => CONTRACT_TOOLS.includes(name))).toBe(true)
  expect(new Set(tools.map(([name]) => name))).toEqual(new Set(CONTRACT_TOOLS)) // every tool gets exercised
  expect(tools.at(-1)?.[0]).toBe("end_call")
  expect(tools).toContainEqual(["request_refill", { med: "Amlodipine" }])
  expect(tools).toContainEqual(["confirm_medication", { med: "Amlodipine", taken: false, note: "Ran out two days ago" }])
  const tb = tools.find(([name]) => name === "teach_back_result")
  expect(tb?.[1]).toMatchObject({ med: "Metformin", understood: false })
  expect(steps.find(s => "tool" in s && s.tool[0] === "report_symptom")).toMatchObject({ tool: ["report_symptom", { severity: "medium" }] })
})
