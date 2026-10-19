/**
 * Modelo oficial: "Prospecção comercial — sem resposta" (Fluxalvo CRM).
 *
 * Cadência estrita:
 * 1. Follow-up 1: 2 dias úteis após o aceite real da primeira abordagem pelo canal.
 * 2. Follow-up 2: 4 dias úteis após o envio efetivo do Follow-up 1.
 * 3. Encerramento definitivo após Follow-up 2 (sem terceiro follow-up).
 *
 * Janela de envio: 09:00–17:00, segunda a sexta, America/Sao_Paulo.
 * Handoff terminal: qualquer intervenção humana cancela a inscrição imediatamente.
 * Funil intocado: não move etapa, não qualifica e não altera pipeline.
 */
import type { FlowGraph } from "@/lib/followup/graph-schema";
import type { TriggerConfig } from "@/lib/followup/api-schemas";

export const TEXTO_FOLLOWUP_1 =
  "Oi! Passando só para retomar minha mensagem anterior. Queria entender como vocês organizam hoje os contatos que chegam pelo WhatsApp e outros canais. Se fizer sentido, posso te mostrar rapidamente onde normalmente existem oportunidades de melhorar esse processo.";

export const TEXTO_FOLLOWUP_2 =
  "Oi! Faço um último contato por aqui para não ficar insistindo. Se melhorar atendimento, organização dos contatos ou conversão fizer sentido mais à frente, fico à disposição. Se preferir, encerro por aqui.";

export const GRAFO_PROSPECCAO_COMERCIAL: FlowGraph = {
  nodes: [
    {
      id: "inicio",
      type: "trigger",
      label: "Início (Aceite confirmado pelo provedor)",
      position: { x: 0, y: 0 },
      config: {},
    },
    {
      id: "espera-1",
      type: "wait",
      label: "Espera 2 dias úteis (09h-17h)",
      position: { x: 260, y: 0 },
      config: {
        mode: "business_days",
        days: 2,
        timezone: "America/Sao_Paulo",
        window_start_hour: 9,
        window_end_hour: 17,
      },
    },
    {
      id: "followup-1",
      type: "action",
      label: "Follow-up 1",
      position: { x: 520, y: 0 },
      config: {
        mode: "text",
        body: TEXTO_FOLLOWUP_1,
      },
    },
    {
      id: "espera-2",
      type: "wait",
      label: "Espera 4 dias úteis após Follow-up 1",
      position: { x: 780, y: 0 },
      config: {
        mode: "business_days",
        days: 4,
        timezone: "America/Sao_Paulo",
        window_start_hour: 9,
        window_end_hour: 17,
      },
    },
    {
      id: "followup-2",
      type: "action",
      label: "Follow-up 2 (Último contato)",
      position: { x: 1040, y: 0 },
      config: {
        mode: "text",
        body: TEXTO_FOLLOWUP_2,
      },
    },
    {
      id: "fim",
      type: "end",
      label: "Encerramento definitivo",
      position: { x: 1300, y: 0 },
      config: {
        outcome: "exhausted",
      },
    },
  ],
  edges: [
    {
      id: "e-inicio-espera1",
      source: "inicio",
      target: "espera-1",
      condition: { type: "always" },
      priority: 0,
    },
    {
      id: "e-espera1-fu1",
      source: "espera-1",
      target: "followup-1",
      condition: { type: "always" },
      priority: 0,
    },
    {
      id: "e-fu1-espera2",
      source: "followup-1",
      target: "espera-2",
      condition: { type: "always" },
      priority: 0,
    },
    {
      id: "e-espera2-fu2",
      source: "espera-2",
      target: "followup-2",
      condition: { type: "always" },
      priority: 0,
    },
    {
      id: "e-fu2-fim",
      source: "followup-2",
      target: "fim",
      condition: { type: "always" },
      priority: 0,
    },
  ],
};

export const MODELO_PROSPECCAO_COMERCIAL = {
  id: "prospeccao_comercial_sem_resposta",
  nome: "Prospecção comercial — sem resposta",
  jornada: "Prospecção fria",
  resumo:
    "Follow-up automático após a primeira mensagem da prospecção aceita pelo canal. 2 toques estritos em dias úteis.",
  oQueDispara: "Primeira abordagem aceita pelo provedor",
  pedeEtapa: false,
  handoffPolicy: "cancel" as const,
  gatilho: (): TriggerConfig => ({
    kind: "prospecting_initial_accepted",
    cancel_on_reply: true,
  }),
  grafo: GRAFO_PROSPECCAO_COMERCIAL,
};
