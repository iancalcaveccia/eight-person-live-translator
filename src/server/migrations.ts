/**
 * Ordered, append-only SQL migrations. Embedded as strings so they ship with
 * the serverless bundle without filesystem reads. Never edit a migration that
 * has been deployed; add a new one.
 */
export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "001_init",
    sql: `
create table if not exists app_settings (
  key text primary key,
  value text not null,
  created_at timestamptz not null default now()
);

create table if not exists gatherings (
  id uuid primary key,
  title text not null,
  invite_version int not null default 1,
  host_participant_id uuid,
  max_humans int not null default 8,
  budget_usd double precision not null,
  spent_usd double precision not null default 0,
  default_provider text not null default 'gemini',
  version int not null default 1,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  ended_reason text,
  last_activity_at timestamptz not null default now()
);

create table if not exists participants (
  id uuid primary key,
  gathering_id uuid not null references gatherings(id) on delete cascade,
  display_name text not null,
  speak_lang text not null check (speak_lang in ('en','pl','es','auto')),
  listen_lang text not null check (listen_lang in ('en','pl','es')),
  es_region text not null default '' check (es_region in ('','es-AR','es-CO','es-ES')),
  role text not null default 'guest' check (role in ('host','guest')),
  color int not null,
  session_hash text not null unique,
  consent_version text not null,
  consent_at timestamptz not null,
  active_group_id uuid,
  active_epoch int not null default 1,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  left_at timestamptz,
  kicked_at timestamptz
);
create index if not exists participants_gathering_idx on participants(gathering_id);

create table if not exists groups (
  id uuid primary key,
  gathering_id uuid not null references gatherings(id) on delete cascade,
  kind text not null check (kind in ('main','private')),
  name text not null,
  livekit_room text not null unique,
  created_by uuid,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists groups_gathering_idx on groups(gathering_id);

create table if not exists group_members (
  group_id uuid not null references groups(id) on delete cascade,
  participant_id uuid not null references participants(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  added_at timestamptz not null default now(),
  primary key (group_id, participant_id)
);
create index if not exists group_members_participant_idx on group_members(participant_id);

create table if not exists invitations (
  id uuid primary key,
  gathering_id uuid not null references gatherings(id) on delete cascade,
  group_id uuid not null references groups(id) on delete cascade,
  from_participant_id uuid not null references participants(id) on delete cascade,
  to_participant_id uuid not null references participants(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','declined','revoked')),
  created_at timestamptz not null default now(),
  responded_at timestamptz
);
create unique index if not exists invitations_one_pending_idx
  on invitations(group_id, to_participant_id) where status = 'pending';

-- Usage survives gathering deletion on purpose: it holds no names or content,
-- only random ids, durations and cost estimates for the spending meters.
create table if not exists usage_records (
  id bigserial primary key,
  gathering_id uuid,
  group_id uuid,
  speaker_id uuid,
  target_lang text not null,
  provider text not null,
  input_seconds double precision not null default 0,
  output_seconds double precision not null default 0,
  session_seconds double precision not null default 0,
  cost_usd double precision not null default 0,
  errors int not null default 0,
  first_audio_ms int[] not null default '{}',
  period_start timestamptz,
  period_end timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists usage_created_idx on usage_records(created_at);
create index if not exists usage_gathering_idx on usage_records(gathering_id);

-- Security/audit trail without conversation content.
create table if not exists audit_events (
  id bigserial primary key,
  gathering_id uuid,
  kind text not null,
  actor_id uuid,
  subject_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_gathering_idx on audit_events(gathering_id, created_at);

create table if not exists rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  count int not null,
  primary key (bucket, window_start)
);
`,
  },
  {
    id: "002_people_tables",
    sql: `
-- Remembered people ("keep me signed in on this phone"): a name, languages and
-- the AI-consent version. No email, no password, no phone number. A device
-- holds a random secret; only its SHA-256 is stored here.
create table if not exists people (
  id uuid primary key,
  display_name text not null,
  speak_lang text not null check (speak_lang in ('en','pl','es','auto')),
  listen_lang text not null check (listen_lang in ('en','pl','es')),
  es_region text not null default '' check (es_region in ('','es-AR','es-CO','es-ES')),
  consent_version text not null,
  consent_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists person_devices (
  id uuid primary key,
  person_id uuid not null references people(id) on delete cascade,
  session_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists person_devices_person_idx on person_devices(person_id);

-- Saved tables ("circles"): the people who talk together regularly. A table
-- outlives its gatherings; each time someone taps it, the live gathering is
-- reused or a fresh one is started.
create table if not exists circles (
  id uuid primary key,
  name text not null,
  invite_version int not null default 1,
  created_by uuid,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create table if not exists circle_members (
  circle_id uuid not null references circles(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  added_at timestamptz not null default now(),
  primary key (circle_id, person_id)
);
create index if not exists circle_members_person_idx on circle_members(person_id);

alter table gatherings add column if not exists circle_id uuid references circles(id) on delete set null;
create index if not exists gatherings_circle_idx on gatherings(circle_id);
alter table participants add column if not exists person_id uuid references people(id) on delete set null;
create index if not exists participants_person_idx on participants(person_id);
`,
  },
  {
    id: "003_worker_events",
    sql: `
-- Content-free interpreter diagnostics (no names, no words, no audio): which
-- streams opened and closed, per-minute delay and language-label counts,
-- reconnections, overheard-mic holds. Kept 30 days so long sessions can be
-- reviewed and tuned after the worker has been redeployed. "room" is the
-- random media-room name, kept so a session stays groupable after its
-- gathering (and its ids) are deleted.
create table if not exists worker_events (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  room text,
  gathering_id uuid,
  group_id uuid,
  kind text not null,
  speaker_id uuid,
  target_lang text,
  data jsonb not null default '{}'::jsonb
);
create index if not exists worker_events_created_idx on worker_events(created_at);
create index if not exists worker_events_room_idx on worker_events(room, created_at);
`,
  },
];
