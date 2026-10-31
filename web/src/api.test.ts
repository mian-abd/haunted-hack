import { afterEach, expect, test } from "bun:test"
import { NEED_CODE, getJSON, post } from "./api"

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch; delete (globalThis as any).window })

test("a 403 (no team code) asks the page for the code, and a 200 does not", async () => {
  const page = new EventTarget(), asked: string[] = []
  ;(globalThis as any).window = page
  page.addEventListener(NEED_CODE, e => asked.push(e.type))
  globalThis.fetch = (async () => Response.json({ error: "forbidden" }, { status: 403 })) as unknown as typeof fetch
  await expect(getJSON("/api/records?elderId=grandpa-joe")).rejects.toThrow("/api/records returned 403")
  expect(asked).toEqual([NEED_CODE])
  globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch
  await post("/api/records", { note: "x" })
  expect(asked).toEqual([NEED_CODE])
})

test("post: a 400 from /api/tool keeps the server's readable output on err.body", async () => {
  globalThis.fetch = (async () => Response.json({ error: "severity must be low, medium or high", output: "Error: severity must be low, medium or high" }, { status: 400 })) as unknown as typeof fetch
  const err = await post("/api/tool", { name: "report_symptom", args: {} }).catch(e => e)
  expect(err.message).toBe("/api/tool returned 400")
  expect(err.body.output).toBe("Error: severity must be low, medium or high")
})
