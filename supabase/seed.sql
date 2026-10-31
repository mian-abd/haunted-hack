-- Fictional demo hospital records. Same data as supabase/seed.json (check: bun supabase/check-seed.ts).
-- Run after migrations/20261031120000_init.sql.
-- Safe to re-run: upserts the 3 demo patients and replaces their prescriptions and clinical notes.
-- It never touches calls, care_events or family_members.

insert into public.patients (id, name, age, conditions, family_name, family_relation, family_phone, primary_doctor) values
  ('grandpa-joe', 'Joe Nguyen', 78, array['hypertension', 'type 2 diabetes', 'mild hearing loss'], 'Linh', 'daughter', '+1-555-0100', 'Dr. Patel'),
  ('nana-rosa', 'Rosa Alvarez', 84, array['atrial fibrillation', 'osteoarthritis'], 'Marco', 'son', '+1-555-0101', 'Dr. Okafor'),
  ('uncle-dave', 'Dave Miller', 71, array['COPD', 'high cholesterol'], 'Sam', 'nephew', '+1-555-0102', 'Dr. Patel')
on conflict (id) do update set
  name = excluded.name,
  age = excluded.age,
  conditions = excluded.conditions,
  family_name = excluded.family_name,
  family_relation = excluded.family_relation,
  family_phone = excluded.family_phone,
  primary_doctor = excluded.primary_doctor;

delete from public.prescriptions where patient_id in ('grandpa-joe', 'nana-rosa', 'uncle-dave');
insert into public.prescriptions (patient_id, name, dose, times, purpose, prescriber, refills_left) values
  ('grandpa-joe', 'Amlodipine', '5 mg', array['08:00'], 'blood pressure', 'Dr. Patel', 0),
  ('grandpa-joe', 'Metformin', '500 mg', array['08:00', '19:00'], 'blood sugar, take with meals', 'Dr. Patel', 2),
  ('grandpa-joe', 'Atorvastatin', '20 mg', array['21:00'], 'cholesterol', 'Dr. Patel', 3),
  ('nana-rosa', 'Apixaban', '5 mg', array['08:00', '20:00'], 'blood thinner for atrial fibrillation', 'Dr. Okafor', 4),
  ('nana-rosa', 'Acetaminophen', '500 mg', array['08:00', '14:00'], 'joint pain', 'Dr. Okafor', 1),
  ('uncle-dave', 'Tiotropium inhaler', '2 puffs', array['09:00'], 'COPD maintenance', 'Dr. Patel', 2),
  ('uncle-dave', 'Atorvastatin', '40 mg', array['21:00'], 'cholesterol', 'Dr. Patel', 5);

delete from public.clinical_notes where patient_id in ('grandpa-joe', 'nana-rosa', 'uncle-dave');
insert into public.clinical_notes (patient_id, author, note, created_at) values
  ('grandpa-joe', 'Dr. Patel', 'BP 150/92 at last visit. Dizziness possible if amlodipine is missed or doubled — do not double up on a missed dose.', '2026-10-03T16:20:00Z'),
  ('grandpa-joe', 'Dr. Patel', 'Amlodipine has 0 refills left. 90-day renewal approved; pharmacy can fill it the same day.', '2026-10-03T16:25:00Z'),
  ('grandpa-joe', 'Dr. Patel', 'Escalate to the on-call clinician right away for chest pain, fainting, slurred speech or BP above 180/110. Dizziness with none of these: rest, fluids, recheck within 2 hours.', '2026-10-03T16:30:00Z'),
  ('grandpa-joe', 'Nurse Kim', 'Teach-back: patient sometimes confuses morning/evening metformin. Correct plan: 500 mg with breakfast (08:00) and 500 mg with dinner (19:00).', '2026-10-17T14:05:00Z'),
  ('grandpa-joe', 'Nurse Kim', 'Mild hearing loss: speak slowly, ask one question at a time, and have him repeat key instructions back.', '2026-10-17T14:10:00Z'),
  ('nana-rosa', 'Dr. Okafor', 'Fall risk: uses a walker. On apixaban, so ask about falls, dizziness and unusual bruising on every call.', '2026-09-28T15:00:00Z'),
  ('uncle-dave', 'Dr. Patel', 'COPD stable on tiotropium. Ask about shortness of breath and cough; escalate if breathing is worse than usual.', '2026-10-10T17:45:00Z');
