/**
 * Detecção de respostas automáticas, bots, menus e mensagens de ausência/indisponibilidade
 * em conversas de prospecção.
 *
 * Uma resposta identificada como automática:
 * - NÃO conta como resposta humana;
 * - NÃO qualifica o prospect;
 * - NÃO arme "Prospecção comercial — conversa interrompida";
 * - NÃO provoque follow-up enquanto estivermos aguardando atendimento humano;
 * - NÃO seja tratada como opt-out ou rejeição.
 */

export function normalizarTexto(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "");
}

export function ehRespostaAutomatica(texto: string | null | undefined): boolean {
  if (!texto || typeof texto !== "string") return false;
  const limpo = normalizarTexto(texto);

  // 1. Ausência, indisponibilidade, retorno em breve ou fora de horário
  if (
    /nao estamos disponiveis|indisponivel|fora do horario|horario de atendimento|estamos ausentes/.test(
      limpo,
    )
  ) {
    return true;
  }
  if (
    /retornaremos.*breve|o mais breve possivel|assim que possivel retornaremos|logo retornaremos/.test(
      limpo,
    )
  ) {
    return true;
  }
  if (
    /deixe (seu nome|sua solicitacao|sua mensagem|seu recado)/.test(limpo)
  ) {
    return true;
  }
  if (
    /agradece(mos)? (pelo |o |seu )?contato|obrigad[ao] pel[oe] (seu )?contato/.test(
      limpo,
    ) &&
    /retornaremos|breve|atendimento|responder/.test(limpo)
  ) {
    return true;
  }

  // 2. Bots, chatbots, menus numéricos, seleção de setores ou mensagens automáticas declaradas
  if (
    /mensagem automatica|resposta automatica|atendimento automatico|atendimento eletronico|assistente virtual/.test(
      limpo,
    )
  ) {
    return true;
  }
  if (
    /(escolha|digite|selecione) uma opcao|(digite|envie) [1-9]|^\s*1\s*[-–.)]/m.test(
      limpo,
    )
  ) {
    return true;
  }

  // 3. Respostas de bots/respostas rápidas recusando fornecedores ou parcerias
  if (
    /nao (estamos )?(contratando|aceitando|recebendo|procurando) (novos? )?(fornecedor|fornecedores|parceir|parceria)|nao (temos|ha) interesse em (novos? )?(fornecedor|fornecedores|parceir|parceria)/.test(
      limpo,
    )
  ) {
    return true;
  }

  return false;
}
