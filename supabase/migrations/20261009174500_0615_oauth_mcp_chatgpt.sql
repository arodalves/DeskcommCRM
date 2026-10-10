-- manifest: Servidor de Autorização OAuth 2.1 para integração MCP com ChatGPT (RFC 8414, RFC 7591, RFC 9728, PKCE S256).
-- 20261009174500_0615_oauth_mcp_chatgpt.sql
-- Servidor de Autorização OAuth 2.1 para integração MCP com ChatGPT.
-- Implementa RFC 8414 (Metadata), RFC 7591 (DCR), RFC 9728 (Protected Resource) e PKCE S256.

-- 1. Clientes OAuth (DCR ou pré-registrados)
create table if not exists public.oauth_clients (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  client_secret text,
  client_name text not null,
  redirect_uris text[] not null,
  grant_types text[] not null default array['authorization_code', 'refresh_token'],
  response_types text[] not null default array['code'],
  token_endpoint_auth_method text not null default 'none',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. Códigos de autorização temporários (PKCE S256, expiração em 5 minutos)
create table if not exists public.oauth_authorization_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  client_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  code_challenge_method text not null default 'S256',
  scopes text[] not null default array['mcp:read'],
  resource text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_oauth_auth_codes_expires_at
  on public.oauth_authorization_codes (expires_at);

-- 3. Refresh tokens OAuth com suporte a rotação
create table if not exists public.oauth_refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  api_token_id uuid not null references public.api_tokens(id) on delete cascade,
  client_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  scopes text[] not null default array['mcp:read'],
  expires_at timestamptz not null,
  revoked_at timestamptz,
  rotated_to_id uuid references public.oauth_refresh_tokens(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_oauth_refresh_tokens_api_token
  on public.oauth_refresh_tokens (api_token_id);

-- 4. RLS e permissões: restrito ao service_role do servidor
alter table public.oauth_clients enable row level security;
alter table public.oauth_authorization_codes enable row level security;
alter table public.oauth_refresh_tokens enable row level security;

revoke all on public.oauth_clients from public, anon, authenticated;
revoke all on public.oauth_authorization_codes from public, anon, authenticated;
revoke all on public.oauth_refresh_tokens from public, anon, authenticated;

grant select, insert, update, delete on public.oauth_clients to service_role;
grant select, insert, update, delete on public.oauth_authorization_codes to service_role;
grant select, insert, update, delete on public.oauth_refresh_tokens to service_role;
