# supabase/

The Postgres schema, the fictional demo seed data and the setup steps for Unc's Supabase project. It holds hospital records (patients, prescriptions, clinical notes), the call archive and the care team history, with RLS per family.

Nothing in this folder connects to the remote project. Only the team's Supabase owner applies these files, by hand.

## Contract deviations

None. The 5 PLAN.md tables are as specified, and `seed.json` has exactly the PLAN.md shape.

Additions (not deviations):
- A `family_members` table (user ↔ patient). The RLS policies need it.
- `calls` has no `created_at`. A call row is written when the call ends, so `ended_at` defaults to `now()`, and the index is `(patient_id, ended_at desc)`.
- Explicit grants in the migration. Supabase is moving projects off automatic grants for new tables, and without grants the services' writes fail with `permission denied`. Because anon has no grants, a request with no auth gets `permission denied` (42501) instead of an empty list. Either way it reads nothing.

## Files

| File | What it is |
|---|---|
| `migrations/20261031120000_init.sql` | Tables, indexes and RLS policies. Safe to re-run. |
| `seed.sql` | Demo data: 3 patients, 7 prescriptions, 7 clinical notes. Safe to re-run. |
| `seed.json` | The same data as `seed.sql`. Services read it when `SUPABASE_URL` is unset. Demo source of truth. |
| `check-seed.ts` | Checks `seed.json` against the PLAN.md shape and that every row is also in `seed.sql`. |
| `.env.example` | The two env vars the services need. |

## Tables

| Table | What it is for |
|---|---|
| `patients` | One row per elder. `id` is the ElderActor key (`grandpa-joe`). Conditions, family contact, primary doctor. |
| `prescriptions` | Current meds: `dose`, `times` (`'HH:MM'`), `purpose`, `prescriber`, `refills_left`. |
| `clinical_notes` | Doctor and nurse notes that the doctor agent reads when it triages. |
| `calls` | Call archive: `started_at`, `ended_at`, `summary`, `mood`, `transcript` (jsonb). |
| `care_events` | Care team history. The columns `kind`, `from_agent`, `to_agent`, `text`, `data` mirror an ElderActor `TimelineEvent` (`kind`, `from`, `to`, `text`, `data`). |
| `family_members` | Links a Supabase Auth user (`auth.users`) to a patient, with a `role`. Every RLS policy checks it. |

Access, for every table:
- **anon**: no grants, so no access.
- **authenticated**: SELECT only. RLS then shows a patient's rows only when a `family_members` row links the user to that patient. Users can read their own `family_members` rows. There are no write policies.
- **service_role**: SELECT, INSERT, UPDATE, DELETE, and it bypasses RLS. The services use it, server-side only.

The seed supports the demo storyline for `grandpa-joe`:
- Amlodipine has `refills_left: 0` ("ran out of my blood-pressure pills"), and a note says a renewal is approved for a same-day fill (pharmacy lane: "refill ready").
- A note says "do not double up", and a red-flag note says dizziness without red flags means "rest, fluids, recheck within 2 hours" (status `watch` and a recheck).
- A teach-back note says he confuses morning and evening metformin.
- A hearing-loss note tells the voice agent to speak slowly.

## Apply to the remote project (Supabase owner only)

Both files are safe to re-run. Pick one way:

**A. SQL editor (simplest).** Dashboard → SQL Editor. Paste each file and run it, in this order:
1. `supabase/migrations/20261031120000_init.sql`
2. `supabase/seed.sql`

**C. `apply.ts`** (no Supabase CLI needed; this is how the team project was set up on Oct 31). It runs both files over a
Postgres connection string from the dashboard's **Connect** button. The direct host `db.<ref>.supabase.co` is IPv6-only,
so on an IPv4 network use the session pooler instead: user `postgres.<ref>`, host `aws-0-<region>.pooler.supabase.com`,
port 5432.

```sh
SUPABASE_DB_URL='postgresql://postgres.<ref>:<db-password>@aws-0-us-east-1.pooler.supabase.com:5432/postgres' bun supabase/apply.ts
```

It prints the row counts when it is done. The connection string holds the database password: type it in the shell,
never commit it.

**B. CLI**, from the repo root:

```sh
supabase init                    # only if supabase/config.toml does not exist; it keeps migrations/ and seed.sql
supabase login
supabase link --project-ref <your-project-ref>
supabase db push --dry-run       # shows what will run
supabase db push --include-seed  # applies the migration, then seed.sql
```

Do not run `supabase db reset --linked`. It wipes the remote database.

What a re-run does:
- The migration creates only what is missing and recreates the policies.
- `create table if not exists` does not change a table that already exists. To change a column later, add a new migration file.
- The seed upserts the 3 demo patients and replaces their prescriptions and clinical notes, so a re-run also resets demo values (for example Amlodipine refills back to 0). It never touches `calls`, `care_events` or `family_members`.

No family links are seeded, because they need real `auth.users` ids. To demo RLS, create a user in Authentication → Users, then run:

```sql
insert into public.family_members (user_id, patient_id, role) values ('<auth user id>', 'grandpa-joe', 'daughter');
```

## Env vars

`server/` and `care-team/` need these, server-side only:

| Var | Value |
|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | The legacy `service_role` key or the new `sb_secret_...` key. Either works. Supabase says legacy keys stop working at the end of 2026. |

The service role key bypasses RLS. Never put it in `web/`, in a `VITE_` variable, or in git. With `SUPABASE_URL` unset, the services read `supabase/seed.json` instead.

## How it connects to the other services

- **`server/` `POST /api/demo/reset`** reads the patient and their prescriptions (from Supabase, or from `seed.json`) and calls `ElderActor.setup(profile, meds)`. The mapping:
  - Patient row → `profile`: `{ name, age, conditions, family: { name: family_name, relation: family_relation, phone: family_phone } }`.
  - Each prescription row → a `Med`: `{ name, dose, times, purpose, lastTakenAt: null, missedCount: 0 }`.
- **`server/` `end_call`** inserts a row into `calls`. If it leaves out `ended_at`, the DB sets it to `now()`.
- **`care-team/`**: the doctor agent reads `patients`, `prescriptions` and `clinical_notes` for triage. The pharmacy agent reads `refills_left`. The services may also write relay messages and timeline events to `care_events`.
- **`web/`** does not talk to Supabase in the MVP. The live Care Feed comes from the ElderActor WebSocket.

No SDK is needed. PostgREST over `fetch` works. Send the key in the `apikey` header. Add `Authorization: Bearer <key>` only for a legacy JWT `service_role` key: Supabase rejects `sb_secret_…` keys as a Bearer token. The services do this through `supabaseAuth()`.

```sh
curl "$SUPABASE_URL/rest/v1/prescriptions?patient_id=eq.grandpa-joe&select=name,dose,times,purpose,refills_left" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY"

curl -X POST "$SUPABASE_URL/rest/v1/calls" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"patient_id":"grandpa-joe","started_at":"2026-10-31T19:00:00Z","summary":"Dizzy, out of amlodipine","mood":"tired","transcript":[]}'
```

## Run the checks

```sh
bun supabase/check-seed.ts   # from the repo root; no dependencies, no network
```

It checks:
- `seed.json` has exactly the PLAN.md keys and types.
- Every `seed.json` row is in `seed.sql` with all of its values.
- `grandpa-joe` exists.
- Every `patient_id` points to a real patient.
- Every phone number is a fictional `+1-555-01xx`.

To try the full stack locally (needs Docker running), run from the repo root: `supabase init` (only if there is no `supabase/config.toml`), `supabase start` (applies the migration and `seed.sql`), and later `supabase stop`.

## What was verified, what is mocked, known gaps

- **Verified (Oct 31):** the SQL ran on a real Postgres engine, PGlite (Postgres 18.6 in WASM), with a stand-in for Supabase auth: the `anon`, `authenticated` and `service_role` roles, an `auth.users` table and Supabase's own `auth.uid()` definition. All checks ran twice, under Supabase's old default (new tables auto-granted) and its new one (no auto-grants), with the same results:
  - The migration and the seed each ran twice with no errors.
  - All DB rows are identical to `seed.json`.
  - anon gets `permission denied` on every table. A signed-in user with no family link sees 0 rows.
  - A family member of `grandpa-joe` sees only his rows. Their insert, update and delete are all denied.
  - The service role can insert and sees everything.
  - Re-seeding keeps calls, care events and family links.
  - Deleting a patient cascades to their rows.
  - The Care Feed query uses `care_events_patient_created_idx`.
  - That script is not in the repo, to keep this folder free of dependencies.
- **Not verified:** a real Supabase stack. The Docker daemon was not running, so `supabase start` was not run. Supabase-only behavior (PostgREST, the real `auth.users` columns) was not run.
- **Mocked:** nothing here calls an LLM, so there is no mock mode. All people, phone numbers and clinical notes are fictional demo data, not medical advice.
- **Gaps:**
  - `check-seed.ts` does not catch extra rows that exist only in `seed.sql`.
  - Family members can only read. All writes go through the services.
  - No Supabase Realtime publication is set up (not needed for the MVP).

## Scale to millions

- **Hot state lives in actors, not the database.** Each elder's live state (meds, status, timeline, next alarm) lives in their own durable ElderActor. Postgres gets a few writes per call (the archive and care events), not every turn of a live conversation.
- **Postgres is the system of record, indexed per elder.** `calls` and `care_events` are append-only. Every per-elder read uses an index on `patient_id` plus time (`created_at desc`, or `ended_at desc` for calls). Reading one elder's history stays an index range scan, however large the table grows.
- **RLS per family.** One SELECT policy per table lets a user see a patient only through `family_members`. `(select auth.uid())` runs once per query, and the `(user_id, patient_id)` primary key makes the check an index lookup. Millions of families share one database without seeing each other's data.
