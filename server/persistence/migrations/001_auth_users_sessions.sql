create table bi_auth_users (
  user_id uuid primary key,
  username varchar(64) not null,
  normalized_username varchar(64) not null unique,
  display_name varchar(128),
  role varchar(32) not null check (role in ('reader', 'analyst', 'maintainer')),
  password_hash text not null,
  credential_version integer not null default 1 check (credential_version > 0),
  must_change_password boolean not null default true,
  status varchar(16) not null default 'active' check (status in ('active', 'disabled')),
  failed_login_count smallint not null default 0 check (failed_login_count >= 0),
  failed_login_window_started_at timestamptz,
  locked_until timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (normalized_username = lower(normalized_username))
);

create table bi_auth_sessions (
  session_id uuid primary key,
  user_id uuid not null references bi_auth_users(user_id) on delete cascade,
  token_hash char(64) not null unique,
  credential_version integer not null check (credential_version > 0),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > created_at)
);

create index bi_auth_sessions_user_id_idx on bi_auth_sessions(user_id);
create index bi_auth_sessions_expires_at_idx on bi_auth_sessions(expires_at);
