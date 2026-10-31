# server/ — Unc HTTP API (Bun, :8787)

The backend that sits between the browser and everything else. It mints OpenAI Realtime keys for the voice call, runs
the voice agent's tools against the `ElderActor`, sends escalations to the care team, and archives finished calls to
Supabase. It uses `Bun.serve` with no framework and has no runtime dependencies.

Contract: `PLAN.md`, sections "`server/` HTTP API" and "Voice-agent tools". Code: `src/server.ts` (routes and tools) and
`src/actor.ts` (ElderActor bridge plus in-memory fake). Tests: `src/server.test.ts`.

## Contract deviations

- **`onAlarm()` is not in the bridge.** It is a Terse runtime hook, and the generated client does not expose it. The
  alarm calls it. `src/actor.ts` exposes the other 8 contract methods and `prepareWebsocket(elderId)`.
- **`prepareWebsocket`**: the real SDK call is `actors.ElderActor.prepareWebsocket({ actorId, metadata: null })`. The bridge
  wraps it as `prepareWebsocket(elderId)`. `GET /api/actor-ws` returns the whole grant:
  `{ websocketUrl, homeRegion, connectByMs }`, which includes the contract's `{ websocketUrl }`.

Behavior the contract leaves open:

- `teach_back_result` with `understood: false` logs the `teach_back` event, then escalates `kind: "teach_back"`. The family
  lane gets exactly one message for it, from the care team's family agent over Agent Relay (the server writes no lane item).
- Errors are `{ error, output: "Error: ..." }` with status 400 (bad input) or 500. The `output` field means the voice model
  always gets a string from `/api/tool`.
- `/api/tool` accepts `args` as an object or as the JSON string that the Realtime data channel sends.
- In fake-actor mode, `GET /api/actor-ws` returns 503 `{ error, mock: true }` because the fake has no websocket. Poll
  `/api/state` instead.

## Run

```sh
cd server
bun install                 # dev types only (@types/bun). The server runs without it.
cp .env.example .env        # optional. With no keys, everything runs in mock/skip mode.
bun run start               # http://localhost:8787  (bun run dev = restart on file change)
```

The server reads `.env` from the folder it runs in, so start it from `server/`.

The actor is reached through the Terse generated client in `server/generated/`, which is committed. Before you start the
server, start the actor dev server:

```sh
cd actor && bun install && terse actor dev        # Ready http://127.0.0.1:7100
```

If the actor is not running, or for a server-only demo, use the in-memory fake:

```sh
TERSE_FAKE=1 bun run start
```

The fake is also used automatically when `server/generated/` is missing. The startup line shows which one is in use:
`server/ on http://localhost:8787/ · actor: terse actor dev (127.0.0.1:7100) · care-team: http://localhost:8788`.

After a change to ElderActor's public methods or fields, regenerate the client and commit the result. The actor dev
server must be running:

```sh
cd server && terse actor generate     # if terse is not found: ~/.bun/bin/terse
```

Tests and type check:

```sh
bun test            # fake actor + stubbed fetch. No network or keys needed.
bun run check       # tsc --noEmit (downloads typescript@5.9.3 through bunx)
```

## Env (`.env.example`)

| Var | Default | Effect |
|---|---|---|
| `OPENAI_API_KEY` | unset | Unset: `/api/realtime-token` returns 503 `{ error: "OPENAI_API_KEY not set", mock: true }` |
| `CARE_TEAM_URL` | `http://localhost:8788` | Escalations go to `POST $CARE_TEAM_URL/escalate` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | unset | Archiving runs only when both are set. Otherwise it is skipped silently. The key never leaves the server. |
| `TERSE_ACTOR_URL`, `TERSE_API_KEY` | local dev | Read by the generated client at call time. Set both only for Terse cloud (see `actor/README.md`). |
| `TERSE_FAKE` | unset | `1` = in-memory fake ElderActor |
| `PORT` | `8787` | Lets you test next to another running server |

## API

All `POST` bodies are JSON. Every route except `/api/realtime-token` needs `elderId` (in the body, or the query for
`GET`). The demo id is `grandpa-joe`. CORS allows `http://localhost:5173` and `http://127.0.0.1:5173`, and the server
answers `OPTIONS` preflights.

| Route | Does | Returns |
|---|---|---|
| `GET /api/realtime-token` | Calls `POST https://api.openai.com/v1/realtime/client_secrets` with `session: { type: "realtime", model: "gpt-realtime-2.1", audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" } }, output: { voice: "marin" } } }` | `{ value, expires_at, model }` (`value` is an `ek_...` key) |
| `GET /api/actor-ws?elderId=` | `prepareWebsocket` | `{ websocketUrl, homeRegion, connectByMs }` |
| `GET /api/state?elderId=` | `getState()` | ElderState |
| `POST /api/tool` `{ elderId, name, args }` | Runs a voice tool (table below) | `{ output }` |
| `POST /api/demo/reset` `{ elderId }` | `setup()` with the patient and prescriptions from `supabase/seed.json` (`lastTakenAt: null`, `missedCount: 0`) | `{ ok: true }` |
| `POST /api/demo/schedule` `{ elderId, inSeconds }` | `scheduleCheckIn(now + inSeconds * 1000, "Demo check-in")` | `{ ok: true, atMs }` |
| `POST /api/demo/vitals` `{ elderId, heartRate, note? }` | Logs a `vitals` event, then escalates `kind: "vitals"` | `{ ok: true }` |
| `POST /api/call/start` `{ elderId }` | `startCall()` | `{ ok: true }` |
| `POST /api/call/end` `{ elderId, summary, mood? }` | `endCall()` and the Supabase archive. A missing summary becomes `"Call ended."` | `{ ok: true }` |

Voice tools (`POST /api/tool`):

| Tool | Actor call | Escalation (`kind`) | Example `output` |
|---|---|---|---|
| `confirm_medication { med, taken, note? }` | `recordMed` | none | `Logged: Metformin taken.` |
| `report_symptom { symptom, severity }` | `logEvent` `symptom` | `symptom` when severity is medium or high | `Logged symptom: dizzy (medium). Care team notified.` |
| `teach_back_result { med, understood, note? }` | `logEvent` `teach_back` | `teach_back` if not understood | `Logged: teach-back for Metformin not understood. Family notified.` |
| `request_refill { med }` | none | `refill` | `Refill request sent to the pharmacy for Amlodipine.` |
| `end_call { summary, mood }` | `endCall` + Supabase archive | `summary` | `Call ended. Summary sent to the family.` |

Escalations are fire-and-forget POSTs with a 2 s timeout. A failure is logged as
`[escalate] <kind>: care-team call failed (...), continuing`, and the tool still answers.

The Supabase archive is a PostgREST insert. It always sends `apikey`, and adds `Authorization: Bearer` only when the key is a
legacy JWT `service_role` key: a new `sb_secret_...` key is not a JWT, and Supabase rejects it as a Bearer token (`supabaseAuth`
in `src/server.ts`, unit-tested). It writes
`calls { patient_id, summary, mood }` and `care_events { patient_id, kind: "call_ended", from_agent: "system", text, data: { mood } }`.
Columns follow `supabase/migrations/20261031120000_init.sql`. The archive is also fire-and-forget.

## How it connects

- **web/** calls this API. For the voice call it gets `value` from `/api/realtime-token`, then POSTs its SDP offer to
  `https://api.openai.com/v1/realtime/calls` with `Authorization: Bearer <value>` and `Content-Type: application/sdp`.
  It sends its own instructions and tools with `session.update`, and forwards each tool call to `/api/tool`. For the
  live dashboard it opens `websocketUrl` from `/api/actor-ws` directly against Terse. Open it within `connectByMs`,
  and fetch a new grant on every reconnect.
- **actor/** (`ElderActor`, :7100) is reached through `server/generated/` (Terse generated client).
- **care-team/** (:8788) receives `POST /escalate { elderId, kind, reason, details }` and expects nothing back.
- **Supabase** receives the call archive when its env vars are set.

## What is mocked

- No `OPENAI_API_KEY`: `/api/realtime-token` returns 503 `{ mock: true }`. This is the signal for web/ to switch to its
  scripted demo. The server makes no other LLM calls.
- `TERSE_FAKE=1`, or no `generated/`: an in-memory ElderActor that mirrors `actor/src/actor.ts`, including events, texts and
  a `setTimeout` alarm. It has no websocket and loses its state on restart.
- Tests stub `fetch`, so no care team, Supabase or OpenAI is needed.

## Known gaps

- `/api/realtime-token` verified against live OpenAI on Oct 31: it returns an `ek_` key with `model: "gpt-realtime-2.1"`, and a
  headless Chrome call with that key reached `connected`, `session.updated` and `response.done` (see the root README).
- The Supabase archive has not been run against a real project (no credentials here). `calls.started_at` and
  `calls.transcript` stay empty.
- The `end_call` tool and `POST /api/call/end` both end the call. Calling both for one call logs two `call_ended` events
  and archives twice. web/ should use `/api/call/end` only when a call ends without the tool.
- The API has no auth (local demo). CORS stops other websites, not other local processes.
