/**
 * BARREIRA DE RELEVÂNCIA COMERCIAL
 *
 * Encarregada de inspecionar a conversa antes de qualquer chamada ao LLM
 * (OpenAI/Anthropic/multimodal) e antes do envio de mensagens ao WhatsApp.
 *
 * Atua em 4 desfechos:
 * 1. `processar_comercial`: a mensagem tem intenção comercial válida ou é suporte/cliente ativo.
 * 2. `encerrar_por_recusa`: a mensagem indica recusa ("não tenho interesse") ou engano.
 *    Envia no máximo UMA despedida cordial, fecha o atendimento e marca o lead como perdido.
 * 3. `suprimir`: a mensagem é puramente social (bom-dia, obrigado, imagem de café, figurinha,
 *    despedida repetida) em conversa já encerrada ou sem contexto comercial. Zero custo de IA.
 * 4. `reabrir`: um contato anteriormente encerrado por recusa faz uma nova pergunta comercial
 *    inequívoca ("quanto custa o curso?"). O atendimento é reaberto automaticamente.
 */

import type pg from "pg";

import type { ChannelAdapter } from "@/lib/agent-engine/channel-adapter";
import { cancelPendingCronsForLead } from "@/lib/agent-engine/cron/scheduler";
import { applyLeadStateUpdate } from "@/lib/agent-engine/agent/lead-state";
import {
  ehMensagemSocial,
  ehRecusaOuSemInteresse,
  ehSolicitacaoComercialInequivoca,
  ehMensagemDeSuporteOuProblema,
  ehRespostaHumanaDeProspeccao,
  ehCumprimentoInicial,
  imagemTemContextoComercial,
} from "./classificador";

export const CHAVE_RELEVANCIA_COMERCIAL = "relevancia_comercial";

export interface RelevanciaLogger {
  info: (msg: string, ctx?: Record<string, unknown>) => void;
  warn: (msg: string, ctx?: Record<string, unknown>) => void;
  error?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export type PapelAgente = "prospeccao" | "comercial" | "suporte";

export interface ContextoDaConversa {
  /** Papel do agente ativo ou da conversa: Gael (prospeccao), Xavier Comercial (comercial), Xavier Suporte (suporte) */
  papelAgente?: PapelAgente;
  /** Indica se a conversa é fruto de campanha de prospecção ativa (outbound) */
  ehProspeccaoAtiva?: boolean;
  /** Vínculo comercial existente: lead é cliente ativo, já comprou ou possui status 'won' */
  temVinculoComercial?: boolean;
  /** Estágio atual do lead no funil (ex: 'new', 'lead', 'proposal', 'negotiation', 'won', 'lost') */
  etapaFunil?: string | null;
  /** Início de diálogo receptivo (lead acabou de entrar ou primeira mensagem da interação) */
  ehInicioDeAtendimento?: boolean;
}

export interface EstadoRelevanciaConversa {
  estado: "ativo" | "encerrado_sem_interesse" | "contato_acidental";
  motivo_encerramento?: string;
  encerrado_em?: string;
  despedida_enviada?: boolean;
  reaberto_em?: string;
  ultima_supressao?: {
    motivo: string;
    texto_resumido: string;
    suprimido_em: string;
  };
}

export interface InsumosDeRelevancia {
  /** Mensagem nova recebida (ou última inbound não respondida) */
  mensagemAtual: string;
  inboundsPendentes: string[];
  tipoMensagem?: string; // 'text' | 'image' | 'sticker' | 'document' | 'audio' | 'video'
  temMidia?: boolean;

  /** Contexto do papel e vínculo da conversa (Requisitos 1 a 6) */
  contexto?: ContextoDaConversa;

  /** Estado histórico da relevância gravado na conversa */
  estadoRelevancia?: EstadoRelevanciaConversa | null;
  conversaStatus?: string; // 'open' | 'closed' | 'resolved' | etc.
  conversaEncerradaEm?: string | Date | null;

  /** Mensagens recentes do contexto */
  historicoMensagens: Array<{ direction: "inbound" | "outbound"; body: string; type?: string }>;

  /** Guardas de preservação (item 9 e suporte) */
  possuiCasoAberto?: boolean;
  leadEmHandoffHumano?: boolean;
}

export type DecisaoDeRelevancia =
  | {
      acao: "processar_comercial";
      motivo:
        | "solicitacao_comercial"
        | "suporte_ou_cliente_ativo"
        | "resposta_humana_prospeccao"
        | "cumprimento_inicial_receptivo"
        | "cliente_ativo_em_atendimento"
        | "negociacao_em_andamento"
        | "inicio_de_dialogo"
        | "conversa_ativa";
      permitirMultimodal: boolean;
    }
  | {
      acao: "reabrir_comercial";
      motivo: "nova_solicitacao_comercial_apos_encerramento";
      permitirMultimodal: boolean;
    }
  | {
      acao: "encerrar_por_recusa";
      motivo: "contato_acidental" | "ausencia_de_interesse";
      deveEnviarDespedida: boolean;
      permitirMultimodal: false;
    }
  | {
      acao: "suprimir";
      motivo:
        | "social_apos_encerramento"
        | "despedida_repetida"
        | "social_isolado_sem_demanda"
        | "imagem_sem_solicitacao_comercial"
        | "sticker_ou_emoji_sem_demanda";
      permitirMultimodal: false;
    };

/**
 * Avalia de forma pura a relevância do turno antes de qualquer chamada LLM.
 */
export function avaliarRelevanciaDoTurno(insumos: InsumosDeRelevancia): DecisaoDeRelevancia {
  const {
    mensagemAtual,
    inboundsPendentes,
    tipoMensagem,
    temMidia,
    contexto = {},
    estadoRelevancia,
    conversaStatus,
    historicoMensagens,
    possuiCasoAberto,
    leadEmHandoffHumano,
  } = insumos;

  const papel =
    contexto.papelAgente ??
    (possuiCasoAberto ? "suporte" : contexto.ehProspeccaoAtiva ? "prospeccao" : "comercial");
  const ehProspeccao = papel === "prospeccao" || contexto.ehProspeccaoAtiva === true;
  const ehSuporte = papel === "suporte" || possuiCasoAberto === true;
  const temVinculo =
    contexto.temVinculoComercial === true || contexto.etapaFunil === "won";
  const etapaAvancada =
    contexto.etapaFunil === "proposal" ||
    contexto.etapaFunil === "negotiation" ||
    contexto.etapaFunil === "won";

  // 1. PRESERVAÇÃO INTEGRAL DE SUPORTE, CASOS E TRANSFERÊNCIAS HUMANAS (Item 5)
  if (ehSuporte || leadEmHandoffHumano) {
    return {
      acao: "processar_comercial",
      motivo: "suporte_ou_cliente_ativo",
      permitirMultimodal: true,
    };
  }

  // Verifica se qualquer mensagem pendente relata suporte técnico ou problema
  const temSuporte =
    ehMensagemDeSuporteOuProblema(mensagemAtual) ||
    inboundsPendentes.some(ehMensagemDeSuporteOuProblema);
  if (temSuporte) {
    return {
      acao: "processar_comercial",
      motivo: "suporte_ou_cliente_ativo",
      permitirMultimodal: true,
    };
  }

  // 2. SOLICITAÇÃO COMERCIAL INEQUÍVOCA (Item 6)
  const temComercialInequivoco =
    ehSolicitacaoComercialInequivoca(mensagemAtual) ||
    inboundsPendentes.some(ehSolicitacaoComercialInequivoca);

  const conversaJaEncerradaPorRecusa =
    estadoRelevancia?.estado === "encerrado_sem_interesse" ||
    estadoRelevancia?.estado === "contato_acidental" ||
    (conversaStatus === "closed" && estadoRelevancia?.despedida_enviada === true);

  if (temComercialInequivoco) {
    if (conversaJaEncerradaPorRecusa) {
      return {
        acao: "reabrir_comercial",
        motivo: "nova_solicitacao_comercial_apos_encerramento",
        permitirMultimodal: true,
      };
    }
    return {
      acao: "processar_comercial",
      motivo: "solicitacao_comercial",
      permitirMultimodal: true,
    };
  }

  // 3. RECUSA COMERCIAL OU CONTATO ACIDENTAL (Itens 4 e 7)
  const temRecusa =
    ehRecusaOuSemInteresse(mensagemAtual) ||
    inboundsPendentes.some(ehRecusaOuSemInteresse);

  if (temRecusa) {
    if (temVinculo) {
      return {
        acao: "processar_comercial",
        motivo: "cliente_ativo_em_atendimento",
        permitirMultimodal: false,
      };
    }
    if (etapaAvancada) {
      return {
        acao: "processar_comercial",
        motivo: "negociacao_em_andamento",
        permitirMultimodal: false,
      };
    }

    const despedidaJaEnviada =
      estadoRelevancia?.despedida_enviada === true || conversaJaEncerradaPorRecusa;
    if (despedidaJaEnviada) {
      return {
        acao: "suprimir",
        motivo: "despedida_repetida",
        permitirMultimodal: false,
      };
    }

    return {
      acao: "encerrar_por_recusa",
      motivo: "ausencia_de_interesse",
      deveEnviarDespedida: true,
      permitirMultimodal: false,
    };
  }

  // 4. CONVERSAS PREVIAMENTE ENCERRADAS POR RECUSA (Item 3 - Caso Antônio)
  // Se a conversa já foi encerrada e não é nova solicitação comercial nem recusa repetida:
  // qualquer mensagem social subsequente (bom-dia, fotos, figurinhas, bênçãos) é suprimida
  if (conversaJaEncerradaPorRecusa) {
    return {
      acao: "suprimir",
      motivo: "social_apos_encerramento",
      permitirMultimodal: false,
    };
  }

  // 5. PROSPECÇÃO ATIVA (Item 1 - Gael)
  // Respostas humanas iniciais ("bom dia", "tudo bem", "quem fala?") devem chegar ao Gael normalmente
  if (ehProspeccao) {
    if (
      ehRespostaHumanaDeProspeccao(mensagemAtual) ||
      ehCumprimentoInicial(mensagemAtual) ||
      ehMensagemSocial(mensagemAtual)
    ) {
      return {
        acao: "processar_comercial",
        motivo: "resposta_humana_prospeccao",
        permitirMultimodal: false,
      };
    }
  }

  // 6. ATENDIMENTO RECEPTIVO (Item 2 - Xavier Comercial)
  // Não silenciar cumprimentos iniciais de novos leads ou clientes ativos
  const ehCumprimento =
    ehCumprimentoInicial(mensagemAtual) ||
    ehRespostaHumanaDeProspeccao(mensagemAtual);
  const ehNovoAtendimento =
    contexto.ehInicioDeAtendimento === true ||
    historicoMensagens.length === 0 ||
    !historicoMensagens.some((m) => m.direction === "outbound");

  if (ehCumprimento && (ehNovoAtendimento || temVinculo)) {
    return {
      acao: "processar_comercial",
      motivo: "cumprimento_inicial_receptivo",
      permitirMultimodal: false,
    };
  }

  // 7. MENSAGENS EXCLUSIVAMENTE SOCIAIS / FIGURINHAS / EMOJIS (Item 3)
  const ehSocial = ehMensagemSocial(mensagemAtual, { tipoMensagem, temMidia });
  if (ehSocial) {
    if (tipoMensagem === "sticker") {
      return {
        acao: "suprimir",
        motivo: "sticker_ou_emoji_sem_demanda",
        permitirMultimodal: false,
      };
    }

    if (tipoMensagem === "image" || temMidia) {
      const temContexto = imagemTemContextoComercial(mensagemAtual, historicoMensagens);
      if (!temContexto) {
        return {
          acao: "suprimir",
          motivo: "imagem_sem_solicitacao_comercial",
          permitirMultimodal: false,
        };
      }
    }

    const jaTeveRespostaNossa = historicoMensagens.some((m) => m.direction === "outbound");
    if (jaTeveRespostaNossa) {
      return {
        acao: "suprimir",
        motivo: "social_isolado_sem_demanda",
        permitirMultimodal: false,
      };
    }
  }

  // 8. Caso padrão: conversa ativa
  return {
    acao: "processar_comercial",
    motivo: historicoMensagens.length === 0 ? "inicio_de_dialogo" : "conversa_ativa",
    permitirMultimodal: imagemTemContextoComercial(mensagemAtual, historicoMensagens),
  };
}

export interface DadosEstadoRelevanciaConversa {
  estado: EstadoRelevanciaConversa | null;
  status: string;
  service_closed_at: Date | null;
  temAtendenteHumano: boolean;
  ehProspeccaoAtiva: boolean;
  temVinculoComercial: boolean;
  etapaFunil: string | null;
}

/**
 * Lê o estado de relevância armazenado em `conversations.metadata` via Postgres,
 * juntamente com o contexto do lead (vínculo comercial, etapa do funil e prospecção).
 */
export async function lerEstadoRelevanciaConversa(
  pool: pg.Pool,
  tenantId: string,
  conversationId: string,
  leadId?: string,
): Promise<DadosEstadoRelevanciaConversa> {
  const { rows } = await pool.query<{
    metadata: Record<string, unknown> | null;
    status: string;
    service_closed_at: Date | null;
    assigned_to_user_id: string | null;
  }>(
    `select metadata, status, service_closed_at, assigned_to_user_id
       from conversations
      where organization_id = $1 and id = $2`,
    [tenantId, conversationId],
  );

  const r = rows[0];
  if (!r) {
    return {
      estado: null,
      status: "open",
      service_closed_at: null,
      temAtendenteHumano: false,
      ehProspeccaoAtiva: false,
      temVinculoComercial: false,
      etapaFunil: null,
    };
  }

  // 1. Verifica se a conversa pertence a uma campanha de prospecção ativa
  let ehProspeccaoAtiva = false;
  try {
    const { rows: candRows } = await pool.query(
      `select 1 from prospecting_candidates
        where organization_id = $1 and conversation_id = $2 and status in ('sending', 'sent')
        limit 1`,
      [tenantId, conversationId],
    );
    ehProspeccaoAtiva = (candRows?.length ?? 0) > 0;
  } catch {
    // Tolerante em ambiente de teste ou schema sem prospecção ativa
  }

  // 2. Verifica se o lead tem vínculo comercial ativo (cliente existente ou etapa 'won')
  let temVinculoComercial = false;
  let etapaFunil: string | null = null;
  if (leadId) {
    try {
      const { rows: contactRows } = await pool.query<{
        kind: string | null;
        client_recognized_at: string | null;
      }>(
        `select kind, client_recognized_at from contacts where organization_id = $1 and id = $2`,
        [tenantId, leadId],
      );
      if (
        contactRows[0]?.kind === "client" ||
        contactRows[0]?.kind === "customer" ||
        contactRows[0]?.client_recognized_at != null
      ) {
        temVinculoComercial = true;
      }

      const { rows: leadStateRows } = await pool.query<{ stage: string | null }>(
        `select stage from lead_state where organization_id = $1 and contact_id = $2`,
        [tenantId, leadId],
      );
      etapaFunil = leadStateRows[0]?.stage ?? null;
      if (etapaFunil === "won") {
        temVinculoComercial = true;
      }
    } catch {
      // Tolerante em testes unitários
    }
  }

  const rawRelevancia = r.metadata?.[CHAVE_RELEVANCIA_COMERCIAL];
  const estado =
    typeof rawRelevancia === "object" && rawRelevancia !== null
      ? (rawRelevancia as EstadoRelevanciaConversa)
      : null;

  return {
    estado,
    status: r.status,
    service_closed_at: r.service_closed_at,
    temAtendenteHumano: r.assigned_to_user_id !== null,
    ehProspeccaoAtiva,
    temVinculoComercial,
    etapaFunil,
  };
}

/**
 * Executa o encerramento do atendimento por recusa / ausência de interesse:
 * 1. Envia uma única despedida educada pelo WhatsApp (se deveEnviarDespedida = true).
 * 2. Grava metadados de encerramento em `conversations.metadata`.
 * 3. Encerra o status da conversa (`status = 'closed'`, `service_closed_at = now()`).
 * 4. Move o lead_state para 'lost' (motivo: 'sem_interesse'), desde que permitirMoverParaPerda = true.
 * 5. Cancela follow-ups agendados.
 */
export async function executarEncerramentoPorRecusa(
  pool: pg.Pool,
  deps: {
    liveChannel: () => ChannelAdapter;
    tenantId: string;
    leadId: string;
    conversationId: string;
    deveEnviarDespedida: boolean;
    motivo: string;
    permitirMoverParaPerda?: boolean;
    log: RelevanciaLogger;
  },
): Promise<void> {
  const {
    liveChannel,
    tenantId,
    leadId,
    conversationId,
    deveEnviarDespedida,
    motivo,
    permitirMoverParaPerda = true,
    log,
  } = deps;

  // 1. Envio de despedida educada única
  if (deveEnviarDespedida) {
    try {
      const channel = liveChannel();
      const mensagemDespedida =
        "Entendido! Agradecemos o retorno e estamos à disposição caso precise no futuro. Tenha um ótimo dia!";
      await channel.send({
        tenantId,
        leadId,
        jobId: conversationId,
        seq: 1,
        conversationId,
        body: mensagemDespedida,
      });
      log.info("relevância comercial: despedida educada enviada antes do encerramento", {
        conversation_id: conversationId,
        lead_id: leadId,
      });
    } catch (err) {
      log.warn("relevância comercial: não foi possível enviar despedida ao lead", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2. Metadados de relevância
  const metadataRelevancia: EstadoRelevanciaConversa = {
    estado: "encerrado_sem_interesse",
    motivo_encerramento: motivo,
    encerrado_em: new Date().toISOString(),
    despedida_enviada: true,
  };

  // 3. Atualiza a conversa para status 'closed' com metadados
  await pool.query(
    `update conversations
        set status = 'closed',
            service_closed_at = now(),
            status_changed_at = now(),
            metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb)
      where organization_id = $1 and id = $2`,
    [tenantId, conversationId, CHAVE_RELEVANCIA_COMERCIAL, JSON.stringify(metadataRelevancia)],
  );

  // 4. Marca o lead como perdido no funil SOMENTE se for permitido (Item 4)
  if (permitirMoverParaPerda) {
    try {
      await applyLeadStateUpdate(
        pool,
        { tenantId, leadId, jobId: null },
        { stage: "lost", reason: "sem_interesse" },
      );
    } catch (err) {
      log.warn("relevância comercial: não foi possível atualizar lead_state para lost", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 5. Cancela follow-ups agendados
  try {
    const cancelados = await cancelPendingCronsForLead(pool, tenantId, leadId);
    if (cancelados > 0) {
      log.info("relevância comercial: follow-ups agendados cancelados", {
        cancelados,
        lead_id: leadId,
      });
    }
  } catch (err) {
    log.warn("relevância comercial: erro ao cancelar crons de follow-up", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info("relevância comercial: atendimento encerrado com sucesso por falta de interesse", {
    conversation_id: conversationId,
    lead_id: leadId,
    motivo,
  });
}

/**
 * Reabre a conversa quando o lead envia uma solicitação comercial explícita
 * após ter sido encerrado anteriormente.
 */
export async function executarReaberturaComercial(
  pool: pg.Pool,
  deps: {
    tenantId: string;
    leadId: string;
    conversationId: string;
    log: RelevanciaLogger;
  },
): Promise<void> {
  const { tenantId, leadId, conversationId, log } = deps;

  const metadataRelevancia: EstadoRelevanciaConversa = {
    estado: "ativo",
    reaberto_em: new Date().toISOString(),
    despedida_enviada: false,
  };

  await pool.query(
    `update conversations
        set status = 'open',
            service_closed_at = null,
            status_changed_at = now(),
            metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb)
      where organization_id = $1 and id = $2`,
    [tenantId, conversationId, CHAVE_RELEVANCIA_COMERCIAL, JSON.stringify(metadataRelevancia)],
  );

  log.info("relevância comercial: atendimento reaberto por solicitação comercial inequívoca", {
    conversation_id: conversationId,
    lead_id: leadId,
  });
}

/**
 * Registra a supressão de uma mensagem sem relevância comercial para auditoria.
 */
export async function gravarDecisaoDeSupressao(
  pool: pg.Pool,
  deps: {
    tenantId: string;
    conversationId: string;
    motivo: string;
    textoOriginal: string;
    log: RelevanciaLogger;
  },
): Promise<void> {
  const { tenantId, conversationId, motivo, textoOriginal, log } = deps;

  log.info("relevância comercial: turno suprimido — mensagem sem relevância comercial", {
    conversation_id: conversationId,
    motivo,
    resumo_texto: textoOriginal.slice(0, 80),
  });

  const supressao = {
    motivo,
    texto_resumido: textoOriginal.slice(0, 100),
    suprimido_em: new Date().toISOString(),
  };

  try {
    await pool.query(
      `update conversations
          set metadata = jsonb_set(
            coalesce(metadata, '{}'::jsonb),
            array[$3::text, 'ultima_supressao'],
            $4::jsonb,
            true
          )
        where organization_id = $1 and id = $2`,
      [tenantId, conversationId, CHAVE_RELEVANCIA_COMERCIAL, JSON.stringify(supressao)],
    );
  } catch (err) {
    log.warn("relevância comercial: falha ao registrar auditoria de supressão no metadata", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
