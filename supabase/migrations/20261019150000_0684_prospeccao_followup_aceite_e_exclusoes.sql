-- manifest: prospeccao follow-up aceite real e exclusoes persistentes (Fluxalvo CRM)

-- 1. provider_accepted_at, activation_timestamp e activation_version em prospecting_candidates
alter table public.prospecting_candidates
  add column if not exists provider_accepted_at timestamptz,
  add column if not exists activation_timestamp timestamptz,
  add column if not exists activation_version integer not null default 0;

create index if not exists idx_prospecting_candidates_accepted_at
  on public.prospecting_candidates (organization_id, provider_accepted_at)
  where provider_accepted_at is not null;

-- 2. activated_at e activation_version em prospecting_campaigns
alter table public.prospecting_campaigns
  add column if not exists activated_at timestamptz,
  add column if not exists activation_version integer not null default 0;

-- 3. Vinculo da inscricao de follow-up com candidato de prospeccao e versao
alter table public.followup_enrollments
  add column if not exists prospecting_candidate_id uuid references public.prospecting_candidates(id) on delete set null,
  add column if not exists prospecting_campaign_id uuid references public.prospecting_campaigns(id) on delete set null,
  add column if not exists prospecting_accepted_at timestamptz,
  add column if not exists prospecting_activation_version integer;

-- Unicidade da inscricao: um candidato de prospeccao so pode ter uma inscricao
create unique index if not exists idx_followup_enrollments_prospecting_candidate
  on public.followup_enrollments (organization_id, prospecting_candidate_id)
  where prospecting_candidate_id is not null;

-- 4. Tabela de exclusoes persistentes e estruturais da prospeccao
create table if not exists public.prospecting_exclusions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  reason text not null default 'manual_lead_protection',
  canonical_name text,
  lead_id uuid references public.crm_leads(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete cascade,
  phone text,
  place_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (organization_id, lead_id),
  unique (organization_id, contact_id)
);

create index if not exists idx_prospecting_exclusions_org_phone
  on public.prospecting_exclusions (organization_id, phone)
  where phone is not null;

create index if not exists idx_prospecting_exclusions_org_place
  on public.prospecting_exclusions (organization_id, place_id)
  where place_id is not null;

create index if not exists idx_prospecting_exclusions_org_name
  on public.prospecting_exclusions (organization_id, canonical_name)
  where canonical_name is not null;

alter table public.prospecting_exclusions enable row level security;

revoke all on public.prospecting_exclusions from public, anon, authenticated;
grant all on public.prospecting_exclusions to service_role;
