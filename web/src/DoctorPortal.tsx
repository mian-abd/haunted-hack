import { useEffect, useState, type FormEvent } from "react"
import { getJSON, post, ELDER } from "./api"
import "./DoctorPortal.css"

// shortcut: demo login checked in the browser, not real auth (the API stays gated by the team access code); replace with real sign-in before real patient data.
const DEMO = { email: "care@troska.health", password: "troska-demo" }
const KEY = "troska-doctor"

type Note = { id?: string | number; author: string; note: string; created_at?: string }

const remembered = () => { try { return sessionStorage.getItem(KEY) === "1" } catch { return false } }
const remember = (on: boolean) => {
  try { if (on) sessionStorage.setItem(KEY, "1"); else sessionStorage.removeItem(KEY) } catch { /* storage blocked: the login lasts this page load */ }
}
const when = (s?: string) => {
  const d = s ? new Date(s) : null
  return d && !isNaN(+d) ? d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : ""
}

export function DoctorPortal() {
  const [authed, setAuthed] = useState(remembered)
  return (
    <div className="dp">
      <header className="dp-head">
        <span className="dp-mark">Troska</span>
        <span className="dp-for">For doctors and caregivers</span>
        <a className="dp-back" href="/live">Back to the live view</a>
      </header>
      <main className="dp-main">
        {authed
          ? <Record onSignOut={() => { remember(false); setAuthed(false) }} />
          : <Login onIn={() => { remember(true); setAuthed(true) }} />}
      </main>
    </div>
  )
}

function Login({ onIn }: { onIn: () => void }) {
  const [error, setError] = useState("")
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    if (String(f.get("email")).trim().toLowerCase() === DEMO.email && f.get("password") === DEMO.password) onIn()
    else setError("That email and password do not match. Check them and try again.")
  }
  return (
    <section aria-labelledby="dp-login">
      <h1 id="dp-login" className="dp-h1">Sign in</h1>
      <p className="dp-lead">See the patient record and add notes for Troska's care team.</p>
      <form className="dp-form" onSubmit={submit}>
        <label className="dp-field">Email<input name="email" type="email" autoComplete="username" required /></label>
        <label className="dp-field">Password<input name="password" type="password" autoComplete="current-password" required /></label>
        {error && <p className="dp-error" role="alert">{error}</p>}
        <button className="btn btn-primary" type="submit">Sign in</button>
      </form>
      <p className="dp-hint">Demo login: care@troska.health · troska-demo</p>
    </section>
  )
}

function Record({ onSignOut }: { onSignOut: () => void }) {
  const [data, setData] = useState<any>(null)
  const [loadError, setLoadError] = useState("")
  const [notes, setNotes] = useState<Note[]>([])
  useEffect(() => {
    getJSON(`/api/records?elderId=${ELDER}`)
      .then(d => { setData(d); setNotes(d.clinical_notes ?? []) })
      .catch(() => setLoadError("We could not load the patient record. Check the connection and reload the page."))
  }, [])
  const p = data?.patient

  return (
    <>
      <div className="dp-bar">
        <p className="dp-explain">Troska's doctor agent reads these notes when it triages a check-in call.</p>
        <button className="btn btn-secondary btn-small" type="button" onClick={onSignOut}>Sign out</button>
      </div>
      {loadError && <p className="dp-error" role="alert">{loadError}</p>}
      {!data && !loadError && <p className="dp-muted">Loading the patient record…</p>}
      {data && !p && <p className="dp-muted">No patient record found.</p>}

      {p && (
        <section className="dp-section" aria-labelledby="dp-patient">
          <p className="dp-source">{data.source === "supabase" ? "From the patient record" : "Sample record"}</p>
          <h1 id="dp-patient" className="dp-h1">{p.name}<span className="dp-age">, {p.age}</span></h1>
          <dl className="dp-facts">
            <div><dt>Conditions</dt><dd>{(p.conditions ?? []).join(", ") || "None recorded"}</dd></div>
            <div><dt>Primary doctor</dt><dd>{p.primary_doctor}</dd></div>
            {/* Family name and relation only: the phone number never leaves the server's call path. */}
            <div><dt>Family contact</dt><dd>{p.family_name}, {p.family_relation}</dd></div>
          </dl>
        </section>
      )}

      {data && (
        <section className="dp-section" aria-labelledby="dp-meds">
          <h2 id="dp-meds" className="dp-h2">Medicines</h2>
          {data.prescriptions?.length ? (
            <ul className="dp-list">
              {data.prescriptions.map((m: any, i: number) => (
                <li key={`${m.name}-${i}`}>
                  <p><strong>{m.name}</strong> <span className="dp-muted">{m.dose}</span></p>
                  <p>For {m.purpose}. Taken at {(m.times ?? []).join(", ")}.</p>
                  <p className="dp-muted">{m.refills_left} refill{m.refills_left === 1 ? "" : "s"} left</p>
                </li>
              ))}
            </ul>
          ) : <p className="dp-muted">No medicines on file.</p>}
        </section>
      )}

      {data && (
        <section className="dp-section" aria-labelledby="dp-notes">
          <h2 id="dp-notes" className="dp-h2">Clinical notes</h2>
          {notes.length ? (
            <ol className="dp-notes">
              {notes.map((n, i) => (
                <li key={n.id ?? i}>
                  <p className="dp-meta">{n.author}{when(n.created_at) && <> · <time dateTime={n.created_at}>{when(n.created_at)}</time></>}</p>
                  <p className="dp-note">{n.note}</p>
                </li>
              ))}
            </ol>
          ) : <p className="dp-muted">No notes yet.</p>}
        </section>
      )}

      {data && <AddNote onSaved={n => setNotes(ns => [n, ...ns])} />}
    </>
  )
}

function AddNote({ onSaved }: { onSaved: (n: Note) => void }) {
  const [author, setAuthor] = useState("Dr. Patel's office")
  const [note, setNote] = useState("")
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  async function loadFile(file?: File) {
    if (!file) return
    if (!/\.(txt|md)$/i.test(file.name)) return setMsg({ ok: false, text: "Choose a .txt or .md file. Other files cannot be read here." })
    try {
      const text = await file.text() // read as text in the browser; nothing binary is uploaded
      if (text.length > 4000) return setMsg({ ok: false, text: "That file is longer than 4,000 characters. Paste the part that matters instead." })
      setNote(text)
      setMsg(null)
    } catch {
      setMsg({ ok: false, text: "We could not read that file. Try another one, or paste the text." })
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!note.trim()) return setMsg({ ok: false, text: "Write a note first." })
    setSaving(true)
    setMsg(null)
    try {
      const res = await post("/api/records", { author: author.trim(), note: note.trim() })
      if (res?.note) onSaved(res.note)
      setNote("")
      setMsg({ ok: true, text: "Saved. Troska's care team will use this on the next call." })
    } catch (err: any) {
      // The typed note stays in the box so nothing is lost.
      setMsg({ ok: false, text: err?.body?.error ? `Not saved: ${err.body.error}` : "Not saved. Check the connection and try again." })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="dp-section" aria-labelledby="dp-add">
      <h2 id="dp-add" className="dp-h2">Add to the record</h2>
      <form className="dp-form" onSubmit={save}>
        <label className="dp-field">Written by<input value={author} onChange={e => setAuthor(e.target.value)} maxLength={120} autoComplete="organization" /></label>
        <label className="dp-field">Note<textarea value={note} onChange={e => setNote(e.target.value)} rows={7} maxLength={4000} /></label>
        <label className="dp-field dp-file">Load from a file (.txt or .md, optional)
          <input type="file" accept=".txt,.md,text/plain,text/markdown" onChange={e => loadFile(e.target.files?.[0])} />
        </label>
        <p className={`dp-msg ${msg?.ok ? "dp-ok" : "dp-error"}`} aria-live="polite">{msg?.text}</p>
        <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Save to the record"}</button>
      </form>
    </section>
  )
}
