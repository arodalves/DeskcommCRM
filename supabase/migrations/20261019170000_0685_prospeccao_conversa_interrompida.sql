-- manifest: prospeccao comercial conversa interrompida (Fluxalvo CRM)

-- 1. Unicidade por pointer e candidato (suporta sem resposta e conversa interrompida)
drop index if exists public.idx_followup_enrollments_prospecting_candidate;

create unique index if not exists idx_followup_enrollments_prospecting_cand_pointer
  on public.followup_enrollments (organization_id, pointer_id, prospecting_candidate_id)
  where prospecting_candidate_id is not null;

-- 2. Registro da mensagem do corretor/agente que originou a espera do follow-up
alter table public.followup_enrollments
  add column if not exists prospecting_last_outbound_at timestamptz,
  add column if not exists prospecting_outbound_message_id uuid;
