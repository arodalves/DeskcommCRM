/** Corrige só a saudação inicial; texto gerado ou guardado na fila não é relógio. */
export function saudacaoNoEnvio(texto: string, agora: Date | null): string {
  let saudacao = "Olá!";
  try {
    if (agora && Number.isFinite(agora.getTime())) {
      const hora = Number(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "America/Sao_Paulo",
          hour: "2-digit",
          hourCycle: "h23",
        }).format(agora),
      );
      if (Number.isInteger(hora) && hora >= 0 && hora < 24) {
        const periodo =
          hora >= 5 && hora < 12 ? "bom dia" : hora >= 12 && hora < 18 ? "boa tarde" : "boa noite";
        saudacao = `Olá, ${periodo}!`;
      }
    }
  } catch {
    // Sem um horário confiável, não inventa um período do dia.
  }
  return texto.replace(
    /^(\s*)(?:(?:olá|ola|oi)[ \t]*[,!.:]?[ \t]*)?(?:bom dia|boa tarde|boa noite)\b(?:[ \t]*[!?.:])?/iu,
    (_abertura, espacos: string) => espacos + saudacao,
  );
}
