/**
 * CLASSIFICADOR DE RELEVÂNCIA COMERCIAL
 *
 * Separa intenção comercial legítima de ruído social, recusas, contatos acidentais,
 * mensagens religiosas, correntes, figurinhas e despedidas.
 *
 * Princípios:
 * 1. Determinístico e imune a alucinação de modelo.
 * 2. Normalização fonética/ortográfica antes da avaliação.
 * 3. Precedência comercial: se houver pergunta ou solicitação comercial genuína,
 *    ela prevalece sobre saudações sociais anexas ("bom dia, quanto custa o plano?").
 * 4. Recusa e contato acidental NÃO são opt-out (não gravam bloqueio LGPD/is_blocked).
 */

import { normalizarTexto } from "@/lib/opt-out/deteccao";

// Re-exporta a normalização canônica para consistência
export { normalizarTexto };

/**
 * Padrões de contato acidental ou recusa expressa de interesse comercial.
 * Não são pedidos de descadastro/STOP, mas manifestações claras de que
 * a pessoa não tem intenção de compra ou entrou por engano.
 */
const PADROES_CONTATO_ACIDENTAL: readonly RegExp[] = [
  /\b(?:entrei|foi|cliquei|mandei|liguei|chamei|enviei|mensagem|msg)\s+por\s+engano\b/u,
  /\bfoi\s+engano\b/u,
  /\b(?:desculpe|desculpa|perdao|perdoe|opa)\b.*\bengano\b/u,
  /\bengano\b.*\b(?:desculpe|desculpa|perdao|perdoe|opa)\b/u,
  /\b(?:e\s+)?numero\s+(?:errado|trocado)\b/u,
  /\bnao\s+era\s+(?:pra|para)\s+(?:ca|aqui|voce|voces)\b/u,
  /\bcliquei\s+sem\s+querer\b/u,
  /\bfoi\s+sem\s+querer\b/u,
  /\bentrei\s+sem\s+querer\b/u,
  /\bmensagem\s+errada\b/u,
  /\bconversa\s+errada\b/u,
  /\bnao\s+era\s+com\s+voce\b/u,
  /\bengano\s+meu\b/u,
];

const PADROES_SEM_INTERESSE: readonly RegExp[] = [
  /\bnao\s+(?:tenho|temos|estou\s+com|estou)\s+(?:nenhum\s+)?interesse\b/u,
  /\bsem\s+interesse\b/u,
  /\bnao\s+(?:me\s+)?interessa\b/u,
  /\bnao\s+(?:estou|to|estamos)\s+interessad[oa]s?\b/u,
  /\bnao\s+quero\s+(?:comprar|nada|o\s+produto|saber|contratar|fechar|esse|essa|isto|isso)\b/u,
  /\bnao\s+(?:pretendo|vou)\s+comprar\b/u,
  /\bnao\s+estou\s+procurando\s+(?:nada|isso)\b/u,
  /\bnao\s+preciso\s+(?:de\s+nada|nao|disso|desse|dessa|no\s+momento)?\b/u,
  /\b(?:agora|no\s+momento)\s+nao\s+(?:quero|tenho\s+interesse|preciso)\b/u,
  /\bfavor\s+nao\s+insistir\b/u,
  /\bpode\s+desconsiderar\b/u,
  /\bdesconsidere\s+(?:por\s+favor)?\b/u,
  /\bdispens[ao]\b/u,
];

/**
 * Padrões de solicitações comerciais inequívocas.
 * Quando presentes, indicam interesse comercial legítimo (inclusive para reabertura).
 */
const PADROES_COMERCIAIS: readonly RegExp[] = [
  // Preço, valores, custos e orçamentos
  /\b(?:quanto\s+custa|qual\s+(?:e\s+)?o\s+valor|qual\s+(?:e\s+)?o\s+preco|qual\s+valor|qual\s+preco|quanto\s+(?:fica|sai|e|custa)|orcamento|cotacao)\b/u,
  /\btabela\s+de\s+(?:precos?|valores?)\b/u,
  // Catálogo, produtos, modelos, serviços
  /\b(?:quais\s+(?:os\s+)?produtos|tem\s+catalogo|como\s+funciona|tem\s+(?:disponivel|pronta\s+entrega|em\s+estoque|vaga|horario)|voces\s+(?:vendem|trabalham\s+com|fazem|tem)|qual\s+(?:o\s+)?modelo)\b/u,
  // Intenção afirmativa de compra / contratação / agendamento
  /\b(?:quero\s+(?:comprar|contratar|fechar|adquirir|assinar|agendar|saber\s+mais)|gostaria\s+de\s+(?:comprar|contratar|agendar|saber\s+mais|conhecer)|como\s+faco\s+para\s+(?:comprar|pedir|contratar|adquirir)|tenho\s+interesse\s+em|mudei\s+de\s+ideia|ainda\s+(?:da\s+tempo|tem))\b/u,
  // Pagamento e entrega
  /\b(?:forma\s+de\s+pagamento|formas\s+de\s+pagamento|parcelamento|parcela|parcelas|aceit(?:a|am)\s+(?:cartao|cartoes|pix|boleto|transferencia|dinheiro)|paga\s+no\s+pix|quanto\s+e\s+o\s+frete|entrega\s+em|frete\s+para)\b/u,
  // Termos comerciais isolados mas inequívocos
  /\b(?:preco|precos|tabela|catalogo|orcamento|cotacao)\b/u,
];

/**
 * Padrões de suporte técnico, pós-venda e problemas de clientes ativos.
 * Devem ser preservados e nunca confundidos com falta de interesse.
 */
const PADROES_SUPORTE_OU_PROBLEMA: readonly RegExp[] = [
  /\b(?:nao\s+consigo\s+acessar|minha\s+conta|meu\s+login|esqueci\s+a\s+senha|problema\s+no\s+acesso|defeito|esta\s+com\s+defeito|quebrado|veio\s+errado|nao\s+funciona|problema\s+no|problema\s+com)\b/u,
  /\b(?:meu\s+pedido|rastreio|rastreamento|onde\s+esta\s+meu\s+pedido|atrasou|reclamacao|reclamar|troca|devolucao|estorno|garantia|suporte\s+tecnico|preciso\s+de\s+suporte|atendimento\s+ao\s+cliente|falar\s+com\s+suporte)\b/u,
  /\b(?:ajuda\s+com\s+meu|comprovante|pagamento\s+aprovado|ja\s+sou\s+cliente|minha\s+compra)\b/u,
];

/**
 * Padrões de respostas humanas legítimas a uma abordagem de prospecção ativa.
 * Em prospecção (Gael), o contato responde à saudação inicial ou pergunta
 * quem está falando, sem que isso seja ruído a ser silenciado.
 */
const PADROES_RESPOSTA_HUMANA_PROSPECCAO: readonly RegExp[] = [
  // Identificação e curiosidade
  /\b(?:quem\s+(?:fala|e|ta\s+falando|e\s+voce|mandou|passou|seria)|com\s+quem\s+(?:eu\s+)?falo|de\s+onde\s+(?:fala|e|voce\s+e)|qual\s+(?:e\s+)?o\s+assunto|do\s+que\s+se\s+trata|pois\s+nao|diga|pode\s+falar)\b/u,
  // Saudações / status de acolhimento
  /\b(?:bom\s+dia|boa\s+tarde|boa\s+noite|ola|oi|opa|oie)\b/u,
  /\b(?:tudo\s+bem|tudo\s+bom|como\s+vai|tudo\s+certo|tudo\s+joia|tudo\s+tranquilo|beleza)\b/u,
];

/**
 * Padrões de mensagens puramente sociais, cortesias, despedidas, mensagens religiosas e correntes.
 */
const PADROES_SOCIAIS_ISOLADOS: readonly RegExp[] = [
  // Agradecimentos / cortesias simples
  /^(?:muito\s+)?(?:obrigad[oa]|valeu|grato|grata|brigad[oa]|de\s+nada|por\s+nada|disponha|beleza|blz|show|tranquilo|certo|combinado|ok|ta\s+bom|ta\s+ok|joia|maravilha|perfeito)[\s!.?]*$/u,
  /^(?:ok|certo|blz|beleza|show)\s+(?:obrigad[oa]|valeu)[\s!.?]*$/u,
  // Despedidas simples
  /^(?:tchau|adeus|ate\s+mais|ate\s+logo|ate\s+amanha|falou|flw|bom\s+descanso|bom\s+fim\s+de\s+semana|bom\s+final\s+de\s+semana|boa\s+semana)[\s!.?]*$/u,
  /^(?:otim[ao]|bom|boa)\s+(?:dia|tarde|noite|semana|fim\s+de\s+semana|final\s+de\s+semana)(?:\s+(?:a\s+todos|para\s+todos|para\s+voce|pra\s+voce))?[\s!.?]*$/u,
  // Bênçãos / expressões religiosas isoladas
  /^(?:amem|fica\s+com\s+deus|deus\s+(?:te\s+)?abencoe|vai\s+com\s+deus|a\s+paz\s+d[eo]\s+senhor|paz\s+de\s+deus|gracas\s+a\s+deus)[\s!.?]*$/u,
  // Saudações isoladas (quando não há pergunta comercial)
  /^(?:bom\s+dia|boa\s+tarde|boa\s+noite|ola|oi|opa|e\s+ai|oie|oii+)[\s!.?,]*$/u,
  /^(?:bom\s+dia|boa\s+tarde|boa\s+noite|ola|oi)[\s,]+(?:tudo\s+bem|como\s+vai|tudo\s+bom|como\s+esta)[\s!.?]*$/u,
];

const PADROES_CORRENTES_OU_RELIGIOSAS_LONGAS: readonly RegExp[] = [
  /\b(?:repasse\s+(?:essa|esta|para)|compartilhe\s+com\s+\d+|mande\s+para\s+\d+|corrente\s+de\s+oracao|nao\s+quebre\s+a\s+corrente)\b/u,
  /\b(?:fiqu?e?\s+com\s+deus|deus\s+abencoe\s+(?:seu\s+dia|sua\s+familia|voce)|tenha\s+um\s+dia\s+abencoado|em\s+nome\s+de\s+jesus)\b/u,
];

/**
 * Verifica se a mensagem expressa recusa comercial, ausência de interesse ou contato acidental.
 * Exemplo: "entrei por engano", "não tenho interesse", "foi engano".
 */
export function ehRecusaOuSemInteresse(texto: string): boolean {
  if (!texto || texto.trim() === "") return false;
  const norm = normalizarTexto(texto.trim());

  // Se for palavra única "engano"
  if (/^engano[\s!.?]*$/u.test(norm)) return true;

  const ehRecusa =
    PADROES_CONTATO_ACIDENTAL.some((rx) => rx.test(norm)) ||
    PADROES_SEM_INTERESSE.some((rx) => rx.test(norm));

  if (!ehRecusa) {
    return false;
  }

  // Se é uma recusa mas há uma pergunta ou solicitação comercial legítima anexa
  // Exemplo: "não tenho interesse no plano anual, quanto custa o mensal?"
  const temPerguntaComercialAnexa =
    /\b(?:quanto\s+custa|qual\s+(?:e\s+)?o\s+(?:valor|preco)|qual\s+valor|qual\s+preco|quanto\s+(?:fica|sai)|orcamento|cotacao|tem\s+outro|tabela\s+de)\b/u.test(
      norm,
    );

  if (temPerguntaComercialAnexa) {
    return false; // A solicitação comercial anexa prevalece sobre a recusa parcial
  }

  return true;
}

/**
 * Verifica se a mensagem contém uma solicitação comercial clara e inequívoca.
 * Exemplo: "quanto custa?", "qual o valor?", "quero comprar", "tem pronta entrega?".
 */
export function ehSolicitacaoComercialInequivoca(texto: string): boolean {
  if (!texto || texto.trim() === "") return false;
  const norm = normalizarTexto(texto.trim());

  // Negações diretas de compra/contratação sem pergunta posterior não são solicitação comercial
  if (
    /\bnao\s+(?:quero|vou|pretendo)\s+(?:comprar|contratar|fechar|adquirir)\b/u.test(
      norm,
    )
  ) {
    const temPergunta = /\b(?:quanto|qual|outro|outra|tem|mas)\b/u.test(norm);
    if (!temPergunta) return false;
  }

  return PADROES_COMERCIAIS.some((rx) => rx.test(norm));
}

/**
 * Verifica se a mensagem é um relato de suporte técnico, defeito ou problema de cliente.
 */
export function ehMensagemDeSuporteOuProblema(texto: string): boolean {
  if (!texto || texto.trim() === "") return false;
  const norm = normalizarTexto(texto.trim());
  return PADROES_SUPORTE_OU_PROBLEMA.some((rx) => rx.test(norm));
}

/**
 * Remove emojis e símbolos para comparação de mensagens sociais.
 */
function limparTextoParaComparacaoSocial(texto: string): string {
  const semEmojis = texto
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\u2600-\u27BF]/gu, "")
    .trim();
  return normalizarTexto(semEmojis);
}

/**
 * Verifica se a mensagem é composta apenas por emojis ou pontuação/espaço.
 */
export function ehApenasEmoji(texto: string): boolean {
  if (!texto || texto.trim() === "") return false;
  // Remove emojis, símbolos pictográficos e pontuação
  const semEmojis = texto
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\u2600-\u27BF]/gu, "")
    .replace(/[\s\p{Punctuation}\p{Symbol}]/gu, "");
  return semEmojis.length === 0;
}

/**
 * Verifica se uma mensagem é exclusivamente social, cortesia, despedida,
 * religiosa, figurinha ou corrente — sem solicitação comercial anexa.
 */
export function ehMensagemSocial(
  texto: string,
  opts?: { tipoMensagem?: string; temMidia?: boolean },
): boolean {
  // Figurinhas (stickers) são interações gráficas sem texto comercial
  if (opts?.tipoMensagem === "sticker") return true;

  const limpo = texto ? texto.trim() : "";

  // Se for apenas emoji (ex: "👍", "🙏", "☕", "❤️")
  if (limpo !== "" && ehApenasEmoji(limpo)) return true;

  // Imagem sem texto é puramente social/anexo sem solicitação
  if ((opts?.tipoMensagem === "image" || opts?.temMidia) && limpo === "") {
    return true;
  }

  if (limpo === "") return false;

  // Se tiver solicitação comercial inequívoca ou suporte, NÃO é puramente social
  if (ehSolicitacaoComercialInequivoca(limpo) || ehMensagemDeSuporteOuProblema(limpo)) {
    return false;
  }

  const norm = normalizarTexto(limpo);
  const normSemEmoji = limparTextoParaComparacaoSocial(limpo);

  // Saudações, agradecimentos, despedidas isoladas
  if (
    PADROES_SOCIAIS_ISOLADOS.some((rx) => rx.test(norm) || rx.test(normSemEmoji))
  ) {
    return true;
  }

  // Correntes ou mensagens religiosas
  if (
    PADROES_CORRENTES_OU_RELIGIOSAS_LONGAS.some(
      (rx) => rx.test(norm) || rx.test(normSemEmoji),
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Avalia se uma imagem possui contexto comercial legítimo para justificar
 * o processamento multimodal (visão paga) e a geração de resposta.
 *
 * @param caption Texto/legenda da imagem (ou mensagem que a acompanha)
 * @param historicoRecente Últimas mensagens da conversa
 */
export function imagemTemContextoComercial(
  caption: string | null | undefined,
  historicoRecente?: Array<{ direction: string; body: string }>,
): boolean {
  const texto = caption?.trim() ?? "";

  // Se a legenda tiver texto comercial inequívoco ou suporte, tem contexto
  if (ehSolicitacaoComercialInequivoca(texto) || ehMensagemDeSuporteOuProblema(texto)) {
    return true;
  }

  // Se for apenas saudação social ou vazio na legenda ("bom dia", "☕", etc.)
  if (texto === "" || ehMensagemSocial(texto)) {
    // Verifica se o histórico recente (últimas 3 mensagens) demonstra uma negociação
    // ativa onde o atendente pediu a imagem ou o cliente está comprando
    if (historicoRecente && historicoRecente.length > 0) {
      const ultimas = historicoRecente.slice(-3);
      const temSolicitacaoAtiva = ultimas.some(
        (m) =>
          m.direction === "outbound" &&
          /\b(?:comprovante|foto|imagem|anexo|mande|envie|print|mostre)\b/ui.test(m.body),
      );
      if (temSolicitacaoAtiva) return true;
    }
    // Sem solicitação ativa no histórico e sem legenda comercial: é imagem social (ex: bom-dia)
    return false;
  }

  // Se houver qualquer outro texto explicativo com mais de 3 palavras que não seja social
  const palavras = texto.split(/\s+/).filter(Boolean);
  if (palavras.length >= 3 && !ehMensagemSocial(texto)) {
    return true;
  }

  return false;
}

/**
 * Verifica se a mensagem é uma resposta humana típica de acolhimento ou identificação
 * em prospecção ativa (ex: "bom dia", "tudo bem?", "quem fala?", "quem é?").
 */
export function ehRespostaHumanaDeProspeccao(texto: string): boolean {
  if (!texto || texto.trim() === "") return false;
  const norm = normalizarTexto(texto.trim());
  return PADROES_RESPOSTA_HUMANA_PROSPECCAO.some((rx) => rx.test(norm));
}

/**
 * Verifica se a mensagem é um cumprimento inicial típico de abertura de atendimento.
 * Exemplo: "bom dia", "olá, tudo bem?", "boa tarde!".
 */
export function ehCumprimentoInicial(texto: string): boolean {
  if (!texto || texto.trim() === "") return false;
  const limpo = limparTextoParaComparacaoSocial(texto);
  return /^(?:bom\s+dia|boa\s+tarde|boa\s+noite|ola|oi|opa|oie|oii+)(?:[\s,]+(?:tudo\s+bem|como\s+vai|tudo\s+bom|como\s+esta))?[\s!.?]*$/u.test(
    limpo,
  );
}
