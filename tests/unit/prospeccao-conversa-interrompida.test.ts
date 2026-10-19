import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  adicionarDiasUteis,
} from "@/lib/prospecting/business-days";
import {
  assertProspectingFollowupPreconditions,
} from "@/lib/prospecting/guard";
import {
  aplicaGatilhoConversaInterrompida,
  verificarEEmitirConversaInterrompida,
  EVENTO_PROSPECCAO_CONVERSA_INTERROMPIDA,
} from "@/lib/followup/gatilho-prospeccao";
import { followupGatilhoProspeccaoHandler } from "@/lib/followup/gatilho-prospeccao.handler";
import type { EventRow } from "@/lib/event-log/dispatcher";

describe("Suite de Testes — Prospecção Comercial: Conversa Interrompida", () => {
  const ORG_ID = "85f13814-4358-4d0c-9242-aba35b35e6df";
  const CAMPAIGN_ID = "camp-1111-4111-8111-111111111111";
  const CANDIDATE_ID = "cand-1111-4111-8111-111111111111";
  const CONTACT_ID = "cont-1111-4111-8111-111111111111";
  const CONVERSATION_ID = "conv-1111-4111-8111-111111111111";
  const POINTER_ID = "point-1111-4111-8111-111111111111";
  const MSG_ID = "msg-1111-4111-8111-111111111111";

  const BASE_TIME = "2026-10-20T14:00:00.000Z"; // Terça-feira 14h UTC
  const ACTIVATION_TIME = "2026-10-19T10:00:00.000Z";

  it("1. conversa originada de prospecção com resposta do lead + nova mensagem do Xavier -> inscrição criada para 2 dias úteis", async () => {
    let insertedEnrollment: Record<string, unknown> | null = null;

    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "prospecting_campaigns") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: CAMPAIGN_ID,
                status: "running",
                activated_at: ACTIVATION_TIME,
                activation_version: 1,
              },
              error: null,
            }),
          };
        }
        if (table === "prospecting_exclusions") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            then: (resolve: (val: { data: unknown[]; error: null }) => unknown) =>
              resolve({ data: [], error: null }),
          };
        }
        if (table === "prospecting_candidates") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: CANDIDATE_ID,
                status: "sent",
                provider_accepted_at: "2026-10-19T12:00:00.000Z",
                conversation_id: CONVERSATION_ID,
                contact_id: CONTACT_ID,
                campaign_id: CAMPAIGN_ID,
              },
              error: null,
            }),
          };
        }
        if (table === "messages") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [{ id: "inbound-msg-1", created_at: "2026-10-19T15:00:00.000Z" }],
              error: null,
            }),
          };
        }
        if (table === "conversations") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                status: "open",
                last_inbound_at: "2026-10-19T15:00:00.000Z",
                last_outbound_at: BASE_TIME,
                assigned_to_user_id: null,
                bot_silenced_until: null,
              },
              error: null,
            }),
          };
        }
        if (table === "contacts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: CONTACT_ID,
                is_blocked: false,
                force_human: false,
                is_anonymized: false,
                consent: {},
              },
              error: null,
            }),
          };
        }
        if (table === "crm_leads") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { status: "lead" },
              error: null,
            }),
          };
        }
        if (table === "followup_flow_pointers") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            not: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: POINTER_ID,
                organization_id: ORG_ID,
                status: "active",
                active_version_id: "ver-1",
                surface: "followup",
              },
              error: null,
            }),
            then: (resolve: (val: { data: unknown[]; error: null }) => unknown) =>
              resolve({
                data: [
                  {
                    id: POINTER_ID,
                    organization_id: ORG_ID,
                    active_version_id: "ver-1",
                    name: "Prospecção comercial — conversa interrompida",
                    trigger_config: { kind: "prospecting_conversation_interrupted" },
                    status: "active",
                    surface: "followup",
                  },
                ],
                error: null,
              }),
          };
        }
        if (table === "followup_flow_versions") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                graph: {
                  nodes: [
                    {
                      id: "node_trigger",
                      type: "trigger",
                      label: "Início",
                      position: { x: 100, y: 50 },
                      config: {},
                    },
                    {
                      id: "node_wait_1",
                      type: "wait",
                      label: "Aguardar 2 dias úteis",
                      position: { x: 100, y: 150 },
                      config: {
                        mode: "business_days",
                        days: 2,
                        timezone: "America/Sao_Paulo",
                      },
                    },
                  ],
                  edges: [
                    {
                      id: "edge_trigger_to_wait1",
                      source: "node_trigger",
                      target: "node_wait_1",
                      priority: 0,
                      condition: { type: "always" },
                    },
                  ],
                },
              },
              error: null,
            }),
          };
        }
        if (table === "followup_enrollments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            insert: vi.fn((payload: Record<string, unknown>) => {
              insertedEnrollment = payload;
              return {
                select: vi.fn().mockReturnThis(),
                single: vi.fn().mockResolvedValue({
                  data: { id: "enr-1", ...payload },
                  error: null,
                }),
              };
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
      rpc: vi.fn().mockImplementation((fn: string, args: any) =>
        Promise.resolve({
          data: {
            organization_id: args?.p_org ?? ORG_ID,
            contact_id: args?.p_contact ?? CONTACT_ID,
            conversation_id: args?.p_conversation ?? CONVERSATION_ID,
            service_revision: 1,
            demanda_id: null,
            demanda_revision: null,
            status: "open",
            demanda_fechada_em: null,
          },
          error: null,
        }),
      ),
    } as unknown as SupabaseClient;

    const row: EventRow = {
      id: "evt-1",
      organization_id: ORG_ID,
      event_type: EVENTO_PROSPECCAO_CONVERSA_INTERROMPIDA,
      entity_kind: "prospecting_candidate",
      entity_id: CANDIDATE_ID,
      payload: {
        candidate_id: CANDIDATE_ID,
        campaign_id: CAMPAIGN_ID,
        contact_id: CONTACT_ID,
        conversation_id: CONVERSATION_ID,
        message_id: MSG_ID,
        sent_at: BASE_TIME,
        activation_version: 1,
      },
      metadata: {},
      consumed_by: [],
      attempts: 0,
      created_at: BASE_TIME,
    };

    const res = await aplicaGatilhoConversaInterrompida(
      { admin: mockAdmin, clock: () => new Date(BASE_TIME) },
      row,
    );

    expect(res.matched).toBe(true);
    expect(res.enrolled).toBe(1);
    expect(insertedEnrollment).not.toBeNull();
    expect(insertedEnrollment!.prospecting_candidate_id).toBe(CANDIDATE_ID);
    expect(insertedEnrollment!.prospecting_campaign_id).toBe(CAMPAIGN_ID);
    expect(insertedEnrollment!.prospecting_outbound_message_id).toBe(MSG_ID);
    expect(insertedEnrollment!.prospecting_last_outbound_at).toBe(BASE_TIME);

    // Follow-up 1 deve estar calculado para exatamente 2 dias úteis
    const dataEsperada = adicionarDiasUteis(new Date(BASE_TIME), 2);
    expect(insertedEnrollment!.next_eval_at).toBe(dataEsperada.toISOString());
  });

  it("2. prospect nunca respondeu -> não inscreve no fluxo de conversa interrompida (skip)", async () => {
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "prospecting_campaigns") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: CAMPAIGN_ID, status: "running", activated_at: ACTIVATION_TIME, activation_version: 1 },
              error: null,
            }),
          };
        }
        if (table === "prospecting_exclusions") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            then: (resolve: (val: { data: unknown[]; error: null }) => unknown) =>
              resolve({ data: [], error: null }),
          };
        }
        if (table === "prospecting_candidates") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: CANDIDATE_ID,
                status: "sent",
                provider_accepted_at: "2026-10-19T12:00:00.000Z",
                conversation_id: CONVERSATION_ID,
                contact_id: CONTACT_ID,
                campaign_id: CAMPAIGN_ID,
              },
              error: null,
            }),
          };
        }
        if (table === "messages") {
          // Nenhuma mensagem inbound anterior encontrada
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
    } as unknown as SupabaseClient;

    const row: EventRow = {
      id: "evt-2",
      organization_id: ORG_ID,
      event_type: EVENTO_PROSPECCAO_CONVERSA_INTERROMPIDA,
      entity_kind: "prospecting_candidate",
      entity_id: CANDIDATE_ID,
      payload: {
        candidate_id: CANDIDATE_ID,
        campaign_id: CAMPAIGN_ID,
        contact_id: CONTACT_ID,
        conversation_id: CONVERSATION_ID,
        message_id: MSG_ID,
        sent_at: BASE_TIME,
        activation_version: 1,
      },
      metadata: {},
      consumed_by: [],
      attempts: 0,
      created_at: BASE_TIME,
    };

    const res = await aplicaGatilhoConversaInterrompida(
      { admin: mockAdmin, clock: () => new Date(BASE_TIME) },
      row,
    );

    expect(res.matched).toBe(true);
    expect(res.enrolled).toBe(0);
    expect(res.skipped_existing).toBe(1);
  });

  it("3. contato protegido na lista de exclusões estruturais -> bloqueado (skipped_exclusion)", async () => {
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "prospecting_campaigns") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: CAMPAIGN_ID, status: "running", activated_at: ACTIVATION_TIME, activation_version: 1 },
              error: null,
            }),
          };
        }
        if (table === "prospecting_exclusions") {
          // Encontrada exclusão estrutural para o contato
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "excl-1",
                canonical_name: "Lead Protegido",
                reason: "manual_lead_protection",
              },
              error: null,
            }),
            then: (resolve: (val: { data: unknown[]; error: null }) => unknown) =>
              resolve({
                data: [
                  {
                    id: "excl-1",
                    canonical_name: "Lead Protegido",
                    reason: "manual_lead_protection",
                  },
                ],
                error: null,
              }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
    } as unknown as SupabaseClient;

    const row: EventRow = {
      id: "evt-3",
      organization_id: ORG_ID,
      event_type: EVENTO_PROSPECCAO_CONVERSA_INTERROMPIDA,
      entity_kind: "prospecting_candidate",
      entity_id: CANDIDATE_ID,
      payload: {
        candidate_id: CANDIDATE_ID,
        campaign_id: CAMPAIGN_ID,
        contact_id: CONTACT_ID,
        conversation_id: CONVERSATION_ID,
        message_id: MSG_ID,
        sent_at: BASE_TIME,
        activation_version: 1,
      },
      metadata: {},
      consumed_by: [],
      attempts: 0,
      created_at: BASE_TIME,
    };

    const res = await aplicaGatilhoConversaInterrompida(
      { admin: mockAdmin, clock: () => new Date(BASE_TIME) },
      row,
    );

    expect(res.matched).toBe(true);
    expect(res.enrolled).toBe(0);
    expect(res.skipped_exclusion).toBe(1);
  });

  it("4. campanha com versão diferente da ativação do evento -> anti-retroatividade descarta (skipped_retroactive)", async () => {
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "prospecting_campaigns") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: CAMPAIGN_ID,
                status: "running",
                activated_at: "2026-10-20T10:00:00.000Z",
                activation_version: 2, // Campanha reativada em versão 2
              },
              error: null,
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
    } as unknown as SupabaseClient;

    const row: EventRow = {
      id: "evt-4",
      organization_id: ORG_ID,
      event_type: EVENTO_PROSPECCAO_CONVERSA_INTERROMPIDA,
      entity_kind: "prospecting_candidate",
      entity_id: CANDIDATE_ID,
      payload: {
        candidate_id: CANDIDATE_ID,
        campaign_id: CAMPAIGN_ID,
        contact_id: CONTACT_ID,
        conversation_id: CONVERSATION_ID,
        message_id: MSG_ID,
        sent_at: BASE_TIME,
        activation_version: 1, // Evento originado da versão 1 antiga
      },
      metadata: {},
      consumed_by: [],
      attempts: 0,
      created_at: BASE_TIME,
    };

    const res = await aplicaGatilhoConversaInterrompida(
      { admin: mockAdmin, clock: () => new Date(BASE_TIME) },
      row,
    );

    expect(res.matched).toBe(true);
    expect(res.enrolled).toBe(0);
    expect(res.skipped_retroactive).toBe(1);
  });

  it("5. idempotência: se já existe inscrição ativa no mesmo pointer -> skipped_existing", async () => {
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "prospecting_campaigns") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: CAMPAIGN_ID, status: "running", activated_at: ACTIVATION_TIME, activation_version: 1 },
              error: null,
            }),
          };
        }
        if (table === "prospecting_exclusions") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            then: (resolve: (val: { data: unknown[]; error: null }) => unknown) =>
              resolve({ data: [], error: null }),
          };
        }
        if (table === "prospecting_candidates") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: CANDIDATE_ID,
                status: "sent",
                provider_accepted_at: "2026-10-19T12:00:00.000Z",
                conversation_id: CONVERSATION_ID,
                contact_id: CONTACT_ID,
                campaign_id: CAMPAIGN_ID,
              },
              error: null,
            }),
          };
        }
        if (table === "messages") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [{ id: "inbound-msg-1", created_at: "2026-10-19T15:00:00.000Z" }],
              error: null,
            }),
          };
        }
        if (table === "conversations") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                status: "open",
                last_inbound_at: "2026-10-19T15:00:00.000Z",
                last_outbound_at: BASE_TIME,
                assigned_to_user_id: null,
                bot_silenced_until: null,
              },
              error: null,
            }),
          };
        }
        if (table === "contacts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: CONTACT_ID, is_blocked: false, force_human: false, is_anonymized: false, consent: {} },
              error: null,
            }),
          };
        }
        if (table === "followup_flow_pointers") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            not: vi.fn().mockReturnThis(),
            then: (resolve: (val: { data: unknown[]; error: null }) => unknown) =>
              resolve({
                data: [
                  {
                    id: POINTER_ID,
                    organization_id: ORG_ID,
                    active_version_id: "ver-1",
                    name: "Prospecção comercial — conversa interrompida",
                    trigger_config: { kind: "prospecting_conversation_interrupted" },
                    status: "active",
                    surface: "followup",
                  },
                ],
                error: null,
              }),
          };
        }
        if (table === "followup_enrollments") {
          // Já existe enrollment ativo
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: "enr-existente", prospecting_outbound_message_id: MSG_ID },
              error: null,
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
    } as unknown as SupabaseClient;

    const row: EventRow = {
      id: "evt-5",
      organization_id: ORG_ID,
      event_type: EVENTO_PROSPECCAO_CONVERSA_INTERROMPIDA,
      entity_kind: "prospecting_candidate",
      entity_id: CANDIDATE_ID,
      payload: {
        candidate_id: CANDIDATE_ID,
        campaign_id: CAMPAIGN_ID,
        contact_id: CONTACT_ID,
        conversation_id: CONVERSATION_ID,
        message_id: MSG_ID,
        sent_at: BASE_TIME,
        activation_version: 1,
      },
      metadata: {},
      consumed_by: [],
      attempts: 0,
      created_at: BASE_TIME,
    };

    const res = await aplicaGatilhoConversaInterrompida(
      { admin: mockAdmin, clock: () => new Date(BASE_TIME) },
      row,
    );

    expect(res.matched).toBe(true);
    expect(res.enrolled).toBe(0);
    expect(res.skipped_existing).toBe(1);
  });

  it("6. pré-condição antes do envio: prospect respondeu após a mensagem que originou o follow-up -> cancela (terminal)", async () => {
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_enrollments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "enr-1",
                organization_id: ORG_ID,
                contact_id: CONTACT_ID,
                conversation_id: CONVERSATION_ID,
                status: "active",
                pointer_id: POINTER_ID,
                prospecting_candidate_id: CANDIDATE_ID,
                prospecting_campaign_id: CAMPAIGN_ID,
                prospecting_accepted_at: "2026-10-19T12:00:00.000Z",
                prospecting_last_outbound_at: BASE_TIME,
                started_at: BASE_TIME,
              },
              error: null,
            }),
          };
        }
        if (table === "followup_flow_pointers") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                name: "Prospecção comercial — conversa interrompida",
                trigger_config: { kind: "prospecting_conversation_interrupted" },
              },
              error: null,
            }),
          };
        }
        if (table === "prospecting_candidates") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: CANDIDATE_ID,
                organization_id: ORG_ID,
                campaign_id: CAMPAIGN_ID,
                contact_id: CONTACT_ID,
                conversation_id: CONVERSATION_ID,
                status: "sent",
                provider_accepted_at: "2026-10-19T12:00:00.000Z",
                activation_version: 1,
              },
              error: null,
            }),
          };
        }
        if (table === "prospecting_exclusions") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            then: (resolve: (val: { data: unknown[]; error: null }) => unknown) =>
              resolve({ data: [], error: null }),
          };
        }
        if (table === "prospecting_campaigns") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { status: "running", activated_at: ACTIVATION_TIME, activation_version: 1 },
              error: null,
            }),
          };
        }
        if (table === "contacts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { is_blocked: false, force_human: false, is_anonymized: false, consent: {} },
              error: null,
            }),
          };
        }
        if (table === "conversations") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                status: "open",
                last_inbound_at: "2026-10-21T10:00:00.000Z", // Respondeu DEPOIS da mensagem do Xavier (BASE_TIME = 2026-10-20T14:00:00Z)
                assigned_to_user_id: null,
                bot_silenced_until: null,
              },
              error: null,
            }),
          };
        }
        if (table === "messages") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [{ id: "msg-inbound-prior", created_at: "2026-10-19T14:00:00.000Z" }],
              error: null,
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
    } as unknown as SupabaseClient;

    const check = await assertProspectingFollowupPreconditions(mockAdmin, {
      organizationId: ORG_ID,
      enrollmentId: "enr-1",
      candidateId: CANDIDATE_ID,
      isConversaInterrompida: true,
    });

    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.terminal).toBe(true);
      expect(check.reason).toContain("já respondeu após a mensagem que originou o follow-up");
    }
  });

  it("7. pré-condição antes do envio: prospect nunca respondeu na conversa -> cancela (terminal)", async () => {
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_enrollments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "enr-1",
                organization_id: ORG_ID,
                contact_id: CONTACT_ID,
                conversation_id: CONVERSATION_ID,
                status: "active",
                pointer_id: POINTER_ID,
                prospecting_candidate_id: CANDIDATE_ID,
                prospecting_campaign_id: CAMPAIGN_ID,
                prospecting_accepted_at: "2026-10-19T12:00:00.000Z",
                prospecting_last_outbound_at: BASE_TIME,
                started_at: BASE_TIME,
              },
              error: null,
            }),
          };
        }
        if (table === "followup_flow_pointers") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                name: "Prospecção comercial — conversa interrompida",
                trigger_config: { kind: "prospecting_conversation_interrupted" },
              },
              error: null,
            }),
          };
        }
        if (table === "prospecting_candidates") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: CANDIDATE_ID,
                organization_id: ORG_ID,
                campaign_id: CAMPAIGN_ID,
                contact_id: CONTACT_ID,
                conversation_id: CONVERSATION_ID,
                status: "sent",
                provider_accepted_at: "2026-10-19T12:00:00.000Z",
                activation_version: 1,
              },
              error: null,
            }),
          };
        }
        if (table === "prospecting_exclusions") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            then: (resolve: (val: { data: unknown[]; error: null }) => unknown) =>
              resolve({ data: [], error: null }),
          };
        }
        if (table === "prospecting_campaigns") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { status: "running", activated_at: ACTIVATION_TIME, activation_version: 1 },
              error: null,
            }),
          };
        }
        if (table === "contacts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { is_blocked: false, force_human: false, is_anonymized: false, consent: {} },
              error: null,
            }),
          };
        }
        if (table === "conversations") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                status: "open",
                last_inbound_at: null, // Nunca respondeu
                assigned_to_user_id: null,
                bot_silenced_until: null,
              },
              error: null,
            }),
          };
        }
        if (table === "messages") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [], // Nenhuma mensagem inbound
              error: null,
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
    } as unknown as SupabaseClient;

    const check = await assertProspectingFollowupPreconditions(mockAdmin, {
      organizationId: ORG_ID,
      enrollmentId: "enr-1",
      candidateId: CANDIDATE_ID,
      isConversaInterrompida: true,
    });

    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.terminal).toBe(true);
      expect(check.reason).toContain("Prospect nunca respondeu");
    }
  });

  it("8. pré-condição antes do envio: conversa assumida por humano (handoff) -> cancela (terminal)", async () => {
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_enrollments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "enr-1",
                organization_id: ORG_ID,
                contact_id: CONTACT_ID,
                conversation_id: CONVERSATION_ID,
                status: "active",
                pointer_id: POINTER_ID,
                prospecting_candidate_id: CANDIDATE_ID,
                prospecting_campaign_id: CAMPAIGN_ID,
                prospecting_accepted_at: "2026-10-19T12:00:00.000Z",
                prospecting_last_outbound_at: BASE_TIME,
                started_at: BASE_TIME,
              },
              error: null,
            }),
          };
        }
        if (table === "prospecting_candidates") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: CANDIDATE_ID,
                organization_id: ORG_ID,
                campaign_id: CAMPAIGN_ID,
                contact_id: CONTACT_ID,
                conversation_id: CONVERSATION_ID,
                status: "sent",
                provider_accepted_at: "2026-10-19T12:00:00.000Z",
                activation_version: 1,
              },
              error: null,
            }),
          };
        }
        if (table === "prospecting_exclusions") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            then: (resolve: (val: { data: unknown[]; error: null }) => unknown) =>
              resolve({ data: [], error: null }),
          };
        }
        if (table === "prospecting_campaigns") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { status: "running", activated_at: ACTIVATION_TIME, activation_version: 1 },
              error: null,
            }),
          };
        }
        if (table === "contacts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { is_blocked: false, force_human: false, is_anonymized: false, consent: {} },
              error: null,
            }),
          };
        }
        if (table === "conversations") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                status: "claimed", // Assumida por humano
                last_inbound_at: "2026-10-19T14:00:00.000Z",
                assigned_to_user_id: "user-humano-1",
                bot_silenced_until: null,
              },
              error: null,
            }),
          };
        }
        if (table === "messages") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [{ id: "msg-inbound-prior", created_at: "2026-10-19T14:00:00.000Z" }],
              error: null,
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
    } as unknown as SupabaseClient;

    const check = await assertProspectingFollowupPreconditions(mockAdmin, {
      organizationId: ORG_ID,
      enrollmentId: "enr-1",
      candidateId: CANDIDATE_ID,
      isConversaInterrompida: true,
    });

    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.terminal).toBe(true);
      expect(check.reason).toContain("handoff");
    }
  });

  it("9. pré-condição antes do envio: bot permanentemente silenciado -> cancela (terminal)", async () => {
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_enrollments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "enr-1",
                organization_id: ORG_ID,
                contact_id: CONTACT_ID,
                conversation_id: CONVERSATION_ID,
                status: "active",
                pointer_id: POINTER_ID,
                prospecting_candidate_id: CANDIDATE_ID,
                prospecting_campaign_id: CAMPAIGN_ID,
                prospecting_accepted_at: "2026-10-19T12:00:00.000Z",
                prospecting_last_outbound_at: BASE_TIME,
                started_at: BASE_TIME,
              },
              error: null,
            }),
          };
        }
        if (table === "prospecting_candidates") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: CANDIDATE_ID,
                organization_id: ORG_ID,
                campaign_id: CAMPAIGN_ID,
                contact_id: CONTACT_ID,
                conversation_id: CONVERSATION_ID,
                status: "sent",
                provider_accepted_at: "2026-10-19T12:00:00.000Z",
                activation_version: 1,
              },
              error: null,
            }),
          };
        }
        if (table === "prospecting_exclusions") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            then: (resolve: (val: { data: unknown[]; error: null }) => unknown) =>
              resolve({ data: [], error: null }),
          };
        }
        if (table === "prospecting_campaigns") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { status: "running", activated_at: ACTIVATION_TIME, activation_version: 1 },
              error: null,
            }),
          };
        }
        if (table === "contacts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { is_blocked: false, force_human: false, is_anonymized: false, consent: {} },
              error: null,
            }),
          };
        }
        if (table === "conversations") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                status: "open",
                last_inbound_at: "2026-10-19T14:00:00.000Z",
                assigned_to_user_id: null,
                bot_silenced_until: "infinity", // Silenciado permanentemente
              },
              error: null,
            }),
          };
        }
        if (table === "messages") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [{ id: "msg-inbound-prior", created_at: "2026-10-19T14:00:00.000Z" }],
              error: null,
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
    } as unknown as SupabaseClient;

    const check = await assertProspectingFollowupPreconditions(mockAdmin, {
      organizationId: ORG_ID,
      enrollmentId: "enr-1",
      candidateId: CANDIDATE_ID,
      isConversaInterrompida: true,
    });

    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.terminal).toBe(true);
      expect(check.reason).toContain("permanentemente silenciado");
    }
  });

  it("10. verificarEEmitirConversaInterrompida: emite evento se a conversa for de prospecção e o prospect tiver respondido", async () => {
    let emittedEvent: Record<string, unknown> | null = null;

    const mockDb = {
      query: vi.fn((sql: string, params: unknown[]) => {
        if (sql.includes("prospecting_candidates")) {
          return Promise.resolve({
            rows: [
              {
                id: CANDIDATE_ID,
                campaign_id: CAMPAIGN_ID,
                lead_id: null,
                contact_id: CONTACT_ID,
                provider_accepted_at: "2026-10-19T12:00:00.000Z",
                activation_version: 1,
                activation_timestamp: ACTIVATION_TIME,
              },
            ],
          });
        }
        if (sql.includes("messages")) {
          // Confirmar que houve inbound
          return Promise.resolve({ rows: [{ "?column?": 1 }] });
        }
        if (sql.includes("emit_event")) {
          emittedEvent = { sql, params };
          return Promise.resolve({ rows: [{ emit_event: "event-uuid-1" }] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };

    const emitido = await verificarEEmitirConversaInterrompida(mockDb, {
      tenantId: ORG_ID,
      conversationId: CONVERSATION_ID,
      contactId: CONTACT_ID,
      agentId: "agent-xavier",
      lastMessageId: MSG_ID,
    });

    expect(emitido).toBe(true);
    expect(emittedEvent).not.toBeNull();
    const payload = JSON.parse((emittedEvent!.params as unknown[])[3] as string);
    expect(payload.candidate_id).toBe(CANDIDATE_ID);
    expect(payload.message_id).toBe(MSG_ID);
    expect(payload.campaign_id).toBe(CAMPAIGN_ID);
  });

  it("11. verificarEEmitirConversaInterrompida: não emite se o prospect nunca tiver respondido", async () => {
    let emittedCount = 0;

    const mockDb = {
      query: vi.fn((sql: string) => {
        if (sql.includes("prospecting_candidates")) {
          return Promise.resolve({
            rows: [
              {
                id: CANDIDATE_ID,
                campaign_id: CAMPAIGN_ID,
                lead_id: null,
                contact_id: CONTACT_ID,
                provider_accepted_at: "2026-10-19T12:00:00.000Z",
                activation_version: 1,
                activation_timestamp: ACTIVATION_TIME,
              },
            ],
          });
        }
        if (sql.includes("messages")) {
          // Zero inbound messages
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes("emit_event")) {
          emittedCount++;
          return Promise.resolve({ rows: [{ emit_event: "event-uuid-1" }] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };

    const emitido = await verificarEEmitirConversaInterrompida(mockDb, {
      tenantId: ORG_ID,
      conversationId: CONVERSATION_ID,
      contactId: CONTACT_ID,
      agentId: "agent-xavier",
      lastMessageId: MSG_ID,
    });

    expect(emitido).toBe(false);
    expect(emittedCount).toBe(0);
  });

  it("12. handler do dispatcher: roteia EVENTO_PROSPECCAO_CONVERSA_INTERROMPIDA com status ok", async () => {
    const row: EventRow = {
      id: "evt-handler-1",
      organization_id: ORG_ID,
      event_type: EVENTO_PROSPECCAO_CONVERSA_INTERROMPIDA,
      entity_kind: "prospecting_candidate",
      entity_id: CANDIDATE_ID,
      payload: {
        candidate_id: CANDIDATE_ID,
        campaign_id: CAMPAIGN_ID,
        contact_id: CONTACT_ID,
        conversation_id: CONVERSATION_ID,
        message_id: MSG_ID,
        sent_at: BASE_TIME,
        activation_version: 1,
      },
      metadata: {},
      consumed_by: [],
      attempts: 0,
      created_at: BASE_TIME,
    };

    expect(followupGatilhoProspeccaoHandler.events).toContain(
      EVENTO_PROSPECCAO_CONVERSA_INTERROMPIDA,
    );
  });
});
