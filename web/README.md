# web/: the Troska demo screen

## Contract deviations

None. Two choices the contract leaves open:

- **`POST /api/call/end` only goes out when the call ends early**, for example from Hang up or a dropped connection. When the agent calls `end_call`, server/ already runs `endCall` through `/api/tool`. Posting `/api/call/end` as well would log `call_ended` twice.
- **Tool calls are read from `response.done`.** That event has the full `name`, `call_id` and `arguments` for every function call in the response. So we send one `response.create` after all the outputs, and never while a response is still active.

## What it is

A single-screen Vite + React + TypeScript app on **:5173**. It is the split view from PLAN.md "Demo (the centerpiece)":

- **Top bar:** the Troska brand and an elder status card. The card shows name, age and conditions. It has an ok / watch / urgent pill with `statusReason`, the meds with Taken / Missed badges, and a countdown to `nextCheckInAt`. A connection dot reads Live, Polling, Server offline or Mock data.
- **Left, the call panel:** four states.
  - Idle: a **Start check-in** button.
  - Ringing: when the actor broadcasts `call_due` or `callState` is `"due"`, it shows "Incoming check-in call for Grandpa Joe" and an **Answer** button. The click is the user gesture the browser needs for the mic and audio.
  - Connecting.
  - In a call: a live "What Troska heard" list (meds, symptoms, refills, teach-back, summary), a mic level meter and **Hang up**. No transcript is shown on screen (summaries only, a product decision); the voice transcript reducer still runs in `voice.ts`.
- **Right, the Care Feed:** three lanes for Doctor, Pharmacy and Family. They hold `agent_msg` events grouped by `data.lane`, newest on top, and new cards animate in. Under the lanes, the **Agent thread** lists every `agent_msg` in order, as from → to. Above the lanes, the `med`, `symptom`, `teach_back`, `vitals` and `status` events show as color-coded chips.
- **Demo controls** (top right, collapsible): Reset demo, Check-in in 15 s, Simulate vitals spike, Run scripted demo.

## Run it

```bash
cd web
bun install
cp .env.example .env      # optional: only needed if server/ is not on http://localhost:8787
bun run dev               # http://localhost:5173
```

- `http://localhost:5173/?mock=1` renders a fixture elder and replays a sample storyline through the same reducer. It needs no server and no mic.
- `bun test`: tests for the state reducer, lane grouping, badges, countdown, the voice transcript reducer, function-call parsing, the `session.update` payload and the scripted storyline.
- `bun run build`: `tsc --noEmit && vite build`.

The port is fixed at 5173 (`strictPort`) because server/ only allows CORS from `http://localhost:5173` and `http://127.0.0.1:5173`.

## Env

| Var | Default | Notes |
|---|---|---|
| `VITE_SERVER_URL` | `http://localhost:8787` | server/ base URL. The browser never sees an OpenAI key, only the ephemeral one from `/api/realtime-token`. |

## How it connects

**Live state.** The page calls `GET {VITE_SERVER_URL}/api/actor-ws?elderId=grandpa-joe` to get `{ websocketUrl }` and opens that Terse actor socket. The wire format below was checked against `durable-actors` `src/sockets/mod.rs` and the TypeScript SDK docs:

- `{ type: "state", state, version }`: all emitted fields, sent when the socket connects. It replaces the local state.
- `{ type: "state_update", changes, removed, version }`: merged into the local state. A removed field goes back to its default.
- `{ type: "call_due" }`: the actor's broadcast, which makes the call panel ring.

All three go through one pure reducer (`src/state.ts`). Each reconnect asks for a new grant, with backoff of 1, 2, 4, 8 and then 10 s. While the socket is down, the page polls `GET /api/state` every 2 s, and the dot shows **Polling**. If server/ runs a fake actor, `/api/actor-ws` returns 503 and the page simply stays on polling.

**Voice: OpenAI Realtime GA over WebRTC.** Checked against developers.openai.com `voice-webrtc` and the realtime client and server event references.

1. `GET /api/realtime-token` returns `{ value, model }`. A 503 shows the banner **"Voice offline — use Run scripted demo"**.
2. The page creates an `RTCPeerConnection` with the mic track, a remote `<audio>` and the data channel `oai-events`. It POSTs the SDP offer to `https://api.openai.com/v1/realtime/calls` with `Authorization: Bearer <ephemeral>` and `Content-Type: application/sdp`, then sets the answer. The ephemeral session already fixes the model, so the URL has no `?model=`.
3. When the channel opens, the page sends `session.update` with `type: "realtime"` and three things:
   - instructions built from the live actor state: profile, meds, status, teach-back target, refills, the 911 rule and the closing summary
   - the 5 PLAN.md tools as JSON-schema function tools
   - `audio.input.transcription`
   Then it sends `response.create`, so the agent speaks first.
4. On `response.done`, each `function_call` goes to `POST /api/tool { elderId, name, args }`. The page sends `conversation.item.create { type: "function_call_output", call_id, output }` for each call, then one `response.create`.
5. Transcripts:
   - Joe's turn starts as a placeholder on `input_audio_buffer.speech_started`. Then `conversation.item.input_audio_transcription.delta` and `.completed` fill it in.
   - Troska's turn comes from `response.output_audio_transcript.delta` and `.done`.
6. After `end_call`, the page hangs up when the goodbye audio finishes (`output_audio_buffer.stopped`), or after 12 s at most.
7. The page calls `POST /api/call/start` once the connection is up.

**Demo buttons** call `POST /api/demo/reset`, `/api/demo/schedule {inSeconds: 15}` and `/api/demo/vitals {heartRate: 128}`. Every body includes `elderId: "grandpa-joe"`.

## Demo runbook

1. Press **Reset demo**. Joe shows OK, with his three meds from `supabase/seed.json`.
2. Press **Check-in in 15 s**. The countdown runs, the actor alarm fires and the panel rings.
3. Press **Answer** for the live voice call. If voice is offline, use **Run scripted demo** instead.
4. While Joe talks, the tool rows appear, his badges flip (Amlodipine Missed, Metformin Taken) and the care team's messages fill the lanes and the thread.
5. The status pill turns WATCH, and the recheck countdown appears when the care team schedules it.
6. Kill and restart the actor. The dot goes Polling or Server offline, then back to Live with the same state.

## What is mocked

- **Run scripted demo** is the no-LLM safety net (`src/script.ts`). The transcript lines are canned, typed out word by word, and follow the PLAN.md storyline: dizzy, out of the blood-pressure pill, a refill, the metformin teach-back mixed up and corrected, a summary. The **tool calls are real** `POST /api/tool` requests, so the actor, care-team and Care Feed react for real. Med names come from the live state. It never touches `/api/realtime-token`.
- **`?mock=1`** (`src/mock.ts`) uses fictional data that mirrors the seed. In this mode POSTs do nothing and voice reports offline.

## Known gaps

- **The live voice path has not been run end to end**, because this environment has no `OPENAI_API_KEY`. The endpoint, headers and event names were checked against the current docs. Everything else was run in headless Chrome: `?mock=1`, a contract double of server/, and the real server/ with `TERSE_FAKE=1`.
- **The scripted demo has no speech audio** (no TTS); only the transcript is shown.
- **Reloading the page during a call loses the local transcript.** The actor state survives, and the call panel shows "A check-in call is in progress".
- **Pressing Reset demo during a call does not hang up** the local call.
- **No React Fast Refresh** (no `@vitejs/plugin-react`), so code edits reload the page.

## Files

| File | What |
|---|---|
| `src/main.tsx` | Layout, top bar status card, demo controls |
| `src/CallPanel.tsx` | Call states and the `useCall` hook (voice / scripted / hang up) |
| `src/CareFeed.tsx` | Signal chips, the three lanes, the agent thread |
| `src/state.ts` | Contract types, socket reducer, lanes, badges, countdown (pure) |
| `src/live.ts` | Actor socket, reconnect with backoff, polling fallback, mock feed |
| `src/voice.ts` | Realtime tools, instructions, transcript reducer, WebRTC session, mic meter |
| `src/script.ts` | Scripted demo storyline and runner |
| `src/mock.ts` | `?mock=1` fixture and sample timeline |
| `src/api.ts` | `VITE_SERVER_URL`, `getJSON`, `post` |
