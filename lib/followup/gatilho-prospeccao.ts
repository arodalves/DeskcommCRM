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
