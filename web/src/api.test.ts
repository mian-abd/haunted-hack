import { afterEach, expect, test } from "bun:test"
import { post } from "./api"

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

test("post: a 400 from /api/tool keeps the server's readable output on err.body", async () => {
  globalThis.fetch = (async () => Response.json({ error: "severity must be low, medium or high", output: "Error: severity must be low, medium or high" }, { status: 400 })) as unknown as typeof fetch
  const err = await post("/api/tool", { name: "report_symptom", args: {} }).catch(e => e)
  expect(err.message).toBe("/api/tool returned 400")
  expect(err.body.output).toBe("Error: severity must be low, medium or high")
})
