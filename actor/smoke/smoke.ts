// End-to-end check of ElderActor against a running `terse actor dev` (see ../README.md).
//   bun smoke.ts            full check: setup, socket, alarm, meds, events, status, timeline cap (~10 s)
//   bun smoke.ts arm [sec]  schedule the alarm N s ahead (default 30) and snapshot the state, then exit
//   bun smoke.ts verify     after restarting the dev server: state equals the snapshot, the armed alarm still fires
import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { actors } from "./generated/index.js"

type State = actors.ElderActor.State
type Msg = { type: "state"; state: State } | { type: "state_update"; changes: Partial<State> } | actors.ElderActor.Outgoing

const ID = "smoke-grandpa-joe" // grandpa-joe's data under its own id, so the demo actor is untouched
const SNAPSHOT = join(tmpdir(), "elder-actor-smoke-snapshot.json")
const elder = actors.ElderActor.get(ID)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const ok = (what: string) => console.log(`OK  ${what}`)
let logSocket = true

async function waitFor<T>(what: string, ms: number, check: () => T | undefined): Promise<T> {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
        const value = check()
        if (value !== undefined) return value
    }
    throw new Error(`timed out after ${ms} ms waiting for ${what}`)
}

async function openSocket() {
    const { websocketUrl } = await actors.ElderActor.prepareWebsocket({ actorId: ID, metadata: null })
    const ws = new WebSocket(websocketUrl)
    const received: { at: number; message: Msg }[] = []
    ws.addEventListener("message", event => {
        const message = JSON.parse(String(event.data)) as Msg
        received.push({ at: Date.now(), message })
        const detail =
            message.type === "state"
                ? `profile=${message.state.profile?.name} callState=${message.state.callState} timeline=${message.state.timeline.length}`
                : message.type === "state_update"
                  ? JSON.stringify(message.changes, (key, value) => (key === "timeline" ? `[${value.length} events]` : key === "meds" ? "[meds]" : value))
                  : ""
        if (logSocket) console.log(`    ws <- ${message.type} ${detail}`)
    })
    await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true })
        ws.addEventListener("error", () => reject(new Error("socket error")), { once: true })
    })
    // Index of the first message matching `match`, or undefined (for waitFor).
    const first = (match: (message: Msg) => boolean) => {
        const index = received.findIndex(entry => match(entry.message))
        return index < 0 ? undefined : index
    }
    return { ws, received, first }
}

async function seedData(): Promise<{ profile: NonNullable<State["profile"]>; meds: State["meds"] }> {
    const seed = JSON.parse(await readFile(new URL("../../supabase/seed.json", import.meta.url), "utf8"))
    const p = seed.patients.find((patient: { id: string }) => patient.id === "grandpa-joe")
    const profile = { name: p.name, age: p.age, conditions: p.conditions, family: { name: p.family_name, relation: p.family_relation, phone: p.family_phone } }
    const meds = seed.prescriptions
        .filter((rx: { patient_id: string }) => rx.patient_id === "grandpa-joe")
        .map((rx: { name: string; dose: string; times: string[]; purpose: string }) => ({ name: rx.name, dose: rx.dose, times: rx.times, purpose: rx.purpose, lastTakenAt: null, missedCount: 0 }))
    return { profile, meds }
}

async function full() {
    const { profile, meds } = await seedData()
    await elder.setup(profile, meds)
    let s = await elder.getState()
    assert.deepEqual(s, { profile, meds, status: "ok", statusReason: "", callState: "idle", nextCheckInAt: null, timeline: [] })
    ok(`setup() + getState() match supabase/seed.json grandpa-joe (${profile.name}, ${meds.map(m => m.name).join(", ")})`)

    const socket = await openSocket()
    await waitFor("state message", 5_000, () => socket.first(m => m.type === "state"))
    const at = Date.now() + 5_000
    await elder.scheduleCheckIn(at, "smoke test")
    const scheduled = await waitFor("state_update with nextCheckInAt", 5_000, () => socket.first(m => m.type === "state_update" && m.changes.nextCheckInAt === at))
    console.log("    waiting 5 s for the alarm...")
    const due = await waitFor("call_due broadcast", 20_000, () => socket.first(m => m.type === "call_due"))
    const dueUpdate = await waitFor("state_update callState=due", 5_000, () => socket.first(m => m.type === "state_update" && m.changes.callState === "due"))
    assert.ok(0 === socket.first(m => m.type === "state") && scheduled > 0 && due > scheduled, "order: state, state_update, call_due")
    s = await elder.getState()
    assert.equal(s.callState, "due")
    assert.equal(s.nextCheckInAt, null)
    assert.deepEqual(s.timeline.map(e => e.kind), ["note", "call_due"])
    ok(`socket got state -> state_update -> call_due (#${due}, ${socket.received[due].at - at} ms after the alarm time; state_update callState=due #${dueUpdate})`)

    await elder.startCall()
    s = await elder.getState()
    assert.equal(s.callState, "in_progress")
    assert.equal(s.timeline.at(-1)?.kind, "call_started")
    ok("startCall() -> callState in_progress + call_started event")

    await elder.recordMed("amlodipine", false, "ran out")
    await elder.recordMed("AMLODIPINE", false)
    s = await elder.getState()
    assert.equal(s.meds.find(m => m.name === "Amlodipine")?.missedCount, 2)
    assert.equal(s.meds.find(m => m.name === "Amlodipine")?.lastTakenAt, null)
    await elder.recordMed("Amlodipine", true)
    await elder.recordMed("Aspirin", true) // not prescribed: logged, meds unchanged
    s = await elder.getState()
    const amlodipine = s.meds.find(m => m.name === "Amlodipine")
    assert.equal(amlodipine?.missedCount, 0)
    assert.ok(amlodipine?.lastTakenAt && Date.now() - amlodipine.lastTakenAt < 10_000)
    assert.deepEqual(
        s.meds.filter(m => m.name !== "Amlodipine"),
        meds.filter(m => m.name !== "Amlodipine")
    )
    assert.deepEqual(s.timeline.slice(-4).map(e => `${e.kind}: ${e.text}`), [
        "med: amlodipine: not taken (ran out)",
        "med: AMLODIPINE: not taken",
        "med: Amlodipine: taken",
        "med: Aspirin: taken"
    ])
    ok("recordMed(): case-insensitive; missed x2 -> missedCount 2; taken -> lastTakenAt=now, missedCount 0; unknown med only logged")

    const event = await elder.logEvent({ kind: "agent_msg", from: "doctor", to: "caretaker", text: "Triage: dizzy, missed amlodipine. Recheck in 2 h.", data: { lane: "doctor", urgency: "watch" } })
    assert.match(event.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    assert.ok(Math.abs(event.ts - Date.now()) < 10_000)
    s = await elder.getState()
    assert.deepEqual(s.timeline.at(-1), event)
    ok(`logEvent() returns the stored event (id ${event.id})`)

    await elder.setStatus("watch", "Dizzy and out of blood-pressure pills")
    s = await elder.getState()
    assert.equal(s.status, "watch")
    assert.equal(s.statusReason, "Dizzy and out of blood-pressure pills")
    assert.deepEqual([s.timeline.at(-1)?.kind, s.timeline.at(-1)?.data?.urgency], ["status", "watch"])
    ok("setStatus() -> status/statusReason + status event")

    await elder.endCall("Joe is dizzy and out of amlodipine; metformin timing corrected.", "tired")
    s = await elder.getState()
    assert.equal(s.callState, "idle")
    assert.deepEqual([s.timeline.at(-1)?.kind, s.timeline.at(-1)?.data?.mood], ["call_ended", "tired"])
    ok("endCall() -> callState idle + call_ended event with mood")

    await assert.rejects(elder.setStatus("yellow" as never, "x"), /setStatus needs status/)
    await assert.rejects(elder.logEvent({ kind: "oops" as never, text: "x" }), /logEvent needs kind/)
    ok("invalid status / event kind are rejected")

    await waitFor("socket updates for status and callState", 5_000, () => socket.first(m => m.type === "state_update" && m.changes.status === "watch"))
    ok(`socket received ${socket.received.filter(r => r.message.type === "state_update").length} state_update messages so far`)

    logSocket = false // 205 more updates
    for (let i = 1; i <= 205; i++) await elder.logEvent({ kind: "note", from: "system", text: `cap ${i}` })
    s = await elder.getState()
    assert.equal(s.timeline.length, 200)
    assert.equal(s.timeline.at(-1)?.text, "cap 205")
    assert.equal(s.timeline[0].text, "cap 6")
    ok("timeline capped at 200, newest last")
    socket.ws.close()
}

async function arm(seconds: number) {
    const at = Date.now() + seconds * 1000
    await elder.scheduleCheckIn(at, "durability test")
    const s = await elder.getState()
    await writeFile(SNAPSHOT, JSON.stringify(s))
    console.log(`OK  alarm armed for ${new Date(at).toISOString()} (in ${seconds} s); snapshot: status=${s.status} timeline=${s.timeline.length} -> ${SNAPSHOT}`)
}

async function verify() {
    const before = JSON.parse(await readFile(SNAPSHOT, "utf8")) as State
    // Only a socket, like a dashboard reconnecting after the restart: no RPC until the alarm has fired.
    const socket = await openSocket()
    const first = await waitFor("state message", 5_000, () => socket.first(m => m.type === "state"))
    const s = (socket.received[first].message as { state: State }).state
    assert.deepEqual(s, before)
    ok(`state after restart equals the snapshot (profile=${s.profile?.name} status=${s.status} timeline=${s.timeline.length} nextCheckInAt=${s.nextCheckInAt})`)
    assert.ok(s.nextCheckInAt, "no armed alarm: run `bun smoke.ts arm` first")
    if (s.nextCheckInAt < Date.now()) console.log("    the alarm time passed while the server was down: it should fire right away")
    console.log(`    waiting ${Math.max(0, Math.round((s.nextCheckInAt - Date.now()) / 1000))} s for the alarm...`)
    const due = await waitFor("call_due after the restart", Math.max(0, s.nextCheckInAt - Date.now()) + 20_000, () => socket.first(m => m.type === "call_due"))
    assert.equal((await elder.getState()).callState, "due")
    ok(`alarm armed before the restart fired after it (${socket.received[due].at - s.nextCheckInAt} ms after its time); callState=due`)
    socket.ws.close()
}

const [mode = "full", arg] = process.argv.slice(2)
if (mode === "arm") await arm(Number(arg ?? 30))
else if (mode === "verify") await verify()
else await full()
console.log(`SMOKE OK (${mode})`)
