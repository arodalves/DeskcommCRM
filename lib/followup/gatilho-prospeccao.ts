/**
 * Gatilho PROSPECÇÃO ACEITE INICIAL (`trigger_config.kind='prospecting_initial_accepted'`).
 *
 * O follow-up de prospecção é armado SOMENTE após a primeira abordagem da prospecção
 * automática ser efetivamente aceita pelo provedor/canal (`provider_accepted_at`).
 *
 * O gatilho "Silêncio" NÃO deve ser usado.
 * Sem inscrição retroativa.
 * Proteções estruturais para os 7 leads manuais protegidos.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { triggerConfigSchema } from "./api-schemas";
import { enrollFollowupFlow } from "./enroll";
import { adicionarDiasUteis } from "@/lib/prospecting/business-days";
import { checarExclusaoDeProspeccao } from "@/lib/prospecting/exclusions";

export const EVENTO_PROSPECCAO_ACEITE_INICIAL = "prospecting.initial_outbound_accepted";
export const EVENTO_PROSPECCAO_CONVERSA_INTERROMPIDA = "prospecting.conversation_interrupted";
export const IDADE_MAXIMA_EVENTO_ACEITE_MS = 24 * 60 * 60 * 1000; // 24 horas

export interface PayloadAceiteProspeccao {
  candidate_id: string;
  campaign_id: string;
  lead_id?: string | null;
  contact_id: string;
  conversation_id: string;
  message_id: string;
  provider_accepted_at: string;
  attempted_at?: string | null;
  activation_version?: number | null;
  activation_timestamp?: string | null;
}

export interface PayloadConversaInterrompida {
  candidate_id: string;
  campaign_id: string;
  lead_id?: string | null;
  contact_id: string;
  conversation_id: string;
  message_id: string;
  sent_at: string;
  activation_version?: number | null;
  activation_timestamp?: string | null;
}

export interface GatilhoProspeccaoSummary {
  matched: boolean;
  pointers_armados: number;
  enrolled: number;
  skipped_existing: number;
  skipped_retroactive: number;
  skipped_exclusion: number;
  skipped_unmatched_campaign: number;
}

export interface PointerDeProspeccao {
  id: string;
  organization_id: string;
  active_version_id: string;
  name: string;
  campaign_ids?: string[];
}

export async function carregarPointersDeProspeccao(
  admin: SupabaseClient,
  orgId: string,
): Promise<PointerDeProspeccao[]> {
  const { data, error } = await admin
    .from("followup_flow_pointers")
    .select("id, organization_id, active_version_id, name, trigger_config, status, surface")
    .eq("organization_id", orgId)
    .eq("status", "active")
    .not("active_version_id", "is", null);

  if (error) throw new Error(error.message);

  const pointers: PointerDeProspeccao[] = [];
  for (const row of (data ?? []) as Array<{
    id: string;
    organization_id: string;
    active_version_id: string | null;
    name: string;
    trigger_config: unknown;
    surface?: string | null;
  }>) {
    if (!row.active_version_id || row.surface === "atendimento") continue;

    const parsed = triggerConfigSchema.safeParse(row.trigger_config);
    if (parsed.success && parsed.data.kind === "prospecting_initial_accepted") {
      pointers.push({
        id: row.id,
        organization_id: row.organization_id,
        active_version_id: row.active_version_id,
        name: row.name,
        campaign_ids: parsed.data.params?.campaign_ids,
      });
    } else if (row.name === "Prospecção comercial — sem resposta") {
      // Reconhecimento nominal para o fluxo oficial de prospecção comercial
      pointers.push({
        id: row.id,
        organization_id: row.organization_id,
        active_version_id: row.active_version_id,
        name: row.name,
      });
    }
  }

  return pointers;
}

export async function aplicaGatilhoDeProspeccao(
  deps: {
    admin: SupabaseClient;
    clock?: () => Date;
  },
  row: EventRow,
): Promise<GatilhoProspeccaoSummary> {
  const clock = deps.clock ?? (() => new Date());
  const now = clock();

  const summary: GatilhoProspeccaoSummary = {
    matched: false,
    pointers_armados: 0,
    enrolled: 0,
    skipped_existing: 0,
    skipped_retroactive: 0,
    skipped_exclusion: 0,
    skipped_unmatched_campaign: 0,
  };

  if (row.event_type !== EVENTO_PROSPECCAO_ACEITE_INICIAL) {
    return summary;
  }

  const payload = row.payload as unknown as PayloadAceiteProspeccao;
  if (!payload || !payload.candidate_id || !payload.contact_id || !payload.provider_accepted_at) {
    return summary;
  }

  summary.matched = true;

  // 1. Defesa anti-retroativa dinâmica e real baseada no banco:
  // Consulta a campanha real no banco para obter activated_at e activation_version
  const { data: campaign, error: campErr } = await deps.admin
    .from("prospecting_campaigns")
    .select("id, status, activated_at, activation_version")
    .eq("organization_id", row.organization_id)
    .eq("id", payload.campaign_id)
    .maybeSingle();

  if (campErr || !campaign || !campaign.activated_at) {
    summary.skipped_retroactive++;
    return summary;
  }

  const campaignActivationTime = new Date(campaign.activated_at).getTime();
  const campaignActivationVersion = campaign.activation_version ?? 1;

  // Reativação futura não pode reaproveitar eventos da ativação anterior
  if (
    payload.activation_version !== undefined &&
    payload.activation_version !== null &&
    payload.activation_version !== campaignActivationVersion
  ) {
    summary.skipped_retroactive++;
    return summary;
  }

  // Candidato deve ter sido reservado após a ativação e aceito após a ativação
  const candidateAttemptTime = payload.attempted_at
    ? Date.parse(payload.attempted_at)
    : Date.parse(payload.provider_accepted_at);
  const acceptedAtTime = Date.parse(payload.provider_accepted_at);

  if (
    isNaN(acceptedAtTime) ||
    candidateAttemptTime < campaignActivationTime ||
    acceptedAtTime < campaignActivationTime
  ) {
    summary.skipped_retroactive++;
    return summary;
  }

  // Idade máxima do evento
  if (now.getTime() - acceptedAtTime > IDADE_MAXIMA_EVENTO_ACEITE_MS) {
    summary.skipped_retroactive++;
    return summary;
  }

  // 2. Proteção persistente e estrutural contra abordagem de leads manuais
  const exclusao = await checarExclusaoDeProspeccao(deps.admin, {
    organizationId: row.organization_id,
    leadId: payload.lead_id,
    contactId: payload.contact_id,
  });

  if (exclusao.excluido) {
    summary.skipped_exclusion++;
    return summary;
  }

  // 3. Idempotência por candidato: um candidato só pode ter uma inscrição nesse fluxo
  const { data: existingEnr } = await deps.admin
    .from("followup_enrollments")
    .select("id")
    .eq("organization_id", row.organization_id)
    .eq("prospecting_candidate_id", payload.candidate_id)
    .maybeSingle();

  if (existingEnr) {
    summary.skipped_existing++;
    return summary;
  }

  // 4. Carregar pointers armados para prospecção na organização
  const pointers = await carregarPointersDeProspeccao(deps.admin, row.organization_id);
  summary.pointers_armados = pointers.length;

  for (const pointer of pointers) {
    // Se o pointer especifica campanhas alvo, validar
    if (pointer.campaign_ids && pointer.campaign_ids.length > 0) {
      if (!pointer.campaign_ids.includes(payload.campaign_id)) {
        summary.skipped_unmatched_campaign++;
        continue;
      }
    }

    // Calcular Follow-up 1: exatamente 2 dias úteis após o aceite real da primeira abordagem
    const dataAceite = new Date(payload.provider_accepted_at);
    const dataFollowup1 = adicionarDiasUteis(dataAceite, 2);

    const enrollRes = await enrollFollowupFlow(deps.admin, {
      organizationId: row.organization_id,
      pointerId: pointer.id,
      contactId: payload.contact_id,
      actorUserId: null,
      requestId: row.id,
      prospectingCandidateId: payload.candidate_id,
      prospectingCampaignId: payload.campaign_id,
      prospectingAcceptedAt: payload.provider_accepted_at,
      prospectingActivationVersion: campaignActivationVersion,
      nextEvalAt: dataFollowup1.toISOString(),
    });

    if (enrollRes.ok) {
      summary.enrolled++;
    } else if (enrollRes.code === "conflict") {
      summary.skipped_existing++;
    }
  }

  return summary;
}

export async function carregarPointersDeProspeccaoConversaInterrompida(
  admin: SupabaseClient,
  orgId: string,
): Promise<PointerDeProspeccao[]> {
  const { data, error } = await admin
    .from("followup_flow_pointers")
    .select("id, organization_id, active_version_id, name, trigger_config, status, surface")
    .eq("organization_id", orgId)
    .eq("status", "active")
    .not("active_version_id", "is", null);

  if (error) throw new Error(error.message);

  const pointers: PointerDeProspeccao[] = [];
  for (const row of (data ?? []) as Array<{
    id: string;
    organization_id: string;
    active_version_id: string | null;
    name: string;
    trigger_config: unknown;
    surface?: string | null;
  }>) {
    if (!row.active_version_id || row.surface === "atendimento") continue;

    const parsed = triggerConfigSchema.safeParse(row.trigger_config);
    if (parsed.success && parsed.data.kind === "prospecting_conversation_interrupted") {
      pointers.push({
        id: row.id,
        organization_id: row.organization_id,
        active_version_id: row.active_version_id,
        name: row.name,
        campaign_ids: parsed.data.params?.campaign_ids,
      });
    } else if (row.name === "Prospecção comercial — conversa interrompida") {
      pointers.push({
        id: row.id,
        organization_id: row.organization_id,
        active_version_id: row.active_version_id,
        name: row.name,
      });
    }
  }

  return pointers;
}

export async function aplicaGatilhoConversaInterrompida(
  deps: {
    admin: SupabaseClient;
    clock?: () => Date;
  },
  row: EventRow,
): Promise<GatilhoProspeccaoSummary> {
  const clock = deps.clock ?? (() => new Date());
  const now = clock();

  const summary: GatilhoProspeccaoSummary = {
    matched: false,
    pointers_armados: 0,
    enrolled: 0,
    skipped_existing: 0,
    skipped_retroactive: 0,
    skipped_exclusion: 0,
    skipped_unmatched_campaign: 0,
  };

  if (row.event_type !== EVENTO_PROSPECCAO_CONVERSA_INTERROMPIDA) {
    return summary;
  }

  const payload = row.payload as unknown as PayloadConversaInterrompida;
  if (!payload || !payload.candidate_id || !payload.contact_id || !payload.sent_at || !payload.conversation_id) {
    return summary;
  }

  summary.matched = true;

  // 1. Defesa anti-retroativa dinâmica e real baseada no banco
  const { data: campaign, error: campErr } = await deps.admin
    .from("prospecting_campaigns")
    .select("id, status, activated_at, activation_version")
    .eq("organization_id", row.organization_id)
    .eq("id", payload.campaign_id)
    .maybeSingle();

  if (campErr || !campaign || !campaign.activated_at) {
    summary.skipped_retroactive++;
    return summary;
  }

  const campaignActivationTime = new Date(campaign.activated_at).getTime();
  const campaignActivationVersion = campaign.activation_version ?? 1;

  if (
    payload.activation_version !== undefined &&
    payload.activation_version !== null &&
    payload.activation_version !== campaignActivationVersion
  ) {
    summary.skipped_retroactive++;
    return summary;
  }

  const sentAtTime = Date.parse(payload.sent_at);
  if (isNaN(sentAtTime) || sentAtTime < campaignActivationTime) {
    summary.skipped_retroactive++;
    return summary;
  }

  if (now.getTime() - sentAtTime > IDADE_MAXIMA_EVENTO_ACEITE_MS) {
    summary.skipped_retroactive++;
    return summary;
  }

  // 2. Proteção aos 7 leads manuais e exclusões persistentes
  const exclusao = await checarExclusaoDeProspeccao(deps.admin, {
    organizationId: row.organization_id,
    leadId: payload.lead_id,
    contactId: payload.contact_id,
  });

  if (exclusao.excluido) {
    summary.skipped_exclusion++;
    return summary;
  }

  // 3. Evidência estrutural: candidato de prospecção deve existir e ter sido aceito
  const { data: candidate, error: candErr } = await deps.admin
    .from("prospecting_candidates")
    .select("id, status, provider_accepted_at, conversation_id, contact_id, campaign_id")
    .eq("organization_id", row.organization_id)
    .eq("id", payload.candidate_id)
    .maybeSingle();

  if (
    candErr ||
    !candidate ||
    candidate.status !== "sent" ||
    !candidate.provider_accepted_at ||
    candidate.conversation_id !== payload.conversation_id ||
    candidate.contact_id !== payload.contact_id
  ) {
    summary.skipped_retroactive++;
    return summary;
  }

  // 4. Evidência estrutural: prospect respondeu pelo menos uma vez antes desta mensagem
  const { data: priorInbounds } = await deps.admin
    .from("messages")
    .select("id, created_at")
    .eq("organization_id", row.organization_id)
    .eq("conversation_id", payload.conversation_id)
    .eq("direction", "inbound")
    .gt("created_at", candidate.provider_accepted_at)
    .limit(1);

  if (!priorInbounds || priorInbounds.length === 0) {
    summary.skipped_existing++;
    return summary;
  }

  // 5. Evidência estrutural: checagem de permissões, conversa e oportunidade
  const [convRes, contactRes, leadRes] = await Promise.all([
    deps.admin
      .from("conversations")
      .select("status, last_inbound_at, last_outbound_at, assigned_to_user_id, bot_silenced_until")
      .eq("organization_id", row.organization_id)
      .eq("id", payload.conversation_id)
      .maybeSingle(),
    deps.admin
      .from("contacts")
      .select("is_blocked, force_human, is_anonymized, consent")
      .eq("organization_id", row.organization_id)
      .eq("id", payload.contact_id)
      .maybeSingle(),
    payload.lead_id
      ? deps.admin
          .from("crm_leads")
          .select("status")
          .eq("organization_id", row.organization_id)
          .eq("id", payload.lead_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (convRes.error || !convRes.data || contactRes.error || !contactRes.data) {
    summary.skipped_existing++;
    return summary;
  }

  const conv = convRes.data;
  const contact = contactRes.data;

  // Atendimento humano / Handoff terminal
  if (conv.assigned_to_user_id || ["claimed", "closed", "resolved", "archived"].includes(conv.status)) {
    summary.skipped_existing++;
    return summary;
  }

  // Bot silenciado
  if (conv.bot_silenced_until === "infinity" || (conv.bot_silenced_until && Date.parse(conv.bot_silenced_until) > now.getTime())) {
    summary.skipped_existing++;
    return summary;
  }

  // Contato em force_human, bloqueado ou anonimizado
  if (contact.force_human === true || contact.is_blocked || contact.is_anonymized) {
    summary.skipped_existing++;
    return summary;
  }

  const consent = (contact.consent ?? {}) as Record<string, unknown>;
  const marketing = (consent.marketing ?? {}) as Record<string, unknown>;
  if (marketing.declined_at || marketing.opt_out) {
    summary.skipped_existing++;
    return summary;
  }

  // Oportunidade encerrada em condição impeditiva
  if (leadRes.data && ["lost", "won", "archived"].includes(leadRes.data.status)) {
    summary.skipped_existing++;
    return summary;
  }

  // Se o cliente já enviou mensagem após este envio do Xavier, não arma
  if (conv.last_inbound_at && Date.parse(conv.last_inbound_at) > sentAtTime) {
    summary.skipped_existing++;
    return summary;
  }

  // 6. Carregar pointers armados para conversa interrompida
  const pointers = await carregarPointersDeProspeccaoConversaInterrompida(deps.admin, row.organization_id);
  summary.pointers_armados = pointers.length;

  for (const pointer of pointers) {
    if (pointer.campaign_ids && pointer.campaign_ids.length > 0) {
      if (!pointer.campaign_ids.includes(payload.campaign_id)) {
        summary.skipped_unmatched_campaign++;
        continue;
      }
    }

    // Idempotência: verificar se já existe inscrição ativa neste pointer para este contato
    const { data: existingActive } = await deps.admin
      .from("followup_enrollments")
      .select("id, prospecting_outbound_message_id")
      .eq("organization_id", row.organization_id)
      .eq("pointer_id", pointer.id)
      .eq("contact_id", payload.contact_id)
      .in("status", ["active", "waiting_reply", "paused_handoff"])
      .maybeSingle();

    if (existingActive) {
      summary.skipped_existing++;
      continue;
    }

    // Calcular Follow-up 1: exatamente 2 dias úteis após a mensagem do Xavier
    const dataFollowup1 = adicionarDiasUteis(new Date(payload.sent_at), 2);

    const enrollRes = await enrollFollowupFlow(deps.admin, {
      organizationId: row.organization_id,
      pointerId: pointer.id,
      contactId: payload.contact_id,
      actorUserId: null,
      requestId: row.id,
      prospectingCandidateId: payload.candidate_id,
      prospectingCampaignId: payload.campaign_id,
      prospectingAcceptedAt: candidate.provider_accepted_at,
      prospectingActivationVersion: campaignActivationVersion,
      prospectingLastOutboundAt: payload.sent_at,
      prospectingOutboundMessageId: payload.message_id,
      nextEvalAt: dataFollowup1.toISOString(),
    });

    if (enrollRes.ok) {
      summary.enrolled++;
    } else if (enrollRes.code === "conflict") {
      summary.skipped_existing++;
    }
  }

  return summary;
}

export async function verificarEEmitirConversaInterrompida(
  db: { query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  input: {
    tenantId: string;
    conversationId: string;
    contactId?: string | null;
    agentId?: string | null;
    lastMessageId: string | null;
  },
): Promise<boolean> {
  const { tenantId, conversationId, lastMessageId } = input;
  if (!conversationId || !lastMessageId) return false;

  // 1. Verificar se a conversa pertence a um candidato de prospecção aceito
  const candRes = await db.query(
    `SELECT id, campaign_id, lead_id, contact_id, provider_accepted_at, activation_version, activation_timestamp
     FROM public.prospecting_candidates
     WHERE organization_id = $1
       AND conversation_id = $2
       AND status = 'sent'
       AND provider_accepted_at IS NOT NULL
     LIMIT 1`,
    [tenantId, conversationId],
  );

  if (candRes.rows.length === 0) return false;
  const cand = candRes.rows[0] as {
    id: string;
    campaign_id: string;
    lead_id: string | null;
    contact_id: string;
    provider_accepted_at: string;
    activation_version: number | null;
    activation_timestamp: string | null;
  };

  // 2. Verificar se o prospect respondeu pelo menos uma vez antes desta mensagem
  const inboundsRes = await db.query(
    `SELECT 1 FROM public.messages
     WHERE organization_id = $1
       AND conversation_id = $2
       AND direction = 'inbound'
       AND created_at > $3
     LIMIT 1`,
    [tenantId, conversationId, cand.provider_accepted_at],
  );

  if (inboundsRes.rows.length === 0) return false;

  // 3. Emitir evento durável de conversa interrompida
  const nowIso = new Date().toISOString();
  await db.query(
    `SELECT public.emit_event(
       'prospecting.conversation_interrupted',
       'prospecting_candidate',
       $3::uuid,
       $4::jsonb,
       '{"source": "agent_inbound_turn"}'::jsonb,
       $1::uuid
     )`,
    [
      tenantId,
      conversationId,
      cand.id,
      JSON.stringify({
        candidate_id: cand.id,
        campaign_id: cand.campaign_id,
        lead_id: cand.lead_id,
        contact_id: cand.contact_id,
        conversation_id: conversationId,
        message_id: lastMessageId,
        agent_id: input.agentId ?? null,
        sent_at: nowIso,
        activation_version: cand.activation_version,
        activation_timestamp: cand.activation_timestamp,
      }),
    ],
  );

  return true;
}

