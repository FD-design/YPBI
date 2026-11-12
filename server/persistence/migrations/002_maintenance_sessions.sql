create table bi_auth_maintenance_sessions (
  token_hash char(64) primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  ordinary_session_id uuid not null references bi_auth_sessions(session_id) on delete cascade,
  bound_ip inet not null check (masklen(bound_ip) = case family(bound_ip) when 4 then 32 else 128 end),
  security_fingerprint char(64) not null check (security_fingerprint ~ '^[0-9a-f]{64}$'),
  key_tag char(64) not null check (key_tag ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  check (expires_at > created_at)
);

create index bi_auth_maintenance_sessions_ordinary_idx on bi_auth_maintenance_sessions(ordinary_session_id);
create index bi_auth_maintenance_sessions_expires_at_idx on bi_auth_maintenance_sessions(expires_at);
