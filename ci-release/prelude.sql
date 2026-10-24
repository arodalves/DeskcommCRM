
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

-- O DEFAULT ACL QUE TODO PROJETO SUPABASE JÁ TEM ANTES DE QUALQUER SQL NOSSO.
--
-- Sem estas 4 linhas o Postgres efêmero NÃO é o banco do produto, e a diferença
-- não é cosmética: ela apaga uma classe inteira de defeito do campo de visão do
-- job `invariants`.
--
-- O `pg_dump` do baseline emite, na linha ~3960, o `ALTER DEFAULT PRIVILEGES ...
-- GRANT ALL ON FUNCTIONS TO anon` — mas ele só o emite PORQUE a entrada já
-- existia no projeto de origem. Num Supabase de verdade (nuvem, que é o que o
-- `hostgator-setup-kit/install.sh` manda o cliente usar, ou a CLI local) essa
-- entrada em `pg_default_acl` é gravada pelo bootstrap do Supabase, ANTES de
-- `install.sh`/`update.sh` rodarem. Consequência: toda função que o baseline cria
-- — inclusive as ~27 do CORPO do dump — nasce com EXECUTE para anon.
--
-- Num Postgres cru, ao contrário, a entrada só passa a existir NA linha 3960 — e
-- as funções do corpo, criadas antes dela, nascem limpas. Medido em 2026-08-08,
-- pg17 descartável, baseline @9249e6f2 aplicado com e sem este bloco:
--
--     sem  -> 0 de 27 SECURITY DEFINER de public executáveis por anon
--     com  -> 6 de 27  (activate_kb_version, fn_decrypt_oauth, fn_encrypt_oauth,
--                       fn_lgpd_cascade_redact_contact, fn_update_budget_consumption,
--                       retrieve_top_k_chunks)
--
-- As mesmas 6, exatamente, que `select ... has_function_privilege('anon', ...)`
-- devolve no `supabase_db_deskcomm-crm` desta máquina hoje. Ou seja: o gate estava
-- verde medindo um universo onde o defeito não pode existir.
--
-- `revoke execute ... from public` no default também é fiel ao produto: no
-- Supabase real o `proacl` das definer de public NÃO tem `=X` (grant a PUBLIC),
-- então lá a exposição vem do grant DIRETO a anon — o caminho que
-- `revoke from public` sozinho não fecha.
alter default privileges for role postgres in schema public grant all on functions to anon;
alter default privileges for role postgres in schema public grant all on functions to authenticated;
alter default privileges for role postgres in schema public grant all on functions to service_role;
alter default privileges for role postgres in schema public revoke execute on functions from public;

-- O MESMO DEFAULT ACL, PARA TABELAS (issue #887).
--
-- O bloco acima cobria só funções, e o gate ficava cego para privilégio das
-- tabelas do CORPO do dump. Num Supabase de verdade toda tabela criada em
-- `public` nasce com privilégio total para anon, authenticated e service_role, e
-- o `GRANT` que o dump enumera depois só ACRESCENTA — não revoga nada. Aqui, sem
-- estas linhas, a tabela do corpo nascia só com o que o dump concede, e um
-- invariante do tipo "o papel X não tem o privilégio Y na tabela Z" sobre ela
-- ficava verde por construção. As tabelas do apêndice nunca tiveram o problema:
-- nascem depois do `ALTER DEFAULT PRIVILEGES … ON TABLES` que o próprio dump grava.
-- Foi assim que o `service_role` seguia apagando e reescrevendo linhas de
-- `api_audit_log` com este gate verde, até a migration 0258.
--
-- Medido em 2026-09-17 no `pg_default_acl` de um Supabase local
-- (supabase/postgres:17.6.1.106):
--
--     postgres | public | TABLES | {postgres=arwdDxtm,anon=arwdDxtm,
--                                   authenticated=arwdDxtm,service_role=arwdDxtm}
--
-- `grant all` reproduz as duas majors: o `m` (MAINTAIN) só existe no pg17.
--
-- `scripts/test-update-com-dados.sh` extrai este bloco inteiro, então as linhas
-- abaixo valem para os dois scripts.
alter default privileges for role postgres in schema public grant all on tables to anon;
alter default privileges for role postgres in schema public grant all on tables to authenticated;
alter default privileges for role postgres in schema public grant all on tables to service_role;

create schema if not exists auth;
create schema if not exists extensions;

-- O baseline referencia extensions.uuid_generate_v4/gen_random_bytes e os tipos
-- public.vector/public.citext + gin_trgm_ops, mas não cria as extensões (pg_dump).
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema public;
create extension if not exists citext with schema public;
create extension if not exists pg_trgm with schema public;

-- Stubs de storage (o apêndice do baseline cria buckets + policies em storage.objects).
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);

-- Stub de auth.users (FKs do baseline apontam pra cá).
--
-- `raw_user_meta_data` entrou com a migration 0202 (fn_conversation_assign
-- passou a ler `raw_user_meta_data->>'full_name'` dentro da definer) — é o
-- nome real da coluna no GoTrue, não um apelido do stub.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Contrato Supabase usado pelo suporte: sessão é do Auth, nunca do produto.
create table if not exists auth.sessions (
 id uuid primary key, user_id uuid not null references auth.users(id),
 aal text, not_after timestamptz
);
create table if not exists auth.mfa_factors (
 id uuid primary key, user_id uuid not null references auth.users(id), status text, factor_type text default 'totp'
);
create or replace function auth.jwt() returns jsonb language sql stable as $$
 select coalesce(nullif(current_setting('request.jwt.claim',true),''),nullif(current_setting('request.jwt.claims',true),''))::jsonb;
$$;

-- Stub de auth.uid() lendo o claim `sub` de request.jwt.claims (mesmo contrato
-- do Supabase; os testes simulam o JWT via set_config).
--
-- O CORPO ABAIXO É CÓPIA FIEL do `auth.uid()` do Supabase — conferido em
-- 2026-08-11 com `pg_get_functiondef` no `supabase_db_deskcomm-crm` (imagem
-- supabase/postgres:17.6.1.106). A cópia importa por causa de UM detalhe que a
-- versão anterior deste stub errava:
--
--     antes:  nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')
--     real:   nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
--
-- O `nullif` do original protege o CAST; o do stub protegia o resultado. Um GUC
-- customizado que já foi tocado numa transação anterior passa a existir com
-- string VAZIA em vez de NULL — e aí o stub estourava
-- `invalid input syntax for type json` onde o Supabase devolve NULL sossegado.
-- Consequência: qualquer função que chame `auth.uid()` incondicionalmente (o
-- guard `if auth.uid() is not null and not fn_role_at_least(...)`, que é o
-- padrão deste schema) quebrava no gate e passava em produção. Instrumento que
-- diverge do produto não mede o produto.
create or replace function auth.uid() returns uuid
  language sql stable
  as $fn$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $fn$;

grant usage on schema auth, extensions, storage to anon, authenticated, service_role;
grant select on auth.users to anon, authenticated, service_role;