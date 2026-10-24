import type pg from "pg";
import { createAdminClient } from "@/lib/supabase/admin";
import { encerraDemanda } from "@/lib/leads/encerramento";
import { insertInboxItem } from "@/lib/agent-engine/db/repository";
import { sinaisComerciais } from "./sinais-comerciais";

/** Só a campanha, agente e conexão que originaram a abordagem podem encerrá-la. */
export async function aplicarRecusaDeProspeccao(
  pool: pg.Pool,
  input: {
    org: string;
    contactId: string;
    conversationId: string;
    agentId?: string;
    channelId?: string;
    texto: string;
    requestId: string;
  },
): Promise<boolean> {
  const sinal = sinaisComerciais(input.texto);
  if (!input.agentId || !input.channelId) return false;
  const { rows } = await pool.query<{
    id: string;
    lead_id: string | null;
    pipeline_id: string;
    ja_recusado: boolean;
  }>(
    `select p.id,p.lead_id,c.config->>'pipeline_id' pipeline_id,
       p.data ? 'commercial_refusal' ja_recusado
     from prospecting_candidates p
     join prospecting_campaigns c on c.organization_id=p.organization_id and c.id=p.campaign_id
     join conversations v on v.organization_id=p.organization_id and v.id=p.conversation_id and v.contact_id=p.contact_id
     join contacts ct on ct.organization_id=p.organization_id and ct.id=p.contact_id
     where p.organization_id=$1 and p.contact_id=$2 and p.conversation_id=$3
       and p.status='sent' and p.provider_accepted_at is not null
       and c.config->>'agent_id'=$4 and c.config->>'channel_session_id'=$5
       and v.active_ai_agent_id::text=$4 and v.channel_session_id::text=$5
       and v.assigned_to_user_id is null and not coalesce(ct.force_human,false)
     order by p.provider_accepted_at desc limit 1`,
    [input.org, input.contactId, input.conversationId, input.agentId, input.channelId],
  );
  const candidate = rows[0];
  if (!candidate) return false;
  if (candidate.ja_recusado && !sinal.recusa) return true;
  if (!sinal.recusa && !sinal.revisar) return false;
  if (sinal.revisar) {
    await pool.query(
      `update followup_enrollments set status='cancelled',cancel_reason='commercial_review',
        completed_at=now(),next_eval_at=null,claimed_until=null,updated_at=now(),revision=revision+1
       where organization_id=$1 and prospecting_candidate_id=$2
         and status in ('active','waiting_reply','paused_handoff','dormente')`,
      [input.org, candidate.id],
    );
    await insertInboxItem(
      pool,
      input.org,
      {
        kind: "other",
        title: "Revisar resposta ambígua da prospecção",
        body: "A resposta não comprova recusa definitiva nem serviço equivalente. Confira a conversa antes de mover o negócio.",
        refKind: "lead",
        refId: candidate.lead_id ?? input.contactId,
      },
      "kind_ref_e_titulo",
    );
    return true;
  }
  // Marker + cancelamento são uma única escrita atômica, inclusive em retry.
  await pool.query(
    `with refused as (
       update prospecting_candidates set data=coalesce(data,'{}'::jsonb) ||
         jsonb_build_object('commercial_refusal',jsonb_build_object('at',now(),'request_id',$3::text)),updated_at=now()
       where organization_id=$1 and id=$2 and not (coalesce(data,'{}'::jsonb) ? 'commercial_refusal') returning id
     ), stopped_crons as (
       update cron_jobs set enabled=false,updated_at=now()
       where organization_id=$1 and contact_id=$5 and enabled=true
         and job_kind='followup_turn' and payload->'service_boundary'->>'conversation_id'=$4
     ), closed_conversation as (
       update conversations set status='closed',service_closed_at=now(),status_changed_at=now()
       where organization_id=$1 and id::text=$4 and active_ai_agent_id::text=$6
         and assigned_to_user_id is null and status='open'
     ) update followup_enrollments set status='cancelled',cancel_reason='commercial_refusal',
       completed_at=now(),next_eval_at=null,claimed_until=null,updated_at=now(),revision=revision+1
       where organization_id=$1 and prospecting_candidate_id=$2
         and status in ('active','waiting_reply','paused_handoff','dormente')`,
    [
      input.org,
      candidate.id,
      input.requestId,
      input.conversationId,
      input.contactId,
      input.agentId,
    ],
  );
  if (candidate.lead_id) {
    const admin = createAdminClient();
    // A etapa terminal precisa ser a do funil da campanha; não escolhemos outro negócio.
    const { data: lead, error } = await admin
      .from("crm_leads")
      .select("pipeline_id,status")
      .eq("organization_id", input.org)
      .eq("id", candidate.lead_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (lead?.pipeline_id === candidate.pipeline_id && lead.status === "open") {
      try {
        await encerraDemanda(
          admin,
          {
            organization_id: input.org,
            actor: {
              type: "ai_agent",
              id: input.requestId,
              agent_id: input.agentId,
              role: "agent",
            },
            requestId: input.requestId,
          },
          {
            leadId: candidate.lead_id,
            desfecho: "lost",
            motivo: "other",
            razaoNaTimeline:
              "Recusa explícita da abordagem comercial; novas tentativas canceladas.",
            payloadNaTimeline: {
              prospecting_candidate_id: candidate.id,
              evidence_text: input.texto.slice(0, 1000),
              request_id: input.requestId,
            },
          },
        );
      } catch {
        await insertInboxItem(
          pool,
          input.org,
          {
            kind: "other",
            title: "Revisar encerramento da prospecção",
            body: "A pessoa recusou a abordagem. As tentativas foram canceladas; confira a etapa e os campos obrigatórios do negócio.",
            refKind: "lead",
            refId: candidate.lead_id,
          },
          "kind_ref_e_titulo",
        );
      }
    }
  }
  return true;
}
