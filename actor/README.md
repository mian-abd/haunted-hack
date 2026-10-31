# actor/ — ElderActor (Terse Durable Actor)

One durable actor per elder (actor id = elder id, demo: `grandpa-joe`). It holds the elder's profile, meds,
status and timeline, owns the one alarm that schedules the next check-in call, and pushes every state change
to connected dashboards over WebSocket. State and alarm survive restarts.

Contract: `PLAN.md` → "`ElderActor`". Code: `src/actor.ts`. Types to copy: `src/types.ts`.

## Contract deviations

None to the contract's types, fields or method signatures. Behavior the contract leaves open:

- `onAlarm()` also sets `nextCheckInAt = null` (the alarm is spent; nothing is scheduled until the next `scheduleCheckIn`).
- `scheduleCheckIn(atMs, reason?)` also logs a `note` event (`"Check-in scheduled: <reason>"`, `data.atMs`) and rounds `atMs` to an integer (the runtime rejects `Date.now() + 1.1 * 1000`).
- `setup()` also clears any pending alarm (full reset).
- `recordMed()` with an unknown med name still logs the `med` event but changes no med.
- Bad input throws (`ElderActor: ...` error) instead of corrupting state: invalid `status`, invalid event `kind`, non-string `text`/`reason`/`summary`, non-boolean `taken`, `setup` without `profile.name` + meds array. The Terse runtime does **not** check arguments against the TS types.
- Socket metadata type is `null`: call `prepareWebsocket({ actorId, metadata: null })`. Clients cannot send socket messages (`Incoming` is `never`).
- Event `from` values the actor writes itself: `"system"` (call/status/note events) and `"elder"` (`recordMed`).

## Using ElderActor from another folder

How `server/`, `care-team/` (or any Bun/TS folder) gets a typed ElderActor client. Copy-paste:

**1. Once per machine: install the Terse CLI** (if `terse` is not found, it is `~/.bun/bin/terse`; open a new terminal or `source ~/.zshrc`):

```sh
bunx terse-cli@latest install --yes
terse --version          # 0.14.9
```

**2. Start the actor dev server** (terminal 1, keep it running):

```sh
cd actor
bun install
terse actor dev          # Ready http://127.0.0.1:7100
```

**3. Generate the client from YOUR folder** (terminal 2, the dev server must be running):

```sh
cd server                # or care-team, ...
terse actor generate     # writes ./generated/  ("Generated actor client in generated from contract sha256:...")
```

- `generated/` lands in the directory you run the command from (`--out-dir <dir>` to change it).
  Equivalent from inside `actor/`: `terse actor generate --out-dir ../server/generated`.
- It is self-contained: `index.js`, `index.d.ts`, `types.d.ts`, `terse-transport.js`, `runtime/`. **No npm packages needed** (no `terse-sdk`, no `zod`).
- It holds no secrets or URLs (it reads env at call time), so commit it; a fresh clone then runs without regenerating.
- Re-run `terse actor generate` after any change to ElderActor's public methods or fields (wait until the dev server prints `Updated local actors.`). Current contract: `sha256:973bd0f8…`.

**4. Call it** (Bun loads `./.env` automatically when you run from your folder):

```ts
import { actors } from "./generated/index.js" // relative to your file

const elder = actors.ElderActor.get(elderId) // "grandpa-joe"

await elder.setup(profile, meds) // full reset (POST /api/demo/reset)
await elder.scheduleCheckIn(Date.now() + 15_000, "demo") // sets alarm + nextCheckInAt
const state = await elder.getState() // every emitted field
await elder.startCall()
await elder.recordMed("Amlodipine", false, "ran out") // case-insensitive name match
await elder.setStatus("watch", "Dizzy, out of BP meds")
const ev = await elder.logEvent({ kind: "agent_msg", from: "doctor", to: "caretaker", text: "Triage: ...", data: { lane: "doctor" } })
await elder.endCall("Joe is dizzy, out of amlodipine", "tired")

// GET /api/actor-ws?elderId= : hand the browser a socket URL (the browser never imports generated/)
const { websocketUrl } = await actors.ElderActor.prepareWebsocket({ actorId: elderId, metadata: null })
```

`setup()` from `supabase/seed.json`: `profile = { name, age, conditions, family: { name: family_name, relation: family_relation, phone: family_phone } }`
and `meds = prescriptions.filter(r => r.patient_id === id).map(r => ({ name, dose, times, purpose, lastTakenAt: null, missedCount: 0 }))`
(see `seedData()` in `smoke/smoke.ts`).

Types come with the client: `actors.ElderActor.State` (= `ElderState`), `actors.ElderActor.Outgoing`
(`{ type: "call_due" }`), `actors.ElderActor.Methods.logEvent.Args`, ... For named types (`TimelineEvent`, `Med`,
`Profile`, ...) copy `actor/src/types.ts`, or use `actors.ElderActor.State["timeline"][number]`.
If you type-check with `tsc`, use `"moduleResolution": "bundler"` so `./generated/index.js` resolves to its `.d.ts` (as `smoke/tsconfig.json` does).
Errors thrown in the actor reach the caller as `ActorInvocationError` with the actor's message.

**Socket messages** (browser does `new WebSocket(websocketUrl)`, then `JSON.parse(event.data)`):

| message | when |
|---|---|
| `{ type: "state", state: ElderState }` | right after connecting |
| `{ type: "state_update", changes: Partial<ElderState> }` | after every call that changed an emitted field; only changed fields, each with its **full new value** (`changes.timeline` is the whole array: replace, don't append) |
| `{ type: "call_due" }` | the alarm fired (followed by a `state_update` with `callState: "due"`, `nextCheckInAt: null`) |

The socket URL is a short-lived grant: open it within ~60 s (`connectByMs` in the grant). Get a fresh one from
`/api/actor-ws` on every (re)connect, and reconnect when the socket closes (it closes when the actor server restarts;
reconnecting is also what re-arms the alarm after a local restart, see "Durability" below). The socket stays open while the actor sleeps.

**Local vs cloud** (env of the folder that *calls* the actor, e.g. `server/.env`; not of `actor/`):

| target | env |
|---|---|
| local `terse actor dev` (default) | nothing. The client defaults to `http://127.0.0.1:7100/v1/projects/local/actors` |
| local on another port (`terse actor dev --port 7101`) | `TERSE_ACTOR_URL=http://127.0.0.1:7101/v1/projects/local/actors` |
| Terse cloud (after `terse deploy`) | `TERSE_ACTOR_URL=https://api.useterse.ai/<projectId>/actors` (printed by `terse deploy`) and `TERSE_API_KEY=<key from app.useterse.ai → API keys>` |

The same `generated/` works for both: the client picks the transport from `TERSE_ACTOR_URL` at call time. To switch
back to local, remove both variables. A cloud URL without `TERSE_API_KEY` fails with `Missing TERSE_API_KEY. Set it in
the .env of the project calling the actor.` Keep `TERSE_API_KEY` in backends only, never in `web/`.

## Run it

```sh
cd actor
bun install
terse actor dev                 # http://127.0.0.1:7100, watches src/, state in actor/.durable-actors/
bun run check                   # tsc --noEmit
```

Smoke test (needs the dev server; uses actor id `smoke-grandpa-joe`, so the demo's `grandpa-joe` is untouched):

```sh
cd actor/smoke
terse actor generate            # once, and after contract changes
bun smoke.ts                    # full check, ~10 s, ends with "SMOKE OK (full)"
bun run check                   # type-checks smoke.ts against generated/ (uses ../node_modules)
```

Point it at another server with `TERSE_ACTOR_URL=http://127.0.0.1:7101/v1/projects/local/actors bun smoke.ts`.

## Env vars

`actor/` needs none for local dev (see `.env.example`). The CLI reads `actor/.env`; keep it to `TERSE_*` names,
because `terse deploy` offers to upload every other variable in it as a cloud secret. Optional:

| var | used by | purpose |
|---|---|---|
| `TERSE_ACTOR_PORT` | `terse actor dev` | port (default 7100; `--port` wins) |
| `TERSE_ACTOR_SECRET` | `terse actor dev` | require a key locally; callers then set `TERSE_API_KEY` to the same value |
| `TERSE_API_KEY` | `terse deploy` | instead of `terse auth login` |
| `TERSE_ACTOR_URL`, `TERSE_API_KEY` | callers (`server/`, `care-team/`) | see "Local vs cloud" above |

## How it connects

```
server/ (:8787)  ──generated client (HTTP)──▶  ElderActor (:7100)  ◀──generated client──  care-team/ (:8788)
   │ GET /api/actor-ws → prepareWebsocket()           │ alarm → onAlarm() → call_due
   ▼                                                  ▼
web/ (:5173)  ═══════ WebSocket: state / state_update / call_due ═══════╛
```

- `server/` calls `setup`, `scheduleCheckIn`, `startCall`, `endCall`, `recordMed`, `logEvent`, `getState`, and hands the browser a `websocketUrl`.
- `care-team/` mirrors every Agent Relay message with `logEvent({ kind: "agent_msg", from, to, text, data: { lane } })` and calls `scheduleCheckIn` / `setStatus` for rechecks.
- `web/` only opens the WebSocket. It never imports the client or holds a Terse key.

## Durability (demo step 6) and what was verified

Real runs against `terse actor dev` (CLI 0.14.9, terse-sdk 0.14.9, runtime durable-actors 0.14.6), on :7100 and on a
second instance (`--port 7101`, own `DURABLE_ACTORS_DATA_DIR`) so the restart tests did not disturb other folders using :7100:

- `bun smoke.ts`: all checks pass (`SMOKE OK (full)`): `setup()` + `getState()` equal the grandpa-joe data from `supabase/seed.json`;
  socket gets `state` → `state_update` (`nextCheckInAt`) → `call_due` 58–146 ms after the alarm time (4 runs), then `state_update` `callState: "due"`;
  `startCall`/`endCall`/`recordMed`/`logEvent`/`setStatus` all show up in state and on the socket; invalid status/kind rejected; timeline capped at 200, newest last.
- Alarm while the actor sleeps: armed 30 s ahead, no calls in between, fired 264 ms after its time.
- Restart (stop `terse actor dev`, start it again): state after the restart deep-equals the state before it (200-event timeline, meds, status).
- Alarm across a restart: **the local runtime forgets a pending alarm when it restarts** (observed on both instances: it never fired). `ElderActor`
  therefore re-arms the alarm from the persisted `nextCheckInAt` on its first wake (socket connect or any method call). With that: armed 40 s ahead,
  restarted, a dashboard-style socket reconnect only → fired 359 ms after its time. Crash test: armed 12 s ahead, `kill -9` the runtime, restart
  after the alarm time → state intact, overdue alarm fired right after reconnect.
- Re-verified on a second machine (fresh Bun 1.4.4 + CLI 0.14.9 install, Oct 31 14:00): `SMOKE OK (full)` with `call_due` 36 ms after the
  alarm time; clean restart with a 40 s alarm → state equal, fired 97 ms after its time; `kill -9` with an 8 s alarm, 10 s down → overdue
  alarm fired on the first socket connect. The freshly generated client is byte-identical to the committed `server/generated` and `care-team/generated`.

To show it in the demo:

```sh
# terminal 1
cd actor && terse actor dev
# (dashboard shows the countdown) → Ctrl+C in terminal 1 → run `terse actor dev` again before the countdown ends
```

The dashboard must reconnect its socket (fresh grant from `/api/actor-ws`) or the server must call `getState`: that
wake-up re-arms the alarm, which then fires on time. Or replay it with the smoke script:

```sh
cd actor/smoke && bun smoke.ts && bun smoke.ts arm 40
# restart `terse actor dev` within 40 s, then:
bun smoke.ts verify             # "state after restart equals the snapshot" … "alarm armed before the restart fired after it"
```

## Deploy to Terse cloud (needs a human: browser login)

Not deployed yet. `terse auth login` needs an **organization** on the Terse account: after the device code is approved, the CLI
polls `/sdk/auth/identify` for up to 5 min until the account has one (it sends you to `app.useterse.ai/app/organizations/create`).
On Oct 31 three attempts stayed on "Waiting for organization creation" after creating the org in the browser (one ended in
`429 — Too many requests`): ask the Terse team at the venue, or get a `TERSE_API_KEY` and put it in `actor/.env`. Steps (from reading the CLI source):

```sh
terse auth login                                # opens the browser (add --no-browser to print the URL)
# one time: link actor/ to a cloud project. `terse attach` is disabled in CLI 0.14.9, so let init create the project:
cd "$(mktemp -d)" && terse init unc-actor --non-interactive   # prints "Created Terse project (<projectId>)"
cp unc-actor/terse.config.json <repo>/actor/terse.config.json # { "projectId", "name" }: not secret, commit it
cd <repo>/actor && terse deploy                 # type-checks, uploads src, prints TERSE_ACTOR_URL=https://api.useterse.ai/<projectId>/actors
```

Then create an API key at https://app.useterse.ai → **API keys**, and in `server/.env` and `care-team/.env` set
`TERSE_ACTOR_URL` (from the deploy output) and `TERSE_API_KEY`. Restart those services. Optionally run
`terse actor generate` there with those vars set to confirm the cloud contract matches. `terse deploy` uploads
`actor/` except `node_modules`, `.env`, `dist`, `.git`; it does include `.durable-actors/` (local dev state, fictional
data only) and `smoke/`; `rm -rf .durable-actors` first for a smaller upload (this wipes local dev state).

## What is mocked

Nothing. The actor makes no LLM or network calls, so it needs no mock mode.

## Known gaps

- Local alarm-after-restart relies on the re-arm shortcut above: the alarm only comes back once something touches the
  actor (socket reconnect or any call). Terse cloud stores alarms outside the actor, so it should not need it (not tested on cloud).
- No auth on the local dev server (anyone on localhost can call it). Set `TERSE_ACTOR_SECRET` if that matters.
- Every `state_update` that touches the timeline carries the whole timeline (up to 200 events). Fine for a demo.
- Not deployed to Terse cloud (needs the login above).
