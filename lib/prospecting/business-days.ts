/**
 * Cálculo de dias úteis e janela de envio para prospecção e follow-up (Fluxalvo CRM).
 *
 * Janela padrão:
 * - Segunda a sexta-feira (dias úteis)
 * - 09:00 às 17:00
 * - Timezone: America/Sao_Paulo (UTC-3)
 */

export const FUSO_PADRAO_PROSPECCAO = "America/Sao_Paulo";
export const HORA_INICIO_PADRAO = 9;
export const HORA_FIM_PADRAO = 17;

export interface OpcoesDiasUteis {
  timezone?: string;
  inicioJanela?: number; // padrão 9 (09:00)
  fimJanela?: number; // padrão 17 (17:00)
}

export interface PartesDataFuso {
  year: number;
  month: number; // 1-12
  day: number;
  weekday: string; // 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'
  hour: number;
  minute: number;
  second: number;
}

export function getPartesNoFuso(data: Date, timezone: string = FUSO_PADRAO_PROSPECCAO): PartesDataFuso {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(data);
  const partMap: Record<string, string> = {};
  for (const p of parts) {
    partMap[p.type] = p.value;
  }
  const rawHour = parseInt(partMap.hour ?? "0", 10);
  return {
    year: parseInt(partMap.year ?? "1970", 10),
    month: parseInt(partMap.month ?? "1", 10),
    day: parseInt(partMap.day ?? "1", 10),
    weekday: partMap.weekday ?? "Mon",
    hour: rawHour === 24 ? 0 : rawHour,
    minute: parseInt(partMap.minute ?? "0", 10),
    second: parseInt(partMap.second ?? "0", 10),
  };
}

export function isFimDeSemana(weekday: string): boolean {
  return weekday === "Sat" || weekday === "Sun";
}

export function isDiaUtil(data: Date, timezone: string = FUSO_PADRAO_PROSPECCAO): boolean {
  const p = getPartesNoFuso(data, timezone);
  return !isFimDeSemana(p.weekday);
}

export function criarDataNoFuso(
  ano: number,
  mes: number,
  dia: number,
  hora: number,
  minuto: number,
  segundo: number,
  timezone: string = FUSO_PADRAO_PROSPECCAO,
): Date {
  const pad = (n: number) => String(n).padStart(2, "0");
  let d = new Date(`${ano}-${pad(mes)}-${pad(dia)}T${pad(hora)}:${pad(minuto)}:${pad(segundo)}-03:00`);
  const partes = getPartesNoFuso(d, timezone);
  if (partes.hour !== hora || partes.day !== dia) {
    const diffHours = hora - partes.hour;
    d = new Date(d.getTime() + diffHours * 3600000);
  }
  return d;
}

/**
 * Adiciona N dias úteis reais a partir de uma data base, respeitando rigorosamente
 * a janela de disparo das 09:00 às 17:00 de segunda a sexta no fuso America/Sao_Paulo.
 */
export function adicionarDiasUteis(
  dataBase: Date,
  diasUteis: number,
  opcoes?: OpcoesDiasUteis,
): Date {
  const tz = opcoes?.timezone ?? FUSO_PADRAO_PROSPECCAO;
  const horaInicio = opcoes?.inicioJanela ?? HORA_INICIO_PADRAO;
  const horaFim = opcoes?.fimJanela ?? HORA_FIM_PADRAO;

  let partes = getPartesNoFuso(dataBase, tz);
  let ano = partes.year;
  let mes = partes.month;
  let dia = partes.day;
  let hora = partes.hour;
  let minuto = partes.minute;
  let segundo = partes.second;

  // Normalização do ponto de partida para a janela permitida
  if (isFimDeSemana(partes.weekday)) {
    // Fim de semana cai na abertura do próximo dia útil (segunda 09:00)
    let d = criarDataNoFuso(ano, mes, dia, horaInicio, 0, 0, tz);
    while (!isDiaUtil(d, tz)) {
      d = new Date(d.getTime() + 86400000);
    }
    partes = getPartesNoFuso(d, tz);
    ano = partes.year;
    mes = partes.month;
    dia = partes.day;
    hora = horaInicio;
    minuto = 0;
    segundo = 0;
  } else if (hora < horaInicio) {
    // Antes das 09:00 em dia útil: começa às 09:00 do mesmo dia
    hora = horaInicio;
    minuto = 0;
    segundo = 0;
  } else if (hora >= horaFim) {
    // Após 17:00 em dia útil: passa para as 09:00 do PRÓXIMO dia útil
    let d = new Date(criarDataNoFuso(ano, mes, dia, horaInicio, 0, 0, tz).getTime() + 86400000);
    while (!isDiaUtil(d, tz)) {
      d = new Date(d.getTime() + 86400000);
    }
    partes = getPartesNoFuso(d, tz);
    ano = partes.year;
    mes = partes.month;
    dia = partes.day;
    hora = horaInicio;
    minuto = 0;
    segundo = 0;
  }

  // Avançar N dias úteis
  let dataAtual = criarDataNoFuso(ano, mes, dia, hora, minuto, segundo, tz);
  let diasRestantes = diasUteis;

  while (diasRestantes > 0) {
    dataAtual = new Date(dataAtual.getTime() + 86400000);
    const p = getPartesNoFuso(dataAtual, tz);
    if (!isFimDeSemana(p.weekday)) {
      diasRestantes--;
    }
  }

  // Garantir que os minutos e segundos permaneçam exatos dentro da janela
  const pFinal = getPartesNoFuso(dataAtual, tz);
  return criarDataNoFuso(pFinal.year, pFinal.month, pFinal.day, hora, minuto, segundo, tz);
}
