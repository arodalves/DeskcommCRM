import { PALAVRAS_DE_OPT_OUT } from "@/lib/opt-out/deteccao";

/** Texto de saída reutilizável. A saudação inicial não recebe este rodapé.
 * A sequência comercial é orientada por sequencia-de-abordagem.ts após resposta humana.
 * As palavras legadas seguem reconhecidas pelo detector para preservar opt-outs.
 */

/** A palavra que a pessoa responde, por idioma. */
const PALAVRA_POR_IDIOMA: Record<string, string> = {
  pt: "PARAR",
  // Medido no próprio detector: em espanhol a palavra que as plantillas
  // aprovadas pedem é BAJA, e ela está no conjunto por causa disso.
  es: "BAJA",
  en: "STOP",
};

const TEXTO_POR_IDIOMA: Record<string, (palavra: string) => string> = {
  pt: () => "Caso prefira não receber novos contatos, basta me avisar.",
  es: (p) => `Si no querés recibir más mensajes, respondé ${p}.`,
  en: (p) => `If you'd rather not receive these messages, reply ${p}.`,
};

function raiz(locale: string | null | undefined): string {
  const r = (locale ?? "").toLowerCase().split(/[-_]/)[0] ?? "";
  // Idioma desconhecido cai em português — o padrão do produto — em vez de
  // ficar sem rodapé. Não oferecer saída é o defeito que este módulo conserta.
  return r in TEXTO_POR_IDIOMA ? r : "pt";
}

/**
 * A palavra de saída para este idioma, garantida como reconhecível.
 *
 * Se o detector deixar de reconhecê-la, isto LANÇA em vez de mandar uma
 * promessa falsa: prometer uma saída que não funciona é pior que não prometer,
 * porque a pessoa responde, nada acontece, e ela conclui que foi ignorada.
 */
export function palavraDeSaida(locale?: string | null): string {
  const idioma = raiz(locale);
  const palavra = PALAVRA_POR_IDIOMA[idioma] ?? "PARAR";
  if (!PALAVRAS_DE_OPT_OUT.has(palavra.toLowerCase())) {
    throw new Error(
      `A palavra de saída "${palavra}" não é reconhecida por lib/opt-out/deteccao.ts. ` +
        "Oferecer uma saída que o detector não entende faz a pessoa pedir para sair e continuar recebendo.",
    );
  }
  return palavra;
}

/** O rodapé pronto, sem quebra de linha inicial. */
export function rodapeDeSaida(locale?: string | null): string {
  const idioma = raiz(locale);
  const monta = TEXTO_POR_IDIOMA[idioma] ?? TEXTO_POR_IDIOMA.pt!;
  return monta(palavraDeSaida(locale));
}

/**
 * Composição explícita de texto com saída; não é a composição da saudação inicial.
 *
 * Idempotente de propósito — se o texto do modelo já terminar com o rodapé (por
 * exemplo porque alguém pôs a instrução no prompt também), não duplica. Repetir
 * a mesma frase duas vezes na primeira mensagem parece defeito e custa a
 * primeira impressão.
 */
export function comSaida(texto: string, locale?: string | null): string {
  const rodape = rodapeDeSaida(locale);
  const corpo = texto.trimEnd();
  if (corpo.toLowerCase().endsWith(rodape.toLowerCase())) return corpo;
  return `${corpo}\n\n${rodape}`;
}
