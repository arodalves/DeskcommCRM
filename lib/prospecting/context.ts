import type { Queryable } from "@/lib/agent-engine/queue/queue";
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
) {
  const { rows } = await db.query<{ config: unknown }>(
    "select c.config from prospecting_candidates p join prospecting_campaigns c on c.organization_id=p.organization_id and c.id=p.campaign_id where p.organization_id=$1 and p.conversation_id=$2 and p.status in ('sending','sent') limit 1",
    [org, conversationId],
  );
  const parsed = campaignConfigSchema.safeParse(rows[0]?.config);
  if (!parsed.success) return "";
  const c = parsed.data;

  // Inspecionar mensagens recentes da conversa para detectar nível de automação e prevenção de loops
  let orientacaoAutomacao = "";
  try {
    const msgsRes = await db.query<{ direction: string; body: string | null }>(
      "select direction, body from messages where organization_id=$1 and conversation_id=$2 order by created_at desc limit 10",
      [org, conversationId],
    );
    const msgs = msgsRes.rows || [];
    const lastInbound = msgs.find((m) => m.direction === "inbound");

    if (lastInbound && lastInbound.body) {
      const nivel = classificarNivelAutomacao(lastInbound.body);
      const bloqueioFornecedor = ehBloqueioDeFornecedor(lastInbound.body);
      const tentativasContraBot = contarTentativasContraBot(msgs.slice().reverse());

      if (ehRespostaAutomatica(lastInbound.body)) {
        if (tentativasContraBot >= 1) {
          if (nivel === 1) {
            orientacaoAutomacao = `\n\n[ORIENTAÇÃO SITUACIONAL - NÍVEL 1 (AGUARDANDO HUMANO)]: Você já registrou sua apresentação e solicitação anteriormente. A empresa enviou outra mensagem automática/de espera. NÃO envie nova mensagem, NÃO repita a solicitação, NÃO encerre a conversa e NÃO considere recusa comercial. Apenas aguarde o retorno de uma pessoa real.`;
          } else {
            orientacaoAutomacao = `\n\n[ORIENTAÇÃO SITUACIONAL ANTI-LOOP]: O sistema da empresa repetiu menu/bloqueio automático e você JÁ realizou 1 tentativa de contato com uma pessoa. Conforme a regra de limite contra loops, NÃO insista, NÃO envie novas mensagens e NÃO fique em loop com o bot.`;
          }
        } else if (bloqueioFornecedor) {
          orientacaoAutomacao = `\n\n[ORIENTAÇÃO SITUACIONAL - BLOQUEIO DE FORNECEDORES]: Foi recebida resposta automática de recusa a fornecedores/parcerias. Isso NÃO é recusa humana e não desqualifica o prospect. Faça no máximo 1 tentativa curta esclarecendo que não é fornecimento e pedindo contato com o comercial.`;
        } else if (nivel === 3) {
          orientacaoAutomacao = `\n\n[ORIENTAÇÃO SITUACIONAL - NÍVEL 3 (AUTOMAÇÃO COMERCIAL)]: Foi detectado atendimento automatizado/coleta de dados pela empresa. NÃO tente vender bot de WhatsApp. Ao conseguir falar com uma pessoa real, investigue o processo posterior com a pergunta de referência: "Vi que vocês já usam um atendimento automatizado por aqui. Minha dúvida é mais sobre o que acontece depois: quando alguém pede orçamento e não decide naquele momento, vocês têm algum acompanhamento estruturado ou isso fica mais com o atendimento do dia a dia?"`;
        } else if (nivel === 2) {
          orientacaoAutomacao = `\n\n[ORIENTAÇÃO SITUACIONAL - NÍVEL 2 (MENU BÁSICO)]: Foi recebido menu ou opções de setor. Escolha a opção de atendimento/comercial/gestão/outros assuntos para chegar a uma pessoa real. Respeite o limite de 1 tentativa em caso de bloqueio.`;
        } else if (nivel === 1) {
          orientacaoAutomacao = `\n\n[ORIENTAÇÃO SITUACIONAL - NÍVEL 1 (BOAS-VINDAS / AUSÊNCIA / ESPERA)]: A empresa enviou resposta automática de boas-vindas, ausência, espera ou solicitou deixar uma mensagem/solicitação. Isso NÃO é recusa comercial e NÃO encerra a prospecção. Responda no máximo 1 única vez de forma breve e cordial: apresente-se como Xavier da Fluxalvo, registre sua solicitação (falar com o responsável comercial/atendimento sobre acompanhamento de orçamentos) e diga que fica no aguardo quando estiverem disponíveis. NÃO encerre a conversa, NÃO qualifique ou desqualifique, NÃO considere rejeição e NÃO envie novas mensagens até uma pessoa real responder.`;
        }
      }
    }
  } catch {
    // best-effort
  }

  return `\n\nEsta conversa veio de uma campanha de prospecção. Objetivo definido pelo operador: ${c.instruction}\nCritérios de qualificação a confirmar com a pessoa: ${c.qualification}\nConverse naturalmente, uma pergunta por vez. Uma empresa encontrada na pesquisa ainda não é um cliente qualificado. Registre o que a pessoa confirmar, sem inventar necessidade, orçamento ou interesse. Só depois de confirmar os critérios, use as ferramentas disponíveis para mover o negócio do funil ${c.pipeline_id} para a etapa ${c.qualified_stage_id}. Explique a evidência no registro. Se faltar informação, continue qualificando. Respeite recusa, opt-out e intervenção humana; não prometa condições fora da política do agente.${orientacaoAutomacao}`;
}
