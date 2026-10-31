// "Run scripted demo": the no-LLM safety net. Plays the PLAN.md storyline with scripted lines and real tool calls
// to POST /api/tool, so the actor, the care team and the Care Feed react exactly as they would to a live call.
import type { Dispatch, SetStateAction } from "react"
import { post } from "./api"
import type { ElderState } from "./state"
import { toolLabel, type Line } from "./voice"

export type Step = { say: ["agent" | "elder", string] } | { tool: [string, Record<string, unknown>] }

export function storyline(s: ElderState): Step[] {
  const first = s.profile?.name.split(" ")[0] ?? "Joe"
  const family = s.profile?.family.name ?? "your family"
  const bp = s.meds.find(m => /blood pressure/i.test(m.purpose))?.name ?? "Amlodipine"
  const tb = s.meds.find(m => /metformin/i.test(m.name))?.name ?? "Metformin"
  // Meds before the symptom, so the doctor's case already carries the missed pill; the refill ask comes at the wrap-up,
  // after the doctor has had time to order it (one case per call then refills each med once).
  return [
    { say: ["agent", `Hi ${first}, it's Unc with your afternoon check-in. Let's start with your medicines. Did you take your ${bp} this morning?`] },
    { say: ["elder", "No... I ran out of my blood pressure pills two days ago."] },
    { tool: ["confirm_medication", { med: bp, taken: false, note: "Ran out two days ago" }] },
    { say: ["agent", `Thank you for telling me. And did you take your ${tb} with breakfast?`] },
    { say: ["elder", "Yes, I took that one."] },
    { tool: ["confirm_medication", { med: tb, taken: true }] },
    { say: ["agent", "Good. How are you feeling today?"] },
    { say: ["elder", "Oh, not so great. I've been a little dizzy since this morning."] },
    { tool: ["report_symptom", { symptom: "Dizzy since this morning", severity: "medium" }] },
    { say: ["agent", `I'm sorry to hear that. I'll let your doctor know. In your own words, when do you take your ${tb}?`] },
    { say: ["elder", "One in the morning... and one at bedtime?"] },
    { say: ["agent", "Close. The second one goes with dinner, around 7, not at bedtime. Taking it with food is easier on your stomach. Can you say that back to me?"] },
    { say: ["elder", "With breakfast, and with dinner. Got it."] },
    { tool: ["teach_back_result", { med: tb, understood: false, note: "Said bedtime for the evening dose; corrected to with dinner" }] },
    { say: ["agent", `Perfect. Since you're out of ${bp}, shall I ask the pharmacy for a refill?`] },
    { say: ["elder", "Yes, please."] },
    { tool: ["request_refill", { med: bp }] },
    { say: ["agent", `Done. So: you're dizzy, your ${bp} refill is on its way, and ${tb} goes with breakfast and dinner. I'll let your doctor and ${family} know. Please sit down and drink some water. Take care, ${first}.`] },
    { tool: ["end_call", { summary: `Dizzy since this morning; out of ${bp} for two days, refill requested. ${tb} evening dose corrected to with dinner.`, mood: "tired but in good spirits" }] },
  ]
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Runs the script; close() stops it early. onEnd fires once, agentEnded = true when end_call already ran. */
export function runScript(s: ElderState, setLines: Dispatch<SetStateAction<Line[]>>, onEnd: (agentEnded: boolean) => void) {
  let done = false
  let agentEnded = false
  const finish = () => {
    if (done) return
    done = true
    onEnd(agentEnded)
  }
  const patch = (id: string, f: (l: Line) => Line) => setLines(ls => ls.map(l => (l.id === id ? f(l) : l)))

  void (async () => {
    await post("/api/call/start", {}).catch(() => {})
    for (const [i, step] of storyline(s).entries()) {
      if (done) return
      const id = `script-${i}`
      if ("tool" in step) {
        const [name, args] = step.tool
        setLines(ls => [...ls, { id, who: "tool", text: toolLabel(name, args), final: true }])
        await post("/api/tool", { name, args }).catch(() => patch(id, l => ({ ...l, text: `${l.text} · not delivered (server down?)` })))
        if (name === "end_call") agentEnded = true
        await sleep(400)
        continue
      }
      const [who, text] = step.say
      const words = text.split(" ")
      setLines(ls => [...ls, { id, who, text: "", final: false }])
      for (let n = 1; n <= words.length; n++) {
        await sleep(who === "agent" ? 120 : 170) // typed out word by word so it reads like a live transcript
        if (done) return
        patch(id, l => ({ ...l, text: words.slice(0, n).join(" ") }))
      }
      patch(id, l => ({ ...l, final: true }))
      await sleep(700)
    }
    finish()
  })()

  return { close: finish }
}
