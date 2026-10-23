import { capabilitiesOf } from "@/lib/channels/capabilities";
import type { ChannelProvider } from "@/lib/channels/types";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { orientacaoDaSequencia } from "./sequencia-de-abordagem";
import { campaignConfigSchema } from "./schema";
import {
  classificarNivelAutomacao,
  ehBloqueioDeFornecedor,
  ehRespostaAutomatica,
  contarTentativasContraBot,
} from "./resposta-automatica";

/** Trusted operator criteria; scraped websites never become system instructions. */
export async function prospectingConversationContext(
  db: Queryable,
  org: string,
  conversationId: string,
  agentId?: string,
  channelSessionId?: string,
) {
  if (!agentId || !channelSessionId) return "";
  const { rows } = await db.query<{ config: unknown; provider: ChannelProvider }>(
    `select c.config, s.provider from prospecting_candidates p
     join prospecting_campaigns c on c.organization_id=p.organization_id and c.id=p.campaign_id
     join conversations v on v.organization_id=p.organization_id and v.id=p.conversation_id and v.contact_id=p.contact_id
     join channel_sessions s on s.organization_id=v.organization_id and s.id=v.channel_session_id and s.archived_at is null
     join messages initial on initial.organization_id=p.organization_id and initial.id=p.message_id and initial.conversation_id=v.id
     where p.organization_id=$1 and p.conversation_id=$2 and p.status='sent'
       and initial.status in ('sent','delivered','read')
       and c.config->>'agent_id'=$3 and c.config->>'channel_session_id'=$4
       and s.id::text=$4 limit 1`,
    [org, conversationId, agentId, channelSessionId],
  );
  const parsed = campaignConfigSchema.safeParse(rows[0]?.config);
  if (!parsed.success) return "";
  const c = parsed.data;
  if (c.agent_id !== agentId || c.channel_session_id !== channelSessionId) return "";
  if (!rows[0]?.provider || !capabilitiesOf(rows[0].provider).freeformOutsideWindow) return "";

  // Inspecionar mensagens recentes da conversa para detectar nível de automação e prevenção de loops
  let orientacaoAutomacao = "";
  try {
    const msgsRes = await db.query<{ direction: string; body: string | null; status: string }>(
      "select direction, body, status from messages where organization_id=$1 and conversation_id=$2 and (direction='inbound' or status in ('sent','delivered','read')) order by created_at desc, id desc limit 10",
      [org, conversationId],
    );
    const msgs = msgsRes.rows || [];
    // O aviso pode estar fora das dez mensagens recentes (inclusive no envio legado).
    // A consulta devolve no máximo uma linha e não traz o histórico inteiro ao modelo.
    const avisoAnterior = await db.query<{
      direction: string;
      body: string | null;
      status: string;
    }>(
      "select direction, body, status from messages where organization_id=$1 and conversation_id=$2 and direction='outbound' and status in ('sent','delivered','read') and (body ilike '%receber%' or body ilike '%reply%' or body ilike '%recibir%')",
      [org, conversationId],
    );
    orientacaoAutomacao = orientacaoDaSequencia([...msgs, ...avisoAnterior.rows]);
    const lastInbound = msgs.find((m) => m.direction === "inbound");

    if (lastInbound && lastInbound.body) {
      const nivel = classificarNivelAutomacao(lastInbound.body);
      const bloqueioFornecedor = ehBloqueioDeFornecedor(lastInbound.body);
      const tentativasContraBot = contarTentativasContraBot(msgs.slice().reverse());

      if (ehRespostaAutomatica(lastInbound.body)) {
        if (tentativasContraBot >= 1) {
          if (nivel === 1) {
            orientacaoAutomacao += `\n\n[ORIENTAÇÃO SITUACIONAL - NÍVEL 1 (AGUARDANDO HUMANO)]: Você já registrou sua apresentação e solicitação anteriormente. A empresa enviou outra mensagem automática/de espera. NÃO envie nova mensagem, NÃO repita a solicitação, NÃO encerre a conversa e NÃO considere recusa comercial. Apenas aguarde o retorno de uma pessoa real.`;
          } else {
            orientacaoAutomacao += `\n\n[ORIENTAÇÃO SITUACIONAL ANTI-LOOP]: O sistema da empresa repetiu menu/bloqueio automático e você JÁ realizou 1 tentativa de contato com uma pessoa. Conforme a regra de limite contra loops, NÃO insista, NÃO envie novas mensagens e NÃO fique em loop com o bot.`;
          }
        } else if (bloqueioFornecedor) {
          orientacaoAutomacao += `\n\n[ORIENTAÇÃO SITUACIONAL - BLOQUEIO DE FORNECEDORES]: Foi recebida resposta automática de recusa a fornecedores/parcerias. Isso NÃO é recusa humana e não desqualifica o prospect. Faça no máximo 1 tentativa curta esclarecendo que não é fornecimento e pedindo contato com o comercial.`;
        } else if (nivel === 3) {
          orientacaoAutomacao += `\n\n[ORIENTAÇÃO SITUACIONAL - NÍVEL 3 (AUTOMAÇÃO COMERCIAL)]: Foi detectado atendimento automatizado/coleta de dados pela empresa. NÃO tente vender bot de WhatsApp. Ao conseguir falar com uma pessoa real, investigue o processo posterior com a pergunta de referência: "Vi que vocês já usam um atendimento automatizado por aqui. Minha dúvida é mais sobre o que acontece depois: quando alguém pede orçamento e não decide naquele momento, vocês têm algum acompanhamento estruturado ou isso fica mais com o atendimento do dia a dia?"`;
        } else if (nivel === 2) {
          orientacaoAutomacao += `\n\n[ORIENTAÇÃO SITUACIONAL - NÍVEL 2 (MENU BÁSICO)]: Foi recebido menu ou opções de setor. Escolha a opção de atendimento/comercial/gestão/outros assuntos para chegar a uma pessoa real. Respeite o limite de 1 tentativa em caso de bloqueio.`;
        } else if (nivel === 1) {
          orientacaoAutomacao += `\n\n[ORIENTAÇÃO SITUACIONAL - NÍVEL 1 (BOAS-VINDAS / AUSÊNCIA / ESPERA)]: A empresa enviou resposta automática de boas-vindas, ausência, espera ou solicitou deixar uma mensagem/solicitação. Isso NÃO é recusa comercial e NÃO encerra a prospecção. Responda no máximo 1 única vez de forma breve e cordial: peça para falar com uma pessoa e diga que fica no aguardo quando estiverem disponíveis. Não faça a apresentação comercial nem ofereça o aviso de saída para uma resposta automática. NÃO encerre a conversa, NÃO qualifique ou desqualifique, NÃO considere rejeição e NÃO envie novas mensagens até uma pessoa real responder.`;
        }
      }
    }
  } catch {
    // Sem histórico confiável, não inferir resposta humana nem repetir apresentação.
    orientacaoAutomacao =
      "\nNão faça apresentação comercial sem confirmar resposta humana no histórico. Não repita avisos de saída já enviados.";
  }

  return `\n\nEsta conversa veio de uma campanha de prospecção. Objetivo definido pelo operador: ${c.instruction}\nCritérios de qualificação a confirmar com a pessoa: ${c.qualification}\nConverse naturalmente, uma pergunta por vez. Uma empresa encontrada na pesquisa ainda não é um cliente qualificado. Registre o que a pessoa confirmar, sem inventar necessidade, orçamento ou interesse. Só depois de confirmar os critérios, use as ferramentas disponíveis para mover o negócio do funil ${c.pipeline_id} para a etapa ${c.qualified_stage_id}. Explique a evidência no registro. Se faltar informação, continue qualificando. Respeite recusa, opt-out e intervenção humana; não prometa condições fora da política do agente.${orientacaoAutomacao}`;
}
