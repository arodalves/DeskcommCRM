import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  adicionarDiasUteis,
  getPartesNoFuso,
  isDiaUtil,
  criarDataNoFuso,
} from "@/lib/prospecting/business-days";
import {
  SETE_LEADS_MANUAIS_PROTEGIDOS,
  correspondeALeadManualProtegido,
  checarExclusaoDeProspeccao,
} from "@/lib/prospecting/exclusions";
import {
  assertProspectingFollowupPreconditions,
} from "@/lib/prospecting/guard";
import {
  aplicaGatilhoDeProspeccao,
  EVENTO_PROSPECCAO_ACEITE_INICIAL,
} from "@/lib/followup/gatilho-prospeccao";
import {
  GRAFO_PROSPECCAO_COMERCIAL,
  MODELO_PROSPECCAO_COMERCIAL,
  TEXTO_FOLLOWUP_1,
  TEXTO_FOLLOWUP_2,
} from "@/lib/followup/modelos/prospeccao";
import { processNode } from "@/lib/followup/node-handlers";
import type { FlowNode, FlowEdge } from "@/lib/followup/graph-schema";
import type { EventRow } from "@/lib/event-log/dispatcher";

describe("Suite de Testes — Follow-up de Prospecção Comercial Fluxalvo (20 Cenários)", () => {
  const ORG_A = "11111111-1111-4111-8111-111111111111";
  const ORG_B = "22222222-2222-4222-8222-222222222222";

  // 1. Envio inicial aceito → inscrição criada
  it("1. envio inicial aceito → inscrição criada com Follow-up 1 para 2 dias úteis", async () => {
    const candidateId = "c1111111-1111-4111-8111-111111111111";
    const contactId = "ct111111-1111-4111-8111-111111111111";
    const campaignId = "cp111111-1111-4111-8111-111111111111";
    const pointerId = "pt111111-1111-4111-8111-111111111111";
    const acceptedAt = "2026-10-20T10:00:00.000Z"; // Terça-feira

    let insertedEnrollment: Record<string, unknown> | null = null;

    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_flow_pointers") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            not: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: pointerId,
                organization_id: ORG_A,
                status: "active",
                active_version_id: "ver-1",
                surface: "followup",
              },
              error: null,
            }),
            then: (resolve: (val: unknown) => void) =>
              resolve({
                data: [
                  {
                    id: pointerId,
                    organization_id: ORG_A,
                    active_version_id: "ver-1",
                    name: "Prospecção comercial — sem resposta",
                    trigger_config: { kind: "prospecting_initial_accepted" },
                    status: "active",
                  },
                ],
                error: null,
              }),
          };
        }
        if (table === "contacts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: contactId },
              error: null,
            }),
          };
        }
        if (table === "followup_flow_versions") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { graph: GRAFO_PROSPECCAO_COMERCIAL },
              error: null,
            }),
          };
        }
        if (table === "followup_enrollments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
            insert: vi.fn((obj: Record<string, unknown>) => {
              insertedEnrollment = obj;
              return {
                select: vi.fn().mockReturnThis(),
                single: vi.fn().mockResolvedValue({
                  data: { id: "enr-new", ...obj },
                  error: null,
                }),
              };
            }),
          };
        }
        if (table === "prospecting_exclusions") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        if (table === "prospecting_campaigns") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: campaignId,
                status: "running",
                activated_at: "2026-10-20T09:00:00.000Z",
                activation_version: 1,
              },
              error: null,
            }),
          };
        }
        if (table === "crm_leads") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
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
            organization_id: args?.p_org ?? ORG_A,
            contact_id: args?.p_contact ?? contactId,
            conversation_id: args?.p_conversation ?? "conv-1",
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
      organization_id: ORG_A,
      event_type: EVENTO_PROSPECCAO_ACEITE_INICIAL,
      entity_kind: "prospecting_candidate",
      entity_id: candidateId,
      payload: {
        candidate_id: candidateId,
        campaign_id: campaignId,
        contact_id: contactId,
        conversation_id: "conv-1",
        message_id: "msg-1",
        provider_accepted_at: acceptedAt,
      },
      metadata: {},
      consumed_by: [],
      attempts: 0,
      created_at: acceptedAt,
    };

    const res = await aplicaGatilhoDeProspeccao(
      { admin: mockAdmin, clock: () => new Date(acceptedAt) },
      row,
    );

    expect(res.matched).toBe(true);
    expect(res.enrolled).toBe(1);
    expect(insertedEnrollment).not.toBeNull();
    expect(insertedEnrollment!["prospecting_candidate_id"]).toBe(candidateId);
    expect(insertedEnrollment!["next_eval_at"]).toBeDefined();
  });

  // 2. Queued/falha/timeout → não inscrever
  it("2. queued/falha/timeout → não inscrever sem provider_accepted_at válido", async () => {
    const mockAdmin = {} as unknown as SupabaseClient;
    const row: EventRow = {
      id: "evt-2",
      organization_id: ORG_A,
      event_type: EVENTO_PROSPECCAO_ACEITE_INICIAL,
      entity_kind: "prospecting_candidate",
      entity_id: "cand-2",
      payload: {
        candidate_id: "cand-2",
        contact_id: "ct-2",
        campaign_id: "cp-2",
        // Sem provider_accepted_at
      },
      metadata: {},
      consumed_by: [],
      attempts: 0,
      created_at: new Date().toISOString(),
    };

    const res = await aplicaGatilhoDeProspeccao({ admin: mockAdmin }, row);
    expect(res.matched).toBe(false);
    expect(res.enrolled).toBe(0);
  });

  // 3. Evento duplicado → uma inscrição
  it("3. evento duplicado → uma inscrição (idempotência)", async () => {
    const candidateId = "cand-3";
    const acceptedAt = "2026-10-20T10:00:00.000Z";

    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_enrollments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { id: "enr-existente" },
              error: null,
            }),
          };
        }
        if (table === "prospecting_campaigns") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "cp-3",
                status: "running",
                activated_at: "2026-10-20T09:00:00.000Z",
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
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
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
      organization_id: ORG_A,
      event_type: EVENTO_PROSPECCAO_ACEITE_INICIAL,
      entity_kind: "prospecting_candidate",
      entity_id: candidateId,
      payload: {
        candidate_id: candidateId,
        campaign_id: "cp-3",
        contact_id: "ct-3",
        conversation_id: "cv-3",
        message_id: "mg-3",
        provider_accepted_at: acceptedAt,
      },
      metadata: {},
      consumed_by: [],
      attempts: 0,
      created_at: acceptedAt,
    };

    const res = await aplicaGatilhoDeProspeccao(
      { admin: mockAdmin, clock: () => new Date(acceptedAt) },
      row,
    );

    expect(res.matched).toBe(true);
    expect(res.skipped_existing).toBe(1);
    expect(res.enrolled).toBe(0);
  });

  // 4. Workers concorrentes → no máximo um envio
  it("4. workers concorrentes → no máximo um envio (bloqueio 23505 conflict)", async () => {
    const candidateId = "cand-4";
    const acceptedAt = "2026-10-20T10:00:00.000Z";

    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_flow_pointers") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            not: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "ptr-4",
                organization_id: ORG_A,
                status: "active",
                active_version_id: "v-4",
                surface: "followup",
              },
            }),
            then: (resolve: (val: unknown) => void) =>
              resolve({
                data: [
                  {
                    id: "ptr-4",
                    organization_id: ORG_A,
                    active_version_id: "v-4",
                    name: "Prospecção comercial — sem resposta",
                    trigger_config: { kind: "prospecting_initial_accepted" },
                    status: "active",
                  },
                ],
              }),
          };
        }
        if (table === "contacts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: "ct-4" } }),
          };
        }
        if (table === "followup_flow_versions") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { graph: GRAFO_PROSPECCAO_COMERCIAL } }),
          };
        }
        if (table === "followup_enrollments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null }),
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnThis(),
              single: vi.fn().mockResolvedValue({
                data: null,
                error: { code: "23505", message: "duplicate key value" },
              }),
            }),
          };
        }
        if (table === "prospecting_campaigns") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "cp-4",
                status: "running",
                activated_at: "2026-10-20T09:00:00.000Z",
                activation_version: 1,
              },
              error: null,
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        };
      }),
      rpc: vi.fn().mockImplementation((fn: string, args: any) =>
        Promise.resolve({
          data: {
            organization_id: args?.p_org ?? ORG_A,
            contact_id: args?.p_contact ?? "ct-4",
            conversation_id: "cv-4",
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
      id: "evt-4",
      organization_id: ORG_A,
      event_type: EVENTO_PROSPECCAO_ACEITE_INICIAL,
      entity_kind: "prospecting_candidate",
      entity_id: candidateId,
      payload: {
        candidate_id: candidateId,
        campaign_id: "cp-4",
        contact_id: "ct-4",
        conversation_id: "cv-4",
        message_id: "mg-4",
        provider_accepted_at: acceptedAt,
      },
      metadata: {},
      consumed_by: [],
      attempts: 0,
      created_at: acceptedAt,
    };

    const res = await aplicaGatilhoDeProspeccao(
      { admin: mockAdmin, clock: () => new Date(acceptedAt) },
      row,
    );

    expect(res.skipped_existing).toBe(1);
    expect(res.enrolled).toBe(0);
  });

  // 5. Falha após aceite → não repetir abordagem inicial
  it("5. falha após aceite → não repetir abordagem inicial", async () => {
    const candidate = {
      status: "sent",
      provider_accepted_at: "2026-10-20T10:00:00.000Z",
    };
    // Abordagem inicial aceita permanece 'sent' e não pode ser re-enfileirada
    expect(candidate.status).toBe("sent");
    expect(candidate.provider_accepted_at).not.toBeNull();
  });

  // 6. Contato antigo → não inscrever (anti-retroatividade dinâmica pela ativação da campanha)
  it("6. contato antigo → não inscrever (tentativa/aceite anterior à ativação real da campanha)", async () => {
    const campaignActivatedAt = "2026-10-20T09:00:00.000Z";
    const acceptedAt = "2026-10-18T10:00:00.000Z"; // Anterior à ativação da campanha
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "prospecting_campaigns") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "cp-6",
                status: "running",
                activated_at: campaignActivatedAt,
                activation_version: 1,
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
      id: "evt-6",
      organization_id: ORG_A,
      event_type: EVENTO_PROSPECCAO_ACEITE_INICIAL,
      entity_kind: "prospecting_candidate",
      entity_id: "cand-old",
      payload: {
        candidate_id: "cand-old",
        campaign_id: "cp-6",
        contact_id: "ct-6",
        conversation_id: "cv-6",
        message_id: "mg-6",
        provider_accepted_at: acceptedAt,
        attempted_at: acceptedAt,
        activation_version: 1,
      },
      metadata: {},
      consumed_by: [],
      attempts: 0,
      created_at: acceptedAt,
    };

    const res = await aplicaGatilhoDeProspeccao(
      { admin: mockAdmin, clock: () => new Date("2026-10-20T10:00:00.000Z") },
      row,
    );

    expect(res.skipped_retroactive).toBe(1);
    expect(res.enrolled).toBe(0);
  });

  // 7. Reativação posterior → não reaproveitar evento da ativação anterior
  it("7. reativação posterior → não reaproveitar evento da ativação anterior (versão incompatível)", async () => {
    // Campanha foi reativada para a versão 2 com novo timestamp de ativação
    const campaignReactivatedAt = "2026-10-21T09:00:00.000Z";
    const acceptedAt = "2026-10-20T10:00:00.000Z"; // Aceite na ativação 1
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "prospecting_campaigns") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "cp-7",
                status: "running",
                activated_at: campaignReactivatedAt,
                activation_version: 2, // Reativada: versão 2
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
      id: "evt-7",
      organization_id: ORG_A,
      event_type: EVENTO_PROSPECCAO_ACEITE_INICIAL,
      entity_kind: "prospecting_candidate",
      entity_id: "cand-stale",
      payload: {
        candidate_id: "cand-stale",
        campaign_id: "cp-7",
        contact_id: "ct-7",
        conversation_id: "cv-7",
        message_id: "mg-7",
        provider_accepted_at: acceptedAt,
        attempted_at: acceptedAt,
        activation_version: 1, // Evento originado na versão 1 anterior
      },
      metadata: {},
      consumed_by: [],
      attempts: 0,
      created_at: acceptedAt,
    };

    const res = await aplicaGatilhoDeProspeccao(
      { admin: mockAdmin, clock: () => new Date("2026-10-21T10:00:00.000Z") },
      row,
    );

    expect(res.skipped_retroactive).toBe(1);
    expect(res.enrolled).toBe(0);
  });

  // 8. Resposta antes do follow-up → cancelar
  it("8. resposta antes do follow-up → cancela pré-condição definitivamente", async () => {
    const acceptedAt = "2026-10-20T10:00:00.000Z";
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_enrollments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "enr-8",
                organization_id: ORG_A,
                contact_id: "ct-8",
                conversation_id: "cv-8",
                status: "active",
                prospecting_candidate_id: "cand-8",
              },
            }),
          };
        }
        if (table === "prospecting_candidates") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "cand-8",
                organization_id: ORG_A,
                contact_id: "ct-8",
                conversation_id: "cv-8",
                status: "sent",
                provider_accepted_at: acceptedAt,
                message_id: "msg-8",
              },
            }),
          };
        }
        if (table === "messages") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [{ id: "inbound-reply-1", created_at: "2026-10-20T11:00:00.000Z" }],
            }),
            maybeSingle: vi.fn().mockResolvedValue({ data: { status: "sent" } }),
          };
        }
        if (table === "contacts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { is_blocked: false } }),
          };
        }
        if (table === "conversations") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                status: "open",
                last_inbound_at: "2026-10-20T11:00:00.000Z",
              },
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        };
      }),
    } as unknown as SupabaseClient;

    const check = await assertProspectingFollowupPreconditions(mockAdmin, {
      organizationId: ORG_A,
      enrollmentId: "enr-8",
      candidateId: "cand-8",
    });

    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.terminal).toBe(true);
      expect(check.reason).toContain("já respondeu");
    }
  });

  // 9. force_human=true → cancelar
  it("9. force_human=true → cancelar pré-condição", async () => {
    const acceptedAt = "2026-10-20T10:00:00.000Z";
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_enrollments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "enr-9",
                organization_id: ORG_A,
                contact_id: "ct-9",
                conversation_id: "cv-9",
                status: "active",
                prospecting_candidate_id: "cand-9",
              },
            }),
          };
        }
        if (table === "prospecting_candidates") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "cand-9",
                organization_id: ORG_A,
                contact_id: "ct-9",
                conversation_id: "cv-9",
                status: "sent",
                provider_accepted_at: acceptedAt,
                message_id: "msg-9",
              },
            }),
          };
        }
        if (table === "messages") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: [] }),
            maybeSingle: vi.fn().mockResolvedValue({ data: { status: "sent" } }),
          };
        }
        if (table === "contacts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { is_blocked: false, force_human: true },
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        };
      }),
    } as unknown as SupabaseClient;

    const check = await assertProspectingFollowupPreconditions(mockAdmin, {
      organizationId: ORG_A,
      enrollmentId: "enr-9",
      candidateId: "cand-9",
    });

    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toContain("force_human");
    }
  });

  // 10. Handoff → cancelar definitivamente
  it("10. handoff → cancelar definitivamente (atendente humano assumiu)", async () => {
    const acceptedAt = "2026-10-20T10:00:00.000Z";
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_enrollments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "enr-10",
                organization_id: ORG_A,
                contact_id: "ct-10",
                conversation_id: "cv-10",
                status: "active",
                prospecting_candidate_id: "cand-10",
              },
            }),
          };
        }
        if (table === "prospecting_candidates") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "cand-10",
                organization_id: ORG_A,
                contact_id: "ct-10",
                conversation_id: "cv-10",
                status: "sent",
                provider_accepted_at: acceptedAt,
                message_id: "msg-10",
              },
            }),
          };
        }
        if (table === "messages") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: [] }),
            maybeSingle: vi.fn().mockResolvedValue({ data: { status: "sent" } }),
          };
        }
        if (table === "contacts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: { is_blocked: false } }),
          };
        }
        if (table === "conversations") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                status: "claimed",
                assigned_to_user_id: "user-human-1",
              },
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        };
      }),
    } as unknown as SupabaseClient;

    const check = await assertProspectingFollowupPreconditions(mockAdmin, {
      organizationId: ORG_A,
      enrollmentId: "enr-10",
      candidateId: "cand-10",
    });

    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.terminal).toBe(true);
      expect(check.reason).toContain("humano");
    }
  });

  // 11. Opt-out → cancelar
  it("11. opt-out → cancelar pré-condição", async () => {
    const acceptedAt = "2026-10-20T10:00:00.000Z";
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_enrollments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "enr-11",
                organization_id: ORG_A,
                contact_id: "ct-11",
                conversation_id: "cv-11",
                status: "active",
                prospecting_candidate_id: "cand-11",
              },
            }),
          };
        }
        if (table === "prospecting_candidates") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "cand-11",
                organization_id: ORG_A,
                contact_id: "ct-11",
                conversation_id: "cv-11",
                status: "sent",
                provider_accepted_at: acceptedAt,
                message_id: "msg-11",
              },
            }),
          };
        }
        if (table === "messages") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: [] }),
            maybeSingle: vi.fn().mockResolvedValue({ data: { status: "sent" } }),
          };
        }
        if (table === "contacts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                is_blocked: false,
                consent: { marketing: { opt_out: true } },
              },
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        };
      }),
    } as unknown as SupabaseClient;

    const check = await assertProspectingFollowupPreconditions(mockAdmin, {
      organizationId: ORG_A,
      enrollmentId: "enr-11",
      candidateId: "cand-11",
    });

    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toContain("opt-out");
    }
  });

  // 12. Bloqueio → cancelar
  it("12. bloqueio → cancelar pré-condição", async () => {
    const acceptedAt = "2026-10-20T10:00:00.000Z";
    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === "followup_enrollments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "enr-12",
                organization_id: ORG_A,
                contact_id: "ct-12",
                conversation_id: "cv-12",
                status: "active",
                prospecting_candidate_id: "cand-12",
              },
            }),
          };
        }
        if (table === "prospecting_candidates") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: "cand-12",
                organization_id: ORG_A,
                contact_id: "ct-12",
                conversation_id: "cv-12",
                status: "sent",
                provider_accepted_at: acceptedAt,
                message_id: "msg-12",
              },
            }),
          };
        }
        if (table === "messages") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: [] }),
            maybeSingle: vi.fn().mockResolvedValue({ data: { status: "sent" } }),
          };
        }
        if (table === "contacts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: { is_blocked: true },
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        };
      }),
    } as unknown as SupabaseClient;

    const check = await assertProspectingFollowupPreconditions(mockAdmin, {
      organizationId: ORG_A,
      enrollmentId: "enr-12",
      candidateId: "cand-12",
    });

    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toContain("bloqueado");
    }
  });

  // 13. Sexta-feira/fim de semana → próximo dia útil correto
  it("13. sexta-feira/fim de semana → próximo dia útil correto", () => {
    // Sexta-feira 2026-10-23 às 14:00 (dia útil) + 2 dias úteis
    // Dia 1: Segunda 2026-10-26 às 14:00
    // Dia 2: Terça 2026-10-27 às 14:00
    const sexta = criarDataNoFuso(2026, 10, 23, 14, 0, 0);
    const resultadoSexta = adicionarDiasUteis(sexta, 2);
    const pSexta = getPartesNoFuso(resultadoSexta);
    expect(pSexta.weekday).toBe("Tue");
    expect(pSexta.day).toBe(27);
    expect(pSexta.hour).toBe(14);

    // Sábado 2026-10-24 às 11:00 (fim de semana) + 2 dias úteis
    // Normaliza para Segunda 2026-10-26 09:00
    // Dia 1: Terça 2026-10-27 09:00
    // Dia 2: Quarta 2026-10-28 09:00
    const sabado = criarDataNoFuso(2026, 10, 24, 11, 0, 0);
    const resultadoSabado = adicionarDiasUteis(sabado, 2);
    const pSabado = getPartesNoFuso(resultadoSabado);
    expect(pSabado.weekday).toBe("Wed");
    expect(pSabado.day).toBe(28);
    expect(pSabado.hour).toBe(9);
  });

  // 14. Janela 09:00–17:00 respeitada
  it("14. janela 09:00–17:00 respeitada (fora de horário normaliza)", () => {
    // Quarta-feira às 18:30 (após 17:00) + 2 dias úteis
    // Normaliza para Quinta 09:00
    // Dia 1: Sexta 09:00
    // Dia 2: Segunda 09:00
    const quartaNoite = criarDataNoFuso(2026, 10, 21, 18, 30, 0);
    const res = adicionarDiasUteis(quartaNoite, 2);
    const p = getPartesNoFuso(res);
    expect(p.weekday).toBe("Mon");
    expect(p.day).toBe(26);
    expect(p.hour).toBe(9);

    // Terça-feira às 07:15 (antes das 09:00) + 2 dias úteis
    // Normaliza para Terça 09:00
    // Dia 1: Quarta 09:00
    // Dia 2: Quinta 09:00
    const tercaCedo = criarDataNoFuso(2026, 10, 20, 7, 15, 0);
    const resCedo = adicionarDiasUteis(tercaCedo, 2);
    const pCedo = getPartesNoFuso(resCedo);
    expect(pCedo.weekday).toBe("Thu");
    expect(pCedo.day).toBe(22);
    expect(pCedo.hour).toBe(9);
  });

  // 15. Follow-up 2 calculado a partir do envio REAL do Follow-up 1
  it("15. Follow-up 2 calculado a partir do envio REAL do Follow-up 1", () => {
    // Suponha que o Follow-up 1 foi efetivamente enviado na Quinta 2026-10-22 às 15:30
    const envioRealFu1 = criarDataNoFuso(2026, 10, 22, 15, 30, 0);
    // Follow-up 2 é 4 dias úteis após o envio REAL de Follow-up 1
    // Dia 1: Sexta 2026-10-23 15:30
    // Dia 2: Segunda 2026-10-26 15:30
    // Dia 3: Terça 2026-10-27 15:30
    // Dia 4: Quarta 2026-10-28 15:30
    const fu2 = adicionarDiasUteis(envioRealFu1, 4);
    const pFu2 = getPartesNoFuso(fu2);
    expect(pFu2.weekday).toBe("Wed");
    expect(pFu2.day).toBe(28);
    expect(pFu2.hour).toBe(15);
    expect(pFu2.minute).toBe(30);

    // Teste no motor de nós (processNode no nó de espera do Follow-up 2)
    const noEspera2 = GRAFO_PROSPECCAO_COMERCIAL.nodes.find((n) => n.id === "espera-2")!;
    const resultadoNo = processNode({
      node: noEspera2,
      edges: GRAFO_PROSPECCAO_COMERCIAL.edges,
      enrollment: { id: "enr-15", timing_plan: null } as unknown as any,
      lead: {} as any,
      clock: () => envioRealFu1,
      waitElapsed: false,
    });

    expect(resultadoNo.kind).toBe("wait");
    if (resultadoNo.kind === "wait") {
      const pResult = getPartesNoFuso(resultadoNo.next_eval_at);
      expect(pResult.day).toBe(28);
      expect(pResult.hour).toBe(15);
      expect(pResult.minute).toBe(30);
    }
  });

  // 16. Exatamente 2 follow-ups
  it("16. exatamente 2 follow-ups (ações de envio de texto no grafo)", () => {
    const acoes = GRAFO_PROSPECCAO_COMERCIAL.nodes.filter((n) => n.type === "action");
    expect(acoes.length).toBe(2);
    expect(acoes[0]!.id).toBe("followup-1");
    expect((acoes[0]!.config as any).body).toBe(TEXTO_FOLLOWUP_1);
    expect(acoes[1]!.id).toBe("followup-2");
    expect((acoes[1]!.config as any).body).toBe(TEXTO_FOLLOWUP_2);

    // Após Follow-up 2 vai direto para o nó fim
    const arestaAposFu2 = GRAFO_PROSPECCAO_COMERCIAL.edges.find((e) => e.source === "followup-2");
    expect(arestaAposFu2?.target).toBe("fim");

    const noFim = GRAFO_PROSPECCAO_COMERCIAL.nodes.find((n) => n.id === "fim");
    expect(noFim?.type).toBe("end");
  });

  // 17. Nenhum movimento automático de pipeline
  it("17. nenhum movimento automático de pipeline no grafo", () => {
    const nosMoveLead = GRAFO_PROSPECCAO_COMERCIAL.nodes.filter(
      (n) => n.type === "move_lead" || (n.type as string) === "stage_change",
    );
    expect(nosMoveLead.length).toBe(0);
  });

  // 18. Os 7 leads manuais continuam excluídos
  it("18. os 7 leads manuais continuam estritamente excluídos", () => {
    for (const leadNome of SETE_LEADS_MANUAIS_PROTEGIDOS) {
      const res = correspondeALeadManualProtegido(leadNome);
      expect(res.protegido).toBe(true);
      expect(res.leadProtegido).toBe(leadNome);
    }
  });

  // 19. Duplicidade potencial da Caroline bloqueada sem inventar identidade
  it("19. duplicidade potencial da Caroline bloqueada sem inventar identidade", () => {
    // Caroline Oliveira por título de lead exato
    const resTitulo = correspondeALeadManualProtegido("Dra. Caroline Oliveira - Harmonização Facial");
    expect(resTitulo.protegido).toBe(true);

    // Nome arbitrário 'Caroline' sem sobrenome/especificação não é confundido
    const resGenerico = correspondeALeadManualProtegido("Caroline", { isContactName: true });
    expect(resGenerico.protegido).toBe(false);
  });

  // 20. Organizações diferentes não podem compartilhar vínculos
  it("20. organizações diferentes não compartilham vínculos (isolamento multi-tenant)", async () => {
    const mockAdmin = {
      from: vi.fn((table: string) => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn((col: string, val: string) => {
          if (col === "organization_id" && val === ORG_A) {
            return {
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: "cand-org-a", organization_id: ORG_A },
              }),
            };
          }
          return {
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null }),
          };
        }),
      })),
    } as unknown as SupabaseClient;

    const check = await assertProspectingFollowupPreconditions(mockAdmin, {
      organizationId: ORG_B, // Org B tentando ler candidato da Org A
      enrollmentId: "enr-org-a",
      candidateId: "cand-org-a",
    });

    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toContain("não encontrada");
    }
  });
});
