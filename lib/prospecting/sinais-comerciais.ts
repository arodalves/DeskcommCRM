import { ehRespostaAutomatica, normalizarTexto } from "./resposta-automatica";
import { ehRecusaOuSemInteresse } from "@/lib/agent-engine/relevancia/classificador";

/** Ausência de indício de bot não constitui confirmação humana. */
export function sinaisComerciais(texto: string | null | undefined) {
  const t = normalizarTexto(texto ?? "").trim();
  const automatica = ehRespostaAutomatica(texto);
  const recusaEducada =
    /^(?:nao[,!\s]+)?ja (?:tenho|temos) (?:alguem|quem (?:faz|cuida)|uma pessoa|um fornecedor|uma agencia)[^?]*\b(?:obrigad[oa]|agradeco|dispenso)\b(?:[.!\s]*(?:ok|tudo bem))?[.!\s]*$/.test(
      t,
    ) && !/\b(?:mas|porem|integr|automat|gostaria|quero|pode|quanto)\b/.test(t);
  const recusa = !automatica && (ehRecusaOuSemInteresse(texto ?? "") || recusaEducada);
  const interesse =
    !automatica &&
    !recusa &&
    /\b(?:tenho interesse|temos interesse|quero (?:conhecer|contratar|entender)|pode(?:m)? (?:me )?(?:enviar (?:uma )?(?:proposta|mais detalhes|informacoes)|explicar (?:a integracao|a solucao))|me apresente melhor o que tem a nos oferecer|quanto custa|qual (?:o )?(?:valor|preco)|como funciona|precisamos integrar)\b/.test(
      t,
    );
  const humanaInferida =
    !automatica &&
    t.length > 0 &&
    (recusa ||
      interesse ||
      /\b(?:sou (?:a|o)|me chamo|ja (?:temos|tenho|usamos|utilizamos)|nosso crm|nossa equipe)\b/.test(
        t,
      ));
  return {
    automatica,
    recusa,
    interesse,
    humanaInferida,
    revisar:
      !automatica &&
      !recusa &&
      !interesse &&
      /\bja (?:tenho|temos) (?:alguem|uma pessoa)\b/.test(t),
  };
}
