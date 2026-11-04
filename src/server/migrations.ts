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
];
