import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deriveLgpdFromContact,
  isLegalBasisValid,
} from "@/lib/agent-engine/guardrails/lgpd/legal-basis";
import { ProspectingError } from "./provider";
import { checarExclusaoDeProspeccao } from "./exclusions";

export interface ProspectingDelivery {
  organizationId: string;
  candidateId: string;
  conversationId: string;
}

export function contactMayBeProspected(contact: {
  is_blocked?: boolean;
  force_human?: boolean;
  is_anonymized: boolean;
  source: string | null;
  consent: Record<string, unknown> | null;
}) {
  const marketing = contact.consent?.marketing as { declined_at?: unknown; opt_out?: unknown } | undefined;
  return (
    !contact.is_blocked &&
    !contact.force_human &&
    !contact.is_anonymized &&
    !marketing?.declined_at &&
    !marketing?.opt_out &&
    isLegalBasisValid(deriveLgpdFromContact(contact, true).legalBasis)
  );
}

/** Rechecked after model generation and immediately before the provider effect. */
export async function assertProspectingDelivery(db: SupabaseClient, ctx: ProspectingDelivery) {
  const { data: candidate, error } = await db
    .from("prospecting_candidates")
    .select("id,campaign_id,contact_id,lead_id,place_id,phone,data,status,conversation_id")
    .eq("organization_id", ctx.organizationId)
    .eq("id", ctx.candidateId)
    .maybeSingle();

  if (
    error ||
    !candidate ||
    candidate.status !== "sending" ||
    candidate.conversation_id !== ctx.conversationId
  ) {
    throw new ProspectingError("Abordagem cancelada ou indisponível.", 409, "candidato");
  }

  // Verificação de exclusão estrutural e dos 7 leads manuais protegidos
  const candidateData = (candidate.data ?? {}) as Record<string, unknown>;
  const exclusao = await checarExclusaoDeProspeccao(db, {
    organizationId: ctx.organizationId,
    leadId: candidate.lead_id,
    contactId: candidate.contact_id,
    phone: candidate.phone,
    placeId: candidate.place_id,
    title: typeof candidateData.title === "string" ? candidateData.title : null,
  });

  if (exclusao.excluido) {
    throw new ProspectingError(
      exclusao.motivo ?? "Candidato protegido contra abordagem automática.",
      409,
      "candidato",
    );
  }

  const [campaign, contact, conversation] = await Promise.all([
    db
      .from("prospecting_campaigns")
      .select("status")
      .eq("organization_id", ctx.organizationId)
      .eq("id", candidate.campaign_id)
      .maybeSingle(),
    db
      .from("contacts")
      .select("is_blocked,force_human,is_anonymized,source,consent")
      .eq("organization_id", ctx.organizationId)
      .eq("id", candidate.contact_id)
      .maybeSingle(),
    db
      .from("conversations")
      .select("status,last_inbound_at,last_outbound_at,assigned_to_user_id,bot_silenced_until")
      .eq("organization_id", ctx.organizationId)
      .eq("id", ctx.conversationId)
      .eq("contact_id", candidate.contact_id)
      .maybeSingle(),
  ]);

  if (
    campaign.error ||
    contact.error ||
    conversation.error ||
    campaign.data?.status !== "running" ||
    !contact.data ||
    !conversation.data
  ) {
    throw new ProspectingError("Campanha pausada ou dados indisponíveis.", 409);
  }

  const c = conversation.data;
  if (
    !contactMayBeProspected(contact.data) ||
    c.last_inbound_at ||
    c.last_outbound_at ||
    c.assigned_to_user_id ||
    ["closed", "resolved", "archived", "claimed"].includes(c.status) ||
    c.bot_silenced_until === "infinity" ||
    (c.bot_silenced_until && Date.parse(c.bot_silenced_until) > Date.now())
  ) {
    throw new ProspectingError(
      "Contato já atendido, assumido por humano ou sem autorização para esta abordagem.",
      409,
    );
  }
}

export interface ChecarPrecondicoesFollowupInput {
  organizationId: string;
  enrollmentId: string;
  candidateId?: string | null;
}

export type ResultadoPrecondicoesFollowup =
  | { ok: true }
  | { ok: false; reason: string; terminal: boolean };

/**
 * Validação rigorosa e completa antes de disparar qualquer mensagem de follow-up
 * da prospecção comercial.
 *
 * Se qualquer proteção falhar:
 * - Cancela a inscrição definitivamente;
 * - Handoff humano é terminal (não pausa para depois retomar).
 */
export async function assertProspectingFollowupPreconditions(
  db: SupabaseClient,
  input: ChecarPrecondicoesFollowupInput,
): Promise<ResultadoPrecondicoesFollowup> {
  const { organizationId, enrollmentId } = input;

  // 1. Carregar enrollment
  const { data: enrollment, error: enrErr } = await db
    .from("followup_enrollments")
    .select("id, organization_id, contact_id, conversation_id, status, prospecting_candidate_id, prospecting_campaign_id, prospecting_accepted_at")
    .eq("organization_id", organizationId)
    .eq("id", enrollmentId)
    .maybeSingle();

  if (enrErr || !enrollment) {
    return { ok: false, reason: "Inscrição de follow-up não encontrada.", terminal: true };
  }

  const candidateId = input.candidateId ?? enrollment.prospecting_candidate_id;
  if (!candidateId) {
    // Não é um enrollment de prospecção, passa normalmente
    return { ok: true };
  }

  // 2. Carregar candidato
  const { data: candidate, error: candErr } = await db
    .from("prospecting_candidates")
    .select("id, organization_id, campaign_id, contact_id, lead_id, conversation_id, place_id, phone, data, status, message_id, provider_accepted_at, activation_version, activation_timestamp")
    .eq("organization_id", organizationId)
    .eq("id", candidateId)
    .maybeSingle();

  if (candErr || !candidate) {
    return { ok: false, reason: "Candidato de prospecção não encontrado.", terminal: true };
  }

  // Coerência entre candidato e inscrição
  if (
    candidate.contact_id !== enrollment.contact_id ||
    candidate.conversation_id !== enrollment.conversation_id
  ) {
    return {
      ok: false,
      reason: "Incoerência entre o candidato de prospecção e a inscrição de follow-up.",
      terminal: true,
    };
  }

  // 3. Comprovação da primeira abordagem automática continua válida
  if (candidate.status !== "sent" || !candidate.provider_accepted_at) {
    return {
      ok: false,
      reason: "Primeira abordagem de prospecção não foi confirmada como aceita pelo provedor.",
      terminal: true,
    };
  }

  // Confirma status da mensagem inicial no banco
  if (candidate.message_id) {
    const { data: msg } = await db
      .from("messages")
      .select("status")
      .eq("organization_id", organizationId)
      .eq("id", candidate.message_id)
      .maybeSingle();

    if (msg && !["sent", "delivered", "read"].includes(msg.status)) {
      return {
        ok: false,
        reason: "Mensagem da abordagem inicial não está em estado de entrega aceito.",
        terminal: true,
      };
    }
  }

  // 4. Verificação de exclusão persistente e estrutural (incluindo os 7 leads manuais)
  const candidateData = (candidate.data ?? {}) as Record<string, unknown>;
  const exclusao = await checarExclusaoDeProspeccao(db, {
    organizationId,
    leadId: candidate.lead_id,
    contactId: candidate.contact_id,
    phone: candidate.phone,
    placeId: candidate.place_id,
    title: typeof candidateData.title === "string" ? candidateData.title : null,
  });

  if (exclusao.excluido) {
    return {
      ok: false,
      reason: exclusao.motivo ?? "Contato protegido contra follow-up de prospecção.",
      terminal: true,
    };
  }

  // 5. Campanha continua válida e com ativação coerente
  if (candidate.campaign_id) {
    const { data: campaign } = await db
      .from("prospecting_campaigns")
      .select("status, activated_at, activation_version")
      .eq("organization_id", organizationId)
      .eq("id", candidate.campaign_id)
      .maybeSingle();

    if (!campaign || campaign.status === "cancelled") {
      return { ok: false, reason: "Campanha de prospecção foi cancelada ou removida.", terminal: true };
    }

    // Se a campanha foi reativada após o envio deste candidato, a versão não bate
    if (
      campaign.activation_version !== undefined &&
      campaign.activation_version !== null &&
      candidate.activation_version !== undefined &&
      candidate.activation_version !== null &&
      candidate.activation_version !== campaign.activation_version
    ) {
      return {
        ok: false,
        reason: "Campanha de prospecção foi reativada com nova versão; follow-up da ativação anterior encerrado.",
        terminal: true,
      };
    }
  }

  // 6. Contato e permissões
  const { data: contact } = await db
    .from("contacts")
    .select("is_blocked, force_human, is_anonymized, source, consent")
    .eq("organization_id", organizationId)
    .eq("id", candidate.contact_id)
    .maybeSingle();

  if (!contact) {
    return { ok: false, reason: "Contato não encontrado.", terminal: true };
  }

  if (contact.force_human === true) {
    return { ok: false, reason: "Contato em atendimento humano obrigatório (force_human=true).", terminal: true };
  }

  if (contact.is_blocked) {
    return { ok: false, reason: "Contato bloqueado no sistema.", terminal: true };
  }

  if (contact.is_anonymized) {
    return { ok: false, reason: "Contato anonimizado via LGPD.", terminal: true };
  }

  const consent = (contact.consent ?? {}) as Record<string, unknown>;
  const marketing = (consent.marketing ?? {}) as Record<string, unknown>;
  if (marketing.declined_at || marketing.opt_out) {
    return { ok: false, reason: "Contato realizou opt-out de mensagens comerciais.", terminal: true };
  }

  // 7. Conversa: resposta do cliente, atendimento humano e silêncio
  const { data: conv } = await db
    .from("conversations")
    .select("status, last_inbound_at, last_outbound_at, assigned_to_user_id, bot_silenced_until")
    .eq("organization_id", organizationId)
    .eq("id", candidate.conversation_id)
    .maybeSingle();

  if (!conv) {
    return { ok: false, reason: "Conversa não encontrada.", terminal: true };
  }

  // Cliente já respondeu?
  const acceptedAtTime = candidate.provider_accepted_at ? new Date(candidate.provider_accepted_at).getTime() : 0;
  if (conv.last_inbound_at) {
    const inboundTime = new Date(conv.last_inbound_at).getTime();
    if (inboundTime >= acceptedAtTime) {
      return { ok: false, reason: "O cliente já respondeu à abordagem.", terminal: true };
    }
  }

  // Checagem direta de mensagens inbound após o aceite
  const { data: inboundMessages } = await db
    .from("messages")
    .select("id, created_at")
    .eq("organization_id", organizationId)
    .eq("conversation_id", candidate.conversation_id)
    .eq("direction", "inbound")
    .gt("created_at", candidate.provider_accepted_at)
    .limit(1);

  if (inboundMessages && inboundMessages.length > 0) {
    return { ok: false, reason: "O cliente já respondeu à abordagem.", terminal: true };
  }

  // Atendimento humano / Handoff
  if (conv.assigned_to_user_id) {
    return { ok: false, reason: "Conversa assumida por operador humano (handoff).", terminal: true };
  }

  if (["claimed", "closed", "resolved", "archived"].includes(conv.status)) {
    return {
      ok: false,
      reason: `Conversa com status impeditivo (${conv.status}). Handoff/encerramento terminal.`,
      terminal: true,
    };
  }

  // Bot silenciado
  if (conv.bot_silenced_until === "infinity") {
    return { ok: false, reason: "Bot permanentemente silenciado na conversa.", terminal: true };
  }
  if (conv.bot_silenced_until && Date.parse(conv.bot_silenced_until) > Date.now()) {
    return { ok: false, reason: "Bot temporariamente silenciado na conversa.", terminal: true };
  }

  // 8. Oportunidade (crm_leads) não encerrada em condição impeditiva
  if (candidate.lead_id) {
    const { data: lead } = await db
      .from("crm_leads")
      .select("status")
      .eq("organization_id", organizationId)
      .eq("id", candidate.lead_id)
      .maybeSingle();

    if (lead && ["lost", "won", "archived"].includes(lead.status)) {
      return {
        ok: false,
        reason: `Oportunidade já encerrada (${lead.status}). Follow-up de prospecção cancelado.`,
        terminal: true,
      };
    }
  }

  return { ok: true };
}
