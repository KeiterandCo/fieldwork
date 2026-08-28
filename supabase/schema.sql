-- Fieldwork database schema
--
-- Run this once against a fresh Supabase project (SQL Editor → paste → run, or
-- `supabase db push` / `psql`). It creates every table the app and the edge
-- functions read and write. Idempotent-ish: safe on a fresh project; re-running
-- on an existing one will error on the enum types (drop them first if resetting).
--
-- Security model (single-user by design):
-- RLS is enabled on every table with one policy — any *authenticated* user gets
-- full access. The app signs in via Supabase magic-link email auth. After the
-- owner has signed in once, disable new signups in Authentication → Providers
-- (or restrict allowed emails) so the instance stays single-user.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type fw_status as enum (
  'to_apply', 'applied', 'phone_screen', 'interviewing', 'final_round',
  'offer', 'accepted', 'rejected', 'withdrawn', 'ghosted', 'passed'
);

create type fw_verdict as enum ('yes', 'soft_yes', 'soft_no', 'no');

create type fw_event_type as enum (
  'applied', 'screen', 'round', 'debrief', 'rejection', 'nudge',
  'thank_you', 'note', 'status_change', 'offer'
);

create type fw_draft_type as enum (
  'hello', 'nudge', 'thank_you', 'stay_in_touch', 'cover_letter',
  'application_question'
);

create type fw_draft_status as enum ('draft', 'sent');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- The owner's career record and job-search rules. Exactly one row in practice;
-- created by the onboarding wizard (or an import). No personal facts live in
-- code — everything the AI actions use comes from this row.
create table fw_profile (
  id                   uuid primary key default gen_random_uuid(),
  career_record        text,
  locked_summary       text,
  hooks                jsonb not null default '{}'::jsonb,
  comp_floor           integer,
  target_band_strategy text,
  remote_prefs         text,
  target_titles        text[] not null default '{}',
  avoid_titles         text[] not null default '{}',
  do_not_claim         text[] not null default '{}',
  never_mention        text[] not null default '{}',
  file_name_pattern    text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Key → jsonb settings map (timing rules, theme, whimsy level, model map,
-- board preferences).
create table fw_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- One row per role in the pipeline.
create table fw_applications (
  id              uuid primary key default gen_random_uuid(),
  company         text not null,
  title           text,
  status          fw_status not null default 'to_apply',
  date_applied    date,
  verdict         fw_verdict,
  comp_posted     text,
  comp_min        integer,
  comp_max        integer,
  remote_type     text,
  source          text,
  next_action     text,
  next_action_due date,
  resume_filename text,
  resume_content  jsonb,
  cover_letter    boolean not null default false,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Stored job descriptions, one per application (nullable link so a JD can be
-- kept before it's filed).
create table fw_jds (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid references fw_applications(id) on delete cascade,
  url             text,
  raw_text        text,
  pain_line       text,
  gaps            jsonb not null default '[]'::jsonb,
  live_checked_at timestamptz,
  source          text,
  created_at      timestamptz not null default now()
);

-- Recruiters and humans met along the way. application_id nullable — standing
-- contacts exist independent of any one role.
create table fw_contacts (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  company        text,
  role_title     text,
  context        text,
  email          text,
  phone          text,
  linkedin       text,
  application_id uuid references fw_applications(id) on delete set null,
  last_touch     date,
  next_action    text,
  warmth         text not null default 'cold',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- The per-application timeline.
create table fw_events (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references fw_applications(id) on delete cascade,
  type           fw_event_type not null,
  occurred_at    date not null default current_date,
  body           text,
  created_at     timestamptz not null default now()
);

-- The lessons-learned log: what a rejection actually taught.
create table fw_lessons (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid references fw_applications(id) on delete set null,
  date           date,
  company        text,
  role           text,
  stage_reached  text,
  stated_reason  text,
  real_signal    text,
  adjustment     text,
  created_at     timestamptz not null default now()
);

-- Outbound drafts (nudges, thank-yous, cover letters …). The app never sends
-- anything — drafts end at Copy / Mark sent.
create table fw_drafts (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid references fw_applications(id) on delete cascade,
  contact_id     uuid references fw_contacts(id) on delete cascade,
  type           fw_draft_type not null,
  body           text not null,
  status         fw_draft_status not null default 'draft',
  sent_at        timestamptz,
  created_at     timestamptz not null default now()
);

-- Generated interview-prep documents and their debriefs.
create table fw_prep_docs (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references fw_applications(id) on delete cascade,
  round_type     text,
  content        text,
  debriefs       jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table fw_profile      enable row level security;
alter table fw_settings     enable row level security;
alter table fw_applications enable row level security;
alter table fw_jds          enable row level security;
alter table fw_contacts     enable row level security;
alter table fw_events       enable row level security;
alter table fw_lessons      enable row level security;
alter table fw_drafts       enable row level security;
alter table fw_prep_docs    enable row level security;

create policy fw_auth_all on fw_profile      for all to authenticated using (true) with check (true);
create policy fw_auth_all on fw_settings     for all to authenticated using (true) with check (true);
create policy fw_auth_all on fw_applications for all to authenticated using (true) with check (true);
create policy fw_auth_all on fw_jds          for all to authenticated using (true) with check (true);
create policy fw_auth_all on fw_contacts     for all to authenticated using (true) with check (true);
create policy fw_auth_all on fw_events       for all to authenticated using (true) with check (true);
create policy fw_auth_all on fw_lessons      for all to authenticated using (true) with check (true);
create policy fw_auth_all on fw_drafts       for all to authenticated using (true) with check (true);
create policy fw_auth_all on fw_prep_docs    for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Seed settings (the app expects these keys to exist)
-- ---------------------------------------------------------------------------

insert into fw_settings (key, value) values
  ('timing', '{"nudge_days_min": 5, "nudge_days_max": 7, "ghost_weeks": 3, "thankyou_hours": 24}'),
  ('theme',  '"dark"'),
  ('whimsy', '"gentle"'),
  ('models', '{"default": "claude-sonnet-5", "scorecard": "claude-sonnet-5", "drafts": "claude-sonnet-5"}')
on conflict (key) do nothing;
