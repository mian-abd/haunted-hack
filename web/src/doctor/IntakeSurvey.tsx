import { useEffect, useRef, useState } from "react"
import { post } from "../api"
import "./IntakeSurvey.css"

type Med = { name: string; dose: string; times: string; purpose: string }
type Contact = { name: string; relation: string; reach: string }
type Answers = {
  name: string; dob: string; language: string; senses: string; callTime: string
  conditions: string[]; otherCondition: string; history: string; allergies: string; mobility: string; memory: string
  meds: Med[]; pharmacy: string; organizer: string
  doctor: string; specialists: string; contacts: Contact[]; emergency: string
  alwaysTell: string; avoid: string; consent: boolean
}

const EMPTY_MED: Med = { name: "", dose: "", times: "", purpose: "" }
const EMPTY_CONTACT: Contact = { name: "", relation: "", reach: "" }
const EMPTY: Answers = {
  name: "", dob: "", language: "", senses: "", callTime: "",
  conditions: [], otherCondition: "", history: "", allergies: "", mobility: "", memory: "",
  meds: [EMPTY_MED], pharmacy: "", organizer: "",
  doctor: "", specialists: "", contacts: [EMPTY_CONTACT], emergency: "",
  alwaysTell: "", avoid: "", consent: false,
}

const STEPS = ["About your parent", "Health", "Medicines and pharmacy", "Care team and contacts", "Preferences and consent"]
const CONDITIONS = ["High blood pressure", "Diabetes", "Heart disease", "Heart failure", "Atrial fibrillation", "COPD or asthma",
  "Arthritis", "Osteoporosis", "Kidney disease", "Past stroke", "Depression or anxiety", "Parkinson's"]
const CALL_TIMES = ["Morning (8 to 11 am)", "Midday (11 am to 2 pm)", "Afternoon (2 to 5 pm)", "Evening (5 to 8 pm)"]
const MOBILITY = ["Walks alone", "Walks with a cane", "Uses a walker", "Uses a wheelchair"]
const MEMORY = ["No concerns", "Some concerns", "Diagnosed memory loss or dementia"]
const MAX_NOTE = 4000

const clip = (s: string, n = 500) => { const t = s.trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t }

/** Plain-text note for the patient record: headings, answered fields only, capped at 4000 chars. */
export function buildNote(a: Answers, author: string): string {
  const out: string[] = ["TROSKA INTAKE SURVEY", `Filled in by: ${author}`, `Date: ${new Date().toISOString().slice(0, 10)}`]
  const section = (title: string, rows: [string, string][], extra: string[] = []) => {
    const lines = rows.filter(([, v]) => v.trim()).map(([k, v]) => `${k}: ${clip(v)}`).concat(extra)
    out.push("", title.toUpperCase(), ...(lines.length ? lines : ["Nothing filled in."]))
  }
  const conditions = [...a.conditions, a.otherCondition.trim() && `Other: ${a.otherCondition}`].filter(Boolean).join(", ")
  section(STEPS[0], [["Preferred name", a.name], ["Date of birth", a.dob], ["Language", a.language],
    ["Hearing or vision needs", a.senses], ["Best time for the daily call", a.callTime]])
  section(STEPS[1], [["Conditions", conditions], ["Past surgeries or hospital stays", a.history],
    ["Allergies and reactions", a.allergies], ["Mobility", a.mobility], ["Memory", a.memory]])
  section(STEPS[2], [["Pharmacy", a.pharmacy], ["Uses a pill organizer", a.organizer]],
    a.meds.filter(m => m.name.trim()).map(m =>
      "- " + [m.name, m.dose, m.times && `taken ${m.times}`, m.purpose && `for ${m.purpose}`].filter(s => s.trim()).map(s => clip(s, 120)).join(", ")))
  section(STEPS[3], [["Primary doctor", a.doctor], ["Specialists", a.specialists], ["Call first in an emergency", a.emergency]],
    a.contacts.filter(c => c.name.trim()).map(c =>
      `- ${clip(c.name, 80)}${c.relation.trim() ? ` (${clip(c.relation, 40)})` : ""}${c.reach.trim() ? `: ${clip(c.reach, 120)}` : ""}`))
  section(STEPS[4], [["Always tell the family", a.alwaysTell], ["Topics to avoid", a.avoid],
    ["Agrees Troska can share call summaries with the people listed", a.consent ? "Yes" : "No"]])
  const note = out.join("\n")
  return note.length > MAX_NOTE ? note.slice(0, MAX_NOTE - 12) + "\n[trimmed]" : note
}

export function IntakeSurvey({ elderId, author, onSaved }: { elderId: string; author: string; onSaved?: () => void }) {
  const key = `troska-intake-${elderId}`
  const [draft, setDraft] = useState<{ step: number; a: Answers }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? "null")
      if (saved?.a) return { step: Math.min(Math.max(Number(saved.step) || 0, 0), STEPS.length - 1), a: { ...EMPTY, ...saved.a } }
    } catch { /* storage blocked or bad JSON: start fresh */ }
    return { step: 0, a: EMPTY }
  })
  const { step, a } = draft
  const [error, setError] = useState<{ field: string; text: string } | null>(null)
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle")
  const headingRef = useRef<HTMLHeadingElement>(null)
  const firstRender = useRef(true)

  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(draft)) } catch { /* storage blocked: the form still works */ }
  }, [key, draft])

  // Move focus to the new step's heading so keyboard and screen reader users land at the top; skip on page load.
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return }
    headingRef.current?.focus()
  }, [step, status])

  const set = <K extends keyof Answers>(k: K, v: Answers[K]) => setDraft(d => ({ ...d, a: { ...d.a, [k]: v } }))
  const setRow = <K extends "meds" | "contacts">(k: K, i: number, patch: Partial<Answers[K][number]>) =>
    set(k, a[k].map((row, j) => (j === i ? { ...row, ...patch } : row)) as Answers[K])
  const goTo = (s: number) => { setError(null); setDraft(d => ({ ...d, step: s })) }

  const fail = (field: string, text: string) => {
    setError({ field, text })
    document.getElementById(field)?.focus()
  }

  const validate = (): boolean => {
    if (step === 0 && !a.name.trim()) { fail("intake-name", "Please add the name your parent likes to be called. Troska uses it on every call."); return false }
    if (step === 4 && !a.consent) { fail("intake-consent", "Please tick the consent box so Troska can share call summaries."); return false }
    return true
  }

  const submit = async () => {
    setStatus("saving")
    setError(null)
    try {
      const res = await post("/api/records", { elderId, author: author.trim() || "Intake survey", note: buildNote(a, author.trim() || "Intake survey") })
      if (res?.ok === false) throw new Error(res.error ?? "not saved")
      try { localStorage.removeItem(key) } catch { /* nothing to clear */ }
      setStatus("saved")
      onSaved?.()
    } catch {
      setStatus("idle")
      setError({ field: "intake-submit", text: "We could not save this to the record. Your answers are still here. Please try again in a moment." })
    }
  }

  const startOver = () => {
    if (!window.confirm("Clear every answer and start over?")) return
    try { localStorage.removeItem(key) } catch { /* nothing to clear */ }
    setDraft({ step: 0, a: EMPTY })
    setError(null)
    setStatus("idle")
  }

  const errFor = (field: string) => (error?.field === field
    ? { "aria-invalid": true, "aria-describedby": "intake-error" } as const : {})

  if (status === "saved") {
    return (
      <section className="intake" aria-labelledby="intake-heading">
        <h2 id="intake-heading" ref={headingRef} tabIndex={-1} className="intake-title">Saved to the record. Troska will use this on every call.</h2>
        <p className="intake-help">You can fill it in again any time things change.</p>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => { setDraft({ step: 0, a: EMPTY }); setStatus("idle") }}>Start a new survey</button>
      </section>
    )
  }

  const text = (id: keyof Answers, label: string, opts: { hint?: string; type?: string; required?: boolean } = {}) => (
    <div className="intake-field">
      <label htmlFor={`intake-${id}`}>{label}{opts.required && <span className="intake-req"> (needed)</span>}</label>
      {opts.hint && <p className="intake-help" id={`intake-${id}-hint`}>{opts.hint}</p>}
      <input id={`intake-${id}`} type={opts.type ?? "text"} value={a[id] as string} autoComplete="off"
        aria-describedby={opts.hint ? `intake-${id}-hint` : undefined} required={opts.required}
        onChange={e => set(id, e.target.value as never)} {...errFor(`intake-${id}`)} />
    </div>
  )
  const area = (id: keyof Answers, label: string, hint?: string) => (
    <div className="intake-field">
      <label htmlFor={`intake-${id}`}>{label}</label>
      {hint && <p className="intake-help" id={`intake-${id}-hint`}>{hint}</p>}
      <textarea id={`intake-${id}`} rows={3} value={a[id] as string} aria-describedby={hint ? `intake-${id}-hint` : undefined}
        onChange={e => set(id, e.target.value as never)} />
    </div>
  )
  const radios = (id: "mobility" | "memory" | "organizer", legend: string, options: string[]) => (
    <fieldset className="intake-field intake-choices">
      <legend>{legend}</legend>
      {options.map(o => (
        <label key={o} className="intake-choice">
          <input type="radio" name={`intake-${id}`} value={o} checked={a[id] === o} onChange={() => set(id, o)} /> {o}
        </label>
      ))}
    </fieldset>
  )

  return (
    <section className="intake" aria-labelledby="intake-heading">
      <div className="intake-progress">
        <p className="intake-step">Step {step + 1} of {STEPS.length}</p>
        <div className="intake-bar" aria-hidden="true"><span style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} /></div>
      </div>
      <h2 id="intake-heading" ref={headingRef} tabIndex={-1} className="intake-title">{STEPS[step]}</h2>

      <form noValidate onSubmit={e => { e.preventDefault(); if (status === "saving" || !validate()) return; step < STEPS.length - 1 ? goTo(step + 1) : submit() }}>
        {step === 0 && <>
          {text("name", "Preferred name", { required: true, hint: "What Troska should call them, for example \"Joe\" or \"Grandpa\"." })}
          {text("dob", "Date of birth", { type: "date" })}
          {text("language", "Language for calls", { hint: "For example English or Vietnamese." })}
          {area("senses", "Hearing or vision needs", "For example: hard of hearing on the left, speak slowly, uses a large-print pill chart.")}
          <div className="intake-field">
            <label htmlFor="intake-callTime">Best time for Troska's daily call</label>
            <select id="intake-callTime" value={a.callTime} onChange={e => set("callTime", e.target.value)}>
              <option value="">Choose a time</option>
              {CALL_TIMES.map(t => <option key={t}>{t}</option>)}
            </select>
          </div>
        </>}

        {step === 1 && <>
          <fieldset className="intake-field intake-choices">
            <legend>Health conditions</legend>
            <p className="intake-help">Tick any that apply.</p>
            <div className="intake-grid">
              {CONDITIONS.map(c => (
                <label key={c} className="intake-choice">
                  <input type="checkbox" checked={a.conditions.includes(c)}
                    onChange={e => set("conditions", e.target.checked ? [...a.conditions, c] : a.conditions.filter(x => x !== c))} /> {c}
                </label>
              ))}
            </div>
          </fieldset>
          {text("otherCondition", "Other conditions")}
          {area("history", "Past surgeries or hospital stays", "What happened and roughly when, for example: hip replacement, 2021.")}
          {area("allergies", "Allergies and reactions", "One per line: what they are allergic to and what happens, for example: penicillin, rash.")}
          {radios("mobility", "Mobility", MOBILITY)}
          {radios("memory", "Memory", MEMORY)}
        </>}

        {step === 2 && <>
          <h3 className="intake-sub">Current medicines</h3>
          {a.meds.map((m, i) => (
            <fieldset key={i} className="intake-row">
              <legend>Medicine {i + 1}</legend>
              <div className="intake-grid">
                {([["name", "Name"], ["dose", "Dose"], ["times", "When they take it"], ["purpose", "What it is for"]] as const).map(([f, label]) => (
                  <div className="intake-field" key={f}>
                    <label htmlFor={`intake-med-${i}-${f}`}>{label}</label>
                    <input id={`intake-med-${i}-${f}`} value={m[f]} autoComplete="off" onChange={e => setRow("meds", i, { [f]: e.target.value })} />
                  </div>
                ))}
              </div>
              {a.meds.length > 1 && <button type="button" className="intake-link" onClick={() => set("meds", a.meds.filter((_, j) => j !== i))}>Remove medicine {i + 1}</button>}
            </fieldset>
          ))}
          <button type="button" className="btn btn-secondary btn-small" onClick={() => set("meds", [...a.meds, EMPTY_MED])}>Add another medicine</button>
          {text("pharmacy", "Pharmacy name")}
          {radios("organizer", "Do they use a pill organizer?", ["Yes", "No"])}
        </>}

        {step === 3 && <>
          {text("doctor", "Primary doctor", { hint: "Name and clinic." })}
          {area("specialists", "Specialists", "For example: Dr. Lee, cardiology.")}
          <h3 className="intake-sub">Family contacts</h3>
          {a.contacts.map((c, i) => (
            <fieldset key={i} className="intake-row">
              <legend>Contact {i + 1}</legend>
              <div className="intake-grid">
                {([["name", "Name", "text"], ["relation", "Relation", "text"], ["reach", "Phone or email", "text"]] as const).map(([f, label, type]) => (
                  <div className="intake-field" key={f}>
                    <label htmlFor={`intake-contact-${i}-${f}`}>{label}</label>
                    <input id={`intake-contact-${i}-${f}`} type={type} value={c[f]} autoComplete="off" onChange={e => setRow("contacts", i, { [f]: e.target.value })} />
                  </div>
                ))}
              </div>
              {a.contacts.length > 1 && <button type="button" className="intake-link" onClick={() => set("contacts", a.contacts.filter((_, j) => j !== i))}>Remove contact {i + 1}</button>}
            </fieldset>
          ))}
          <button type="button" className="btn btn-secondary btn-small" onClick={() => set("contacts", [...a.contacts, EMPTY_CONTACT])}>Add another contact</button>
          {text("emergency", "Who should we call first in an emergency?")}
        </>}

        {step === 4 && <>
          {area("alwaysTell", "What should Troska always tell the family?", "For example: any missed medicine, any fall, any new pain.")}
          {area("avoid", "Topics to avoid on calls")}
          <div className="intake-field">
            <label className="intake-choice intake-consent">
              <input id="intake-consent" type="checkbox" checked={a.consent} onChange={e => set("consent", e.target.checked)} {...errFor("intake-consent")} />
              I agree that Troska can share call summaries with the people listed above
            </label>
          </div>
        </>}

        {error && <p id="intake-error" className="intake-error" role="alert">{error.text}</p>}

        <div className="intake-nav">
          {step > 0 && <button type="button" className="btn btn-secondary" onClick={() => goTo(step - 1)}>Back</button>}
          <button id="intake-submit" type="submit" className="btn btn-primary" disabled={status === "saving"}>
            {step < STEPS.length - 1 ? "Next" : status === "saving" ? "Saving…" : "Save to the record"}
          </button>
          <button type="button" className="intake-link intake-reset" onClick={startOver}>Start over</button>
        </div>
      </form>
    </section>
  )
}
