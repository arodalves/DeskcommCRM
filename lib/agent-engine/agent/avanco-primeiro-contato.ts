/**
 * Avanço determinístico para Primeiro Contato ('contacted' / "Já respondi").
 *
 * ═══ A REGRA DE NEGÓCIO ═══
 *
 * A etapa "Já respondi" corresponde semanticamente ao estado `contacted`:
 * "o contato humano chamou e a Fluxalvo/Xavier já respondeu pela primeira vez".
 *
 * Deixar essa primeira transição sob decisão discricionária da LLM causa
 * inconsistência operacional (ex.: Deusdete avançou porque a tool foi chamada,
 * enquanto Surdo ficou estagnado em "Chamou agora" mesmo após Xavier responder).
 *
 * Este módulo torna essa primeira transição ESTRITAMENTE DETERMINÍSTICA quando:
 * 1. O lead está em `new` / "Chamou agora";
 * 2. Existe uma mensagem INBOUND HUMANA real do contato;
 * 3. Xavier enviou com sucesso uma resposta a essa mensagem;
 * 4. O envio foi aceito pelo canal/provedor.
 *
 * ═══ PROTEÇÕES CONTRA BOTS E PROSPECÇÃO ═══
 *
 * NÃO avança quando:
 * - A mensagem inbound for automática/bot (Níveis 1, 2 ou 3 em ehRespostaAutomatica);
 * - For resposta automática de ausência ou horário;
 * - For menu/chatbot ou opções numéricas;
 * - For bloqueio automático de fornecedores/parcerias;
 * - Não houver mensagem humana real;
 * - For apenas abordagem outbound inicial de prospecção (sem resposta do contato).
 *
 * Se um prospect de prospecção responder de forma humana e Xavier responder a ele,
 * aí sim a regra avança normalmente para 'contacted'.
 */

import type { Queryable } from "../queue/queue";
import type { CrmEdgeConfig } from "../edge/crm/mcp-client";
import type { ChannelSendResult } from "../channel-adapter";
import { ehRespostaAutomatica } from "@/lib/prospecting/resposta-automatica";
import { applyLeadStateUpdate, getLeadState, type LeadStage } from "./lead-state";
import { mirrorLeadStageToCrm } from "../edge/crm/move-lead-stage";
import type { Logger } from "../obs/logger";

export interface EntradaAvancoPrimeiroContato {
  pool: Queryable;
  crmCfg: CrmEdgeConfig;
  tenantId: string;
  leadId: string; // contact_id do CRM
  jobId: string;
  messages: ReadonlyArray<{ direction: string; body: string | null }>;
  outcomes: ReadonlyArray<ChannelSendResult>;
  pipelineIds?: readonly string[];
  log?: Logger;
  preview?: boolean;
}

export type ResultadoAvancoPrimeiroContato =
  | { moveu: true; toStage: "contacted" }
  | { moveu: false; motivo: string; stageAtual?: string; detalhe?: unknown };

export interface DepsAvancoPrimeiroContato {
  getLeadState?: typeof getLeadState;
  applyState?: typeof applyLeadStateUpdate;
  mirror?: typeof mirrorLeadStageToCrm;
}

export async function sincronizarPrimeiroContatoSeElegivel(
  entrada: EntradaAvancoPrimeiroContato,
  deps: DepsAvancoPrimeiroContato = {},
): Promise<ResultadoAvancoPrimeiroContato> {
  if (entrada.preview) {
    return { moveu: false, motivo: "modo_preview" };
  }

  // Condição 3 e 4: Xavier enviou resposta com sucesso e foi aceita pelo canal/provedor
  const enviouComSucesso = entrada.outcomes.some(
    (o) => o.kind === "sent" || o.kind === "already_sent",
  );
  if (!enviouComSucesso) {
    return { moveu: false, motivo: "sem_envio_com_sucesso" };
  }

  // Condição 2: Existe mensagem inbound humana real do contato
  const inbounds = entrada.messages.filter((m) => m.direction === "inbound");
  if (inbounds.length === 0) {
    // Ex.: abordagem outbound inicial de prospecção — sem nenhuma resposta do contato
    return { moveu: false, motivo: "sem_inbound" };
  }

  const lastInbound = inbounds[inbounds.length - 1];
  const texto = lastInbound?.body?.trim() ?? "";
  if (!texto) {
    return { moveu: false, motivo: "inbound_vazio" };
  }

  // Resposta automática de bot, ausência, menu ou bloqueio NUNCA avança estágio comercial
  if (ehRespostaAutomatica(texto)) {
    entrada.log?.info("avanço determinístico ignorado: inbound identificado como resposta automática/bot", {
      texto_preview: texto.slice(0, 60),
    });
    return { moveu: false, motivo: "resposta_automatica" };
  }

  // Condição 1: Lead está em 'new' / "Chamou agora"
  const getState = deps.getLeadState ?? getLeadState;
  const currentState = await getState(entrada.pool, entrada.tenantId, entrada.leadId);
  const currentStage: LeadStage = currentState?.stage ?? "new";

  if (currentStage !== "new") {
    // Já está em 'contacted' ("Já respondi") ou já avançou para etapas posteriores (qualifying, won, etc.)
    return { moveu: false, motivo: "estagio_ja_avancado", stageAtual: currentStage };
  }

  // Executa a transição determinística para 'contacted'
  const applyState = deps.applyState ?? applyLeadStateUpdate;
  const update = await applyState(
    entrada.pool,
    { tenantId: entrada.tenantId, leadId: entrada.leadId, jobId: entrada.jobId },
    { stage: "contacted", reason: "primeira_resposta_humana_enviada" },
  );

  if (!update.ok) {
    entrada.log?.warn("avanço determinístico: applyLeadStateUpdate recusou transição", {
      erro: update.error,
    });
    return { moveu: false, motivo: "recusa_lead_state", detalhe: update.error };
  }

  // Espelha no CRM via sincronizaEstagioDoAgente
  const mirror = deps.mirror ?? mirrorLeadStageToCrm;
  const mirrorResult = await mirror(entrada.pool, entrada.crmCfg, {
    tenantId: entrada.tenantId,
    leadId: entrada.leadId,
    toStage: "contacted",
    reason: "primeira_resposta_humana_enviada",
    ...(entrada.pipelineIds !== undefined ? { pipelineIds: entrada.pipelineIds } : {}),
  });

  if (!mirrorResult.ok) {
    entrada.log?.warn("avanço determinístico: espelho no CRM recusou", {
      reason: mirrorResult.reason,
      detail: mirrorResult.detail,
    });
    return { moveu: false, motivo: "espelho_recusado", detalhe: mirrorResult };
  }

  return { moveu: true, toStage: "contacted" };
}
