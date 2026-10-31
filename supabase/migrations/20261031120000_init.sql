-- Troska: hospital records, call archive and care events. See supabase/README.md.
-- Safe to re-run: tables and indexes use "if not exists", and each policy is dropped before it is created.
-- RLS: a signed-in family member (a family_members row for that patient) can SELECT that patient's rows.
-- anon has no grants. There are no write policies. Services write with the service role key, which bypasses RLS.

-- One row per elder. id is the ElderActor key, e.g. 'grandpa-joe'.
create table if not exists public.patients (
  id text primary key,
  name text not null,
  age int,
  conditions text[] not null default '{}',
  family_name text,
  family_relation text,
  family_phone text,
  primary_doctor text,
  created_at timestamptz not null default now()
);

-- Current medications. times are 'HH:MM' strings.
create table if not exists public.prescriptions (
  id uuid primary key default gen_random_uuid(),
  patient_id text not null references public.patients (id) on delete cascade,
  name text not null,
  dose text,
  times text[] not null default '{}',
  purpose text,
  prescriber text,
  refills_left int
);
create index if not exists prescriptions_patient_id_idx on public.prescriptions (patient_id);

-- Doctor and nurse notes. The doctor agent reads them when it triages.
create table if not exists public.clinical_notes (
  id uuid primary key default gen_random_uuid(),
  patient_id text not null references public.patients (id) on delete cascade,
  author text,
  note text not null,
  created_at timestamptz not null default now()
);
create index if not exists clinical_notes_patient_created_idx on public.clinical_notes (patient_id, created_at desc);

-- Call archive. A row is written when a call ends, so ended_at defaults to now() and is the sort key.
create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  patient_id text not null references public.patients (id) on delete cascade,
  started_at timestamptz,
  ended_at timestamptz default now(),
  summary text,
  mood text,
  transcript jsonb
);
create index if not exists calls_patient_ended_idx on public.calls (patient_id, ended_at desc);

-- Care team history: ElderActor timeline events and Agent Relay messages.
create table if not exists public.care_events (
  id uuid primary key default gen_random_uuid(),
  patient_id text not null references public.patients (id) on delete cascade,
  kind text not null,
  from_agent text,
  to_agent text,
  text text,
  data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists care_events_patient_created_idx on public.care_events (patient_id, created_at desc);

-- Which Supabase Auth users may read which patients. Every RLS policy below checks this table.
create table if not exists public.family_members (
  user_id uuid not null references auth.users (id) on delete cascade,
  patient_id text not null references public.patients (id) on delete cascade,
  role text,
  primary key (user_id, patient_id)
);
create index if not exists family_members_patient_id_idx on public.family_members (patient_id);

alter table public.patients enable row level security;
alter table public.prescriptions enable row level security;
alter table public.clinical_notes enable row level security;
alter table public.calls enable row level security;
alter table public.care_events enable row level security;
alter table public.family_members enable row level security;

-- Explicit grants, because Supabase is moving projects off automatic grants for new tables.
-- anon gets nothing. Family members (authenticated) can only read, and RLS limits the rows. The services (service_role) read and write.
revoke all on public.patients, public.prescriptions, public.clinical_notes, public.calls, public.care_events, public.family_members from anon, authenticated;
grant select on public.patients, public.prescriptions, public.clinical_notes, public.calls, public.care_events, public.family_members to authenticated;
grant select, insert, update, delete on public.patients, public.prescriptions, public.clinical_notes, public.calls, public.care_events, public.family_members to service_role;

-- (select auth.uid()) runs once per query, not once per row.
-- This policy must not query family_members itself, or Postgres reports infinite recursion.
drop policy if exists "family reads own links" on public.family_members;
create policy "family reads own links" on public.family_members
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "family reads own patients" on public.patients;
create policy "family reads own patients" on public.patients
  for select to authenticated
  using (id in (select fm.patient_id from public.family_members fm where fm.user_id = (select auth.uid())));

drop policy if exists "family reads own patients" on public.prescriptions;
create policy "family reads own patients" on public.prescriptions
  for select to authenticated
  using (patient_id in (select fm.patient_id from public.family_members fm where fm.user_id = (select auth.uid())));

drop policy if exists "family reads own patients" on public.clinical_notes;
create policy "family reads own patients" on public.clinical_notes
  for select to authenticated
  using (patient_id in (select fm.patient_id from public.family_members fm where fm.user_id = (select auth.uid())));

drop policy if exists "family reads own patients" on public.calls;
create policy "family reads own patients" on public.calls
  for select to authenticated
  using (patient_id in (select fm.patient_id from public.family_members fm where fm.user_id = (select auth.uid())));

drop policy if exists "family reads own patients" on public.care_events;
create policy "family reads own patients" on public.care_events
  for select to authenticated
  using (patient_id in (select fm.patient_id from public.family_members fm where fm.user_id = (select auth.uid())));
