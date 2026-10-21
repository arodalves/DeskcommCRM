/**
 * Detecção e classificação comportamental de automação em prospecção:
 *
 * NÍVEL 0 — Sem automação aparente (Atendimento humano normal).
 * NÍVEL 1 — Resposta automática simples (ausência, horário, "retornaremos em breve", boas-vindas).
 * NÍVEL 2 — Menu/chatbot básico (escolha de setor, opções 1-9, orçamento/financeiro/outros assuntos).
 * NÍVEL 3 — Automação comercial aparente (coleta estruturada de dados, qualificação, agendamento por bot).
 * NÍVEL 4 — Operação comercial madura (confirmada por humano: CRM + follow-up estruturado).
 *
 * REGRAS:
 * 1. Resposta de bot nunca conta como resposta humana.
 * 2. Bot nunca deve, sozinho, qualificar ou desqualificar definitivamente o prospect.
 * 3. Não mover estágio por conclusão baseada apenas em mensagem automática.
 * 4. Não armar "conversa interrompida" devido a interação somente com bot.
 * 5. Não criar loops tentando atravessar chatbot (limite de 1 tentativa).
 * 6. Se um bot bloquear fornecedores/parcerias, fazer no máximo 1 tentativa.
 * 7. Se continuar bloqueando, encerrar sem insistência.
 * 8. Se uma pessoa real recusar, respeitar imediatamente.
 */

export type NivelAutomacao = 0 | 1 | 2 | 3;

export function normalizarTexto(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "");
}

/**
 * Detecta se a mensagem é um bloqueio automático a fornecedores ou parcerias.
 */
export function ehBloqueioDeFornecedor(texto: string | null | undefined): boolean {
  if (!texto || typeof texto !== "string") return false;
  const limpo = normalizarTexto(texto);

  return (
    /nao (estamos )?(contratando|aceitando|recebendo|procurando|aceitamos) (novos? )?(fornecedor|fornecedores|parceir|parceria|parcerias)|nao (temos|ha) interesse em (novos? )?(fornecedor|fornecedores|parceir|parceria|parcerias)/.test(
      limpo,
    ) ||
    /nao aceitamos (propostas? (de |com )?)?(novos? )?(fornecedor|fornecedores|parceir|parceria|parcerias)|nao temos interesse em (novos? )?(parceir|parceria|parcerias|fornecedor|fornecedores)/.test(
      limpo,
    )
  );
}

/**
 * Classifica o nível de automação aparente da mensagem.
 */
export function classificarNivelAutomacao(texto: string | null | undefined): NivelAutomacao {
  if (!texto || typeof texto !== "string") return 0;
  const limpo = normalizarTexto(texto);

  // NÍVEL 3 — Automação comercial aparente
  // Coleta estruturada de informações para projeto/orçamento, qualificação automatizada, agendamento por bot
  if (
    /para (agilizar|iniciar|solicitar|montar|enviar) (o |seu )?orcamento/.test(limpo) ||
    /qual (o |seu )?(tipo de movel|ambiente|prazo|cidade)|ja possui (projeto|medidas)/.test(limpo) ||
    /informe (os seguintes dados|seu nome completo e (telefone|cidade)|os dados do projeto)/.test(limpo) ||
    /(assistente virtual|bot).*(coletar|dados|orcamento|agendar|projeto)/.test(limpo) ||
    /agendar (uma )?(visita|visita tecnica|atendimento presencial)/.test(limpo)
  ) {
    return 3;
  }

  // NÍVEL 2 — Menu / chatbot básico
  // Roteamento por departamentos, opções numéricas, bot de triagem ou bloqueio a fornecedores
  if (
    /(escolha|digite|selecione) uma opcao|(digite|envie) [1-9]|^\s*1\s*[-–.)]/m.test(limpo) ||
    ehBloqueioDeFornecedor(texto) ||
    (/(comercial|vendas|orcamento|financeiro|rh|recursos humanos|atendimento|outros assuntos)/.test(limpo) &&
      /(digite|opcao|setor|departamento|menu)/.test(limpo))
  ) {
    return 2;
  }

  // NÍVEL 1 — Resposta automática simples
  // Ausência, horário de atendimento, retorno em breve, boas-vindas padronizadas
  if (
    /nao estamos disponiveis|indisponivel|fora do horario|horario de atendimento|estamos ausentes/.test(limpo) ||
    /retornaremos.*breve|o mais breve possivel|assim que possivel retornaremos|logo retornaremos/.test(limpo) ||
    /deixe (seu nome|sua solicitacao|sua mensagem|seu recado)/.test(limpo) ||
    (/agradece(mos)? (pelo |o |seu )?contato|obrigad[ao] pel[oe] (seu )?contato/.test(limpo) &&
      /retornaremos|breve|atendimento|responder/.test(limpo)) ||
    /mensagem automatica|resposta automatica|atendimento automatico|atendimento eletronico|assistente virtual/.test(limpo)
  ) {
    return 1;
  }

  // NÍVEL 0 — Sem automação aparente (humano normal)
  return 0;
}

/**
 * Retorna true se a mensagem for identificada como automática (Níveis 1, 2 ou 3).
 * Garante que respostas automáticas nunca contem como humanas nos guards e follow-ups.
 */
export function ehRespostaAutomatica(texto: string | null | undefined): boolean {
  if (!texto || typeof texto !== "string") return false;
  return classificarNivelAutomacao(texto) > 0 || ehBloqueioDeFornecedor(texto);
}

/**
 * Detecta quantas tentativas o agente já realizou contra bots/menus sem resposta humana.
 * Limite de segurança anti-loop: máximo 1 tentativa.
 *
 * REGRA ESTRUTURAL:
 * - A mensagem de abordagem fria inicial (enviada ANTES de qualquer contato do bot)
 *   NUNCA é uma tentativa contra bot.
 * - Somente mensagens outbound enviadas APÓS o primeiro contato com um bot (e antes
 *   de qualquer resposta humana posterior) contam como tentativas contra bot.
 * - Resposta humana real (Nível 0) zera o histórico de tentativas contra bot.
 */
export function contarTentativasContraBot(
  mensagens: Array<{ direction: string; body?: string | null }>,
): number {
  if (!mensagens || mensagens.length === 0) return 0;

  // 1. Encontrar o índice da última resposta humana real (Nível 0)
  let ultimoHumanoIndex = -1;
  for (let i = 0; i < mensagens.length; i++) {
    const msg = mensagens[i];
    if (msg && msg.direction === "inbound" && !ehRespostaAutomatica(msg.body)) {
      ultimoHumanoIndex = i;
    }
  }

  // 2. Após o último humano, encontrar o primeiro contato com bot/resposta automática
  let primeiroBotIndex = -1;
  for (let i = ultimoHumanoIndex + 1; i < mensagens.length; i++) {
    const msg = mensagens[i];
    if (msg && msg.direction === "inbound" && ehRespostaAutomatica(msg.body)) {
      primeiroBotIndex = i;
      break;
    }
  }

  // Se nenhum bot foi recebido após a última interação humana, não há tentativa contra bot
  if (primeiroBotIndex === -1) {
    return 0;
  }

  // 3. Contar quantas mensagens outbound foram enviadas APÓS o primeiro contato com o bot
  let tentativas = 0;
  for (let i = primeiroBotIndex + 1; i < mensagens.length; i++) {
    const msg = mensagens[i];
    if (msg && msg.direction === "outbound") {
      tentativas++;
    }
  }

  return tentativas;
}
