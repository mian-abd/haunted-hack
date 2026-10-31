-- Caller profiles: each elder's own phone number (E.164, e.g. +15551234567), so a call in either direction finds that
-- person's record and history. A caller we have not met gets a new row (id caller-<digits>, name "New caller") and the
-- voice agent fills it in during the call. Safe to re-run.
alter table public.patients add column if not exists phone text;
create unique index if not exists patients_phone_key on public.patients (phone) where phone is not null;
