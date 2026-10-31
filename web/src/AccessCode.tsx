import { useEffect, useState, type FormEvent } from "react"
import { HAS_KEY, NEED_CODE, rememberKey } from "./api"
import "./AccessCode.css"

/** Asks for the team code when server/ answers 403 (see api.ts), over whichever page is open. Saving reloads the page. */
export function AccessCode() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener(NEED_CODE, show)
    return () => window.removeEventListener(NEED_CODE, show)
  }, [])
  if (!open) return null

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const code = String(new FormData(e.currentTarget).get("code") ?? "").trim()
    if (code) rememberKey(code)
  }
  return (
    <div className="ac-backdrop">
      <form className="ac-card" role="dialog" aria-modal="true" aria-labelledby="ac-title" onSubmit={submit}>
        <h2 id="ac-title" className="ac-title">Enter the team code</h2>
        <p className="ac-text">This demo runs on a live server, so it asks for the code once. This browser remembers it.</p>
        {HAS_KEY && <p className="ac-error" role="alert">That code did not work. Check it and try again.</p>}
        <label className="ac-field">Team code<input name="code" autoComplete="off" spellCheck={false} autoFocus required /></label>
        <button className="btn btn-primary" type="submit">Continue</button>
      </form>
    </div>
  )
}
