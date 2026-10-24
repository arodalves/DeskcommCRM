import { ehPedidoDeOptOut, ehOptOutProvavel } from "@/lib/opt-out/deteccao";
import { ehRespostaAutomatica, normalizarTexto } from "./resposta-automatica";
import { rodapeDeSaida } from "./rodape-de-saida";

/** Só retira o rodapé conhecido da saudação; não altera o detector de recusas. */
export function primeiraAbordagem(texto: string, locale?: string | null): string {
  const aviso = rodapeDeSaida(locale);
  let corpo = texto.trim();
  while (corpo.toLowerCase().endsWith(aviso.toLowerCase())) {
    corpo = corpo.slice(0, -aviso.length).trimEnd();
  }
  if (!corpo) throw new Error("Saudação de prospecção vazia.");
  return corpo;
}

export function temAvisoDeSaida(texto: string): boolean {
  const t = normalizarTexto(texto);
  return (
    /(?:se|caso) (?:voce )?(?:preferir|prefira|quiser|queira) nao receber (?:mais |novos |novas )?(?:contatos|mensagens).{0,90}(?:avisar|avise|dizer|diga)/u.test(
      t,
    ) || /(?:rather not receive|no queres recibir).{0,90}(?:reply stop|responde baja)/u.test(t)
  );
}

/** Histórico em ordem decrescente, apenas da conversa da campanha. */
export function orientacaoDaSequencia(
  mensagens: Array<{ direction: string; body: string | null; status?: string }>,
): string {
  const ultima = mensagens.find((m) => m.direction === "inbound")?.body?.trim();
  if (!ultima)
    return "\nAguarde uma resposta humana antes da apresentação comercial e do aviso de saída.";
  if (
    ehPedidoDeOptOut(ultima) ||
    ehOptOutProvavel(ultima) ||
    (!ehRespostaAutomatica(ultima) &&
      /\b(sem interesse|nao (?:temos|tenho|quero) interesse)\b/u.test(normalizarTexto(ultima)))
  ) {
    return "\nRecusa ou pedido de saída: respeite imediatamente, não venda, não faça apresentação, não insista e não agende novos contatos. Preserve os bloqueios e encaminhamentos de opt-out do sistema.";
  }
  if (ehRespostaAutomatica(ultima))
    return "\nMensagem automática não é resposta humana: não antecipe a apresentação comercial nem o aviso de saída.";
  const avisoEnviado = mensagens.some(
    (m) =>
      m.direction === "outbound" &&
      ["sent", "delivered", "read"].includes(m.status ?? "") &&
      temAvisoDeSaida(m.body ?? ""),
  );
  return avisoEnviado
    ? "\nJá existe aviso de saída nesta conversa, inclusive se veio na abordagem antiga. Não repita esse aviso. Se ainda não se apresentou, apresente sua identidade real e o motivo comercial com transparência, respeitando qualquer recusa. Nunca peça um comando artificial."
    : "\nApós esta resposta humana, antes de qualificar ou vender, apresente-se com o nome e a empresa reais da configuração do agente e informe o motivo comercial definido pelo operador. Ofereça uma única vez uma saída natural: ‘Se preferir não receber novos contatos, pode me avisar.’ Não peça comando artificial. Não alegue consentimento nem interesse confirmado.";
}
