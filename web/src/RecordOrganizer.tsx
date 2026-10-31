import { useState, type ChangeEvent } from "react"
import { post } from "./api"
import "./RecordOrganizer.css"

type Medication = { name: string; dose: string; times: string[]; purpose: string; refills_left?: number }
type Organized = { summary: string; conditions: string[]; allergies: string[]; medications: Medication[]; notes: string[]; follow_ups: string[] }
type ListKey = Exclude<keyof Organized, "summary">

const SAMPLES = [
  { label: "Hospital discharge summary", file: "discharge-summary.txt" },
  { label: "Lab report from the clinic", file: "lab-report.txt" },
  { label: "Pharmacy medicine list", file: "pharmacy-list.txt" },
]
const GROUPS: { key: ListKey; title: string }[] = [
  { key: "medications", title: "Medicines" },
  { key: "allergies", title: "Allergies" },
  { key: "conditions", title: "Conditions" },
  { key: "follow_ups", title: "Follow-ups" },
  { key: "notes", title: "Notes" },
]

// The server's answer is a trust boundary: missing or odd fields become empty, never a crash.
const tidy = (o: any): Organized => ({
  summary: typeof o.summary === "string" ? o.summary : "",
  ...(Object.fromEntries(GROUPS.map(g => [g.key, Array.isArray(o[g.key]) ? o[g.key] : []])) as Omit<Organized, "summary">),
})

function MedLine({ m }: { m: Medication }) {
  const times = Array.isArray(m.times) ? m.times.join(", ") : ""
  return (
    <>
      <strong>{m.name}</strong>{m.dose ? ` ${m.dose}` : ""}
      {(times || m.purpose || m.refills_left != null) && (
        <span className="ro-sub">
          {[times, m.purpose && `for ${m.purpose}`, m.refills_left != null && `${m.refills_left} refills left`].filter(Boolean).join(" · ")}
        </span>
      )}
    </>
  )
}

export function RecordOrganizer({ elderId, author, onSaved }: { elderId: string; author: string; onSaved?: () => void }) {
  const [text, setText] = useState("")
  const [step, setStep] = useState<"idle" | "reading" | "ready" | "saving" | "saved">("idle")
  const [error, setError] = useState("")
  const [found, setFound] = useState<{ organized: Organized; source: string } | null>(null)
  const [skip, setSkip] = useState<Set<string>>(new Set()) // ids of items the person left out; everything else is checked

  const toggle = (id: string) => setSkip(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  async function loadSample(file: string) {
    setError("")
    try {
      const r = await fetch(`/samples/${file}`)
      // the dev server answers a missing file with the app's own page, so html counts as missing
      if (!r.ok || r.headers.get("content-type")?.includes("html")) throw new Error(`${file} ${r.status}`)
      setText(await r.text())
    } catch (e) {
      console.warn("sample", e)
      setError("That sample is not available right now. You can paste a document instead.")
    }
  }

  async function loadFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = "" // lets the same file be chosen again
    if (!file) return
    setError("")
    if (!/\.(txt|md)$/i.test(file.name) && !file.type.startsWith("text/")) return setError("Please choose a .txt or .md file. Troska reads plain text only.")
    if (file.size > 90_000) return setError("That file is too long. Please paste the most important part instead.")
    setText(await file.text())
  }

  async function organize() {
    if (!text.trim()) return setError("Paste a document, load a file or pick a sample first.")
    setError(""); setStep("reading"); setFound(null)
    try {
      const res = await post("/api/records/organize", { elderId, text })
      if (!res?.organized) throw new Error("no organized field in the answer")
      setFound({ organized: tidy(res.organized), source: res.source })
      setSkip(new Set())
      setStep("ready")
    } catch (e) {
      console.warn("organize", e)
      setError("Troska could not read that document. Please try again in a moment.")
      setStep("idle")
    }
  }

  async function save() {
    if (!found) return
    const o = found.organized
    const chosen = {
      summary: skip.has("summary") ? "" : o.summary,
      ...Object.fromEntries(GROUPS.map(g => [g.key, (o[g.key] as unknown[]).filter((_, i) => !skip.has(`${g.key}:${i}`))])),
    } as Organized
    if (!chosen.summary && GROUPS.every(g => chosen[g.key].length === 0)) return setError("Every item is unchecked. Check at least one to save.")
    setError(""); setStep("saving")
    try {
      await post("/api/records/apply", { elderId, author, organized: chosen })
      setStep("saved")
      onSaved?.()
    } catch (e) {
      console.warn("apply", e)
      setError("Saving did not work. Nothing was changed. Please try again.")
      setStep("ready")
    }
  }

  const busy = step === "reading" || step === "saving"
  const o = found?.organized

  return (
    <section className="ro" aria-labelledby="ro-title">
      <div className="ro-add">
        <h2 id="ro-title" className="ro-h2">Add a document</h2>
        <p className="ro-lede">Paste a discharge summary, lab report or pharmacy list. Troska's records agent sorts it into the patient record.</p>

        <label htmlFor="ro-text" className="ro-label">The document</label>
        <textarea id="ro-text" className="ro-text" rows={10} value={text} onChange={e => setText(e.target.value)}
          placeholder="Paste the document here" spellCheck={false} />

        <div className="ro-sources">
          <label className="btn btn-secondary btn-small ro-file">
            <input type="file" className="sr-only" accept=".txt,.md,text/plain,text/markdown" onChange={loadFile} />
            Load from a file
          </label>
          <details className="ro-samples">
            <summary>Use a sample</summary>
            <p className="muted">Play the hospital, the clinic or the pharmacy for Joe.</p>
            <div className="ro-sample-list">
              {SAMPLES.map(s => (
                <button key={s.file} type="button" className="btn btn-secondary btn-small" onClick={() => loadSample(s.file)}>{s.label}</button>
              ))}
            </div>
          </details>
        </div>

        <button type="button" className="btn btn-primary ro-go" onClick={organize} disabled={busy}>Organize with Troska</button>
      </div>

      <div role="status" aria-live="polite" className="ro-status">
        {step === "reading" && <p className="ro-working"><span className="ro-dots" aria-hidden="true"><span /><span /><span /></span>Troska is reading the document…</p>}
        {step === "saved" && <p className="ro-saved">Saved to Joe's record. Troska's care team will use it on the next call.</p>}
      </div>
      {error && <p role="alert" className="ro-error">{error}</p>}

      {o && step !== "reading" && (
        <div className="ro-found enter">
          <h2 className="ro-h2">What Troska found</h2>
          <p className="ro-source muted">{found?.source === "openai" ? "Organized by Troska's records agent" : "Organized with simple rules"}. Uncheck anything you want to leave out.</p>

          {o.summary && (
            <section className="ro-group">
              <h3 className="ro-h3">Summary</h3>
              <label className="ro-item">
                <input type="checkbox" checked={!skip.has("summary")} onChange={() => toggle("summary")} />
                <span className="ro-item-text">{o.summary}</span>
              </label>
            </section>
          )}

          {GROUPS.filter(g => o[g.key].length > 0).map(g => (
            <section className="ro-group" key={g.key}>
              <h3 className="ro-h3">{g.title}</h3>
              <ul className="ro-list">
                {(o[g.key] as (string | Medication)[]).map((item, i) => {
                  const id = `${g.key}:${i}`
                  return (
                    <li key={id}>
                      <label className="ro-item">
                        <input type="checkbox" checked={!skip.has(id)} onChange={() => toggle(id)} />
                        <span className="ro-item-text">{typeof item === "string" ? item : <MedLine m={item} />}</span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}

          {step !== "saved" && (
            <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
              {step === "saving" ? "Saving…" : "Save to the record"}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
