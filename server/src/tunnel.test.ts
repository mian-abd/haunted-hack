import { expect, test } from "bun:test"

process.env.TERSE_FAKE = "1"
process.env.DEMO_ACCESS_KEY = "team123"
const { handle } = await import("./server")

const state = (headers: Record<string, string>) =>
  handle(new Request("http://127.0.0.1:8787/api/state?elderId=grandpa-joe", { headers }))

test("tunnel requests need the team access code", async () => {
  expect((await state({ "x-forwarded-for": "1.2.3.4" })).status).toBe(403)
  expect((await state({ "x-forwarded-for": "1.2.3.4", "x-unc-key": "wrong" })).status).toBe(403)
  expect((await state({ "x-forwarded-for": "1.2.3.4", "x-unc-key": "team123" })).status).not.toBe(403)
})

test("local requests (no tunnel) need no code", async () => {
  expect((await state({})).status).not.toBe(403)
})
