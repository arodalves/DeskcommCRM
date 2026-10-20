// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  addLeadNoteTool,
  assignAgentTool,
  chatGptTools,
  createLeadTool,
  getContactAutomationStatusTool,
  getLeadTool,
  listPipelineStagesTool,
  searchLeadsTool,
  setHumanServiceTool,
  upsertLeadContactTool,
} from "@/lib/mcp/chatgpt/tools";
import type { McpContext } from "@/lib/mcp/types";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000003";
const AGENT_ID = "00000000-0000-4000-8000-000000000004";
const LEAD_ID = "00000000-0000-4000-8000-000000000005";
const CONTACT_ID = "00000000-0000-4000-8000-000000000006";
const PIPELINE_ID = "00000000-0000-4000-8000-000000000007";
const STAGE_ID = "00000000-0000-4000-8000-000000000008";
const STAGE_ID_2 = "00000000-0000-4000-8000-000000000009";

function mockCtx(supabaseMock: unknown): McpContext {
  return {
    organizationId: ORG_ID,
    role: "manager",
    actor: { type: "api_token", id: "tok-1", role: "manager" },
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase: supabaseMock as never,
  };
}

describe("ChatGPT MCP Tools - Catálogo e Configuração", () => {
  it("expõe exatamente as 11 ferramentas operacionais solicitadas", () => {
    const toolNames = chatGptTools.map((t) => t.name);
    expect(toolNames).toEqual([
      "search_leads",
      "get_lead",
      "create_lead",
      "update_lead",
      "add_lead_note",
      "move_lead_stage",
      "set_human_service",
      "get_contact_automation_status",
      "assign_agent",
      "list_pipeline_stages",
      "upsert_lead_contact",
    ]);
  });
});

describe("ChatGPT MCP Tools - create_lead & set_human_service", () => {
  it("cria lead com set_human_service=true travando o contato com force_human=true e silenciando a IA", async () => {
    let contactInserted = false;
    let contactForceHuman = false;
    let convSilenced = false;
    let activityEmitted = false;

    const supabaseMock = {
      from: vi.fn((table: string) => {
        if (table === "crm_pipelines") {
          const chain: Record<string, unknown> = {};
          chain.eq = () => chain;
          chain.order = () => chain;
          chain.limit = () => chain;
          chain.maybeSingle = async () => ({ data: { id: PIPELINE_ID, organization_id: ORG_ID } });
          return { select: () => chain };
        }
        if (table === "crm_stages") {
          const chain: Record<string, unknown> = {};
          chain.eq = () => chain;
          chain.order = () => chain;
          chain.limit = () => chain;
          chain.maybeSingle = async () => ({
            data: { id: STAGE_ID, pipeline_id: PIPELINE_ID, organization_id: ORG_ID },
          });
          return { select: () => chain };
        }
        if (table === "contacts") {
          const selectChain: Record<string, unknown> = {};
          selectChain.eq = () => selectChain;
          selectChain.in = () => selectChain;
          selectChain.limit = () => selectChain;
          selectChain.maybeSingle = async () => ({
            data: contactInserted ? { id: CONTACT_ID, organization_id: ORG_ID } : null,
          });
          return {
            select: () => selectChain,
            insert: (payload: { force_human: boolean; name: string }) => {
              contactInserted = true;
              contactForceHuman = payload.force_human;
              return {
                select: () => ({
                  single: async () => ({ data: { id: CONTACT_ID, force_human: payload.force_human } }),
                }),
              };
            },
            update: (payload: { force_human: boolean }) => {
              contactForceHuman = payload.force_human;
              return {
                eq: () => ({
                  eq: async () => ({ error: null }),
                }),
              };
            },
          };
        }
        if (table === "conversations") {
          return {
            update: (payload: { bot_silenced_until: string; assignee_kind: string }) => {
              if (payload.bot_silenced_until === "infinity" && payload.assignee_kind === "user") {
                convSilenced = true;
              }
              return {
                eq: () => ({
                  eq: async () => ({ error: null }),
                }),
              };
            },
          };
        }
        if (table === "crm_lead_activities") {
          return {
            insert: async () => {
              activityEmitted = true;
              return { error: null };
            },
          };
        }
        if (table === "crm_leads") {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({ data: { position_in_stage: 1000 } }),
                  }),
                }),
              }),
            }),
            insert: (payload: Record<string, unknown>) => ({
              select: () => ({
                single: async () => ({
                  data: {
                    id: LEAD_ID,
                    ...payload,
                  },
                }),
              }),
            }),
          };
        }
        if (table === "organizations") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { currency: "BRL" } }),
              }),
            }),
          };
        }
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
        };
      }),
    };

    const ctx = mockCtx(supabaseMock);
    const result = (await createLeadTool.handler(
      {
        title: "Lead Teste Fluxalvo",
        contact_name: "Cliente VIP",
        contact_phone: "11988887777",
        description: "Abordagem com site inicial personalizado.",
        source: "site_inicial",
        tags: ["site_inicial"],
        set_human_service: true,
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result["success"]).toBe(true);
    expect(contactInserted).toBe(true);
    expect(contactForceHuman).toBe(true);
    expect(convSilenced).toBe(true);
    expect(activityEmitted).toBe(true);
    expect(result["xavier_blocked"]).toBe(true);
    expect(result["human_service_active"]).toBe(true);
  });

  it("set_human_service grava contacts.force_human=true e bot_silenced_until=infinity", async () => {
    let forceHumanSet = false;
    let botSilenced = false;

    const supabaseMock = {
      from: vi.fn((table: string) => {
        if (table === "crm_leads") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: { id: LEAD_ID, contact_id: CONTACT_ID } }),
                }),
              }),
            }),
          };
        }
        if (table === "contacts") {
          return {
            update: (payload: { force_human: boolean }) => {
              if (payload.force_human === true) forceHumanSet = true;
              return {
                eq: () => ({
                  eq: async () => ({ error: null }),
                }),
              };
            },
          };
        }
        if (table === "conversations") {
          return {
            update: (payload: { bot_silenced_until: string; assignee_kind: string }) => {
              if (payload.bot_silenced_until === "infinity" && payload.assignee_kind === "user") {
                botSilenced = true;
              }
              return {
                eq: () => ({
                  eq: async () => ({ error: null }),
                }),
              };
            },
          };
        }
        if (table === "crm_lead_activities") {
          return {
            insert: async () => ({ error: null }),
          };
        }
        return {};
      }),
    };

    const ctx = mockCtx(supabaseMock);
    const result = (await setHumanServiceTool.handler(
      {
        lead_id: LEAD_ID,
        reason: "Primeiro contato manual pelo WhatsApp pessoal do Atillà",
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result["success"]).toBe(true);
    expect(forceHumanSet).toBe(true);
    expect(botSilenced).toBe(true);
    expect(result["force_human"]).toBe(true);
    expect(result["xavier_blocked"]).toBe(true);
  });
});

describe("ChatGPT MCP Tools - get_contact_automation_status (Leitura de Diagnóstico)", () => {
  it("informa corretamente que Xavier está bloqueado quando force_human=true", async () => {
    const supabaseMock = {
      from: vi.fn((table: string) => {
        if (table === "contacts") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: CONTACT_ID,
                      name: "Cliente Especial",
                      phone_number: "+5511988887777",
                      force_human: true,
                      is_blocked: false,
                    },
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "conversations") {
          return {
            select: () => ({
              eq: () => ({
                eq: async () => ({
                  data: [
                    {
                      id: "conv-1",
                      status: "pending",
                      assignee_kind: "user",
                      bot_silenced_until: "infinity",
                      last_handoff_at: new Date().toISOString(),
                      last_handoff_reason: "Atendimento manual",
                    },
                  ],
                }),
              }),
            }),
          };
        }
        return {};
      }),
    };

    const ctx = mockCtx(supabaseMock);
    const status = (await getContactAutomationStatusTool.handler(
      { contact_id: CONTACT_ID },
      ctx,
    )) as Record<string, unknown>;

    expect(status["force_human"]).toBe(true);
    expect(status["can_xavier_respond"]).toBe(false);
    expect(String(status["status_summary"])).toContain("BLOQUEIO TOTAL");
  });

  it("informa que Xavier está apto quando force_human=false e não há silêncio", async () => {
    const supabaseMock = {
      from: vi.fn((table: string) => {
        if (table === "contacts") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: CONTACT_ID,
                      name: "Cliente Sem Trava",
                      phone_number: "+5511988887777",
                      force_human: false,
                      is_blocked: false,
                    },
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "conversations") {
          return {
            select: () => ({
              eq: () => ({
                eq: async () => ({
                  data: [
                    {
                      id: "conv-2",
                      status: "open",
                      assignee_kind: null,
                      bot_silenced_until: null,
                    },
                  ],
                }),
              }),
            }),
          };
        }
        return {};
      }),
    };

    const ctx = mockCtx(supabaseMock);
    const status = (await getContactAutomationStatusTool.handler(
      { contact_id: CONTACT_ID },
      ctx,
    )) as Record<string, unknown>;

    expect(status["force_human"]).toBe(false);
    expect(status["can_xavier_respond"]).toBe(true);
  });
});

describe("ChatGPT MCP Tools - Proteção Contra Reativação Implícita", () => {
  it("assign_agent RECUSA atribuir agente de IA se o contato estiver com force_human=true", async () => {
    const supabaseMock = {
      from: vi.fn((table: string) => {
        if (table === "crm_leads") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { id: LEAD_ID, contact_id: CONTACT_ID },
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "contacts") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { force_human: true },
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      }),
    };

    const ctx = mockCtx(supabaseMock);

    await expect(
      assignAgentTool.handler(
        {
          lead_id: LEAD_ID,
          assignee_type: "agent",
          assignee_id: AGENT_ID,
        },
        ctx,
      ),
    ).rejects.toThrow(/Atribuição de agente de IA RECUSADA/);
  });

  it("assign_agent permite atribuir atendente humano ('user')", async () => {
    let leadUpdated = false;

    const supabaseMock = {
      from: vi.fn((table: string) => {
        if (table === "crm_leads") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { id: LEAD_ID, contact_id: CONTACT_ID },
                  }),
                }),
              }),
            }),
            update: (payload: { owner_kind: string; owner_user_id: string }) => {
              if (payload.owner_kind === "user" && payload.owner_user_id === USER_ID) {
                leadUpdated = true;
              }
              return {
                eq: () => ({
                  eq: async () => ({ error: null }),
                }),
              };
            },
          };
        }
        if (table === "user_organizations") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { user_id: USER_ID },
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "conversations") {
          return {
            update: () => ({
              eq: () => ({
                eq: async () => ({ error: null }),
              }),
            }),
          };
        }
        return {};
      }),
    };

    const ctx = mockCtx(supabaseMock);
    const res = (await assignAgentTool.handler(
      {
        lead_id: LEAD_ID,
        assignee_type: "user",
        assignee_id: USER_ID,
      },
      ctx,
    )) as Record<string, unknown>;

    expect(res["success"]).toBe(true);
    expect(leadUpdated).toBe(true);
  });
});

describe("ChatGPT MCP Tools - add_lead_note", () => {
  it("adiciona anotação interna à timeline crm_lead_activities", async () => {
    let activityInserted = false;
    let activityType = "";
    let activityReason = "";

    const supabaseMock = {
      from: vi.fn((table: string) => {
        if (table === "crm_leads") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { id: LEAD_ID, contact_id: CONTACT_ID },
                  }),
                }),
              }),
            }),
            update: () => ({
              eq: () => ({
                eq: async () => ({ error: null }),
              }),
            }),
          };
        }
        if (table === "crm_lead_activities") {
          return {
            insert: async (payload: { type: string; reason: string }) => {
              activityInserted = true;
              activityType = payload.type;
              activityReason = payload.reason;
              return { error: null };
            },
          };
        }
        return {};
      }),
    };

    const ctx = mockCtx(supabaseMock);
    const res = (await addLeadNoteTool.handler(
      {
        lead_id: LEAD_ID,
        note: "Cliente solicitou contato via WhatsApp pessoal na parte da tarde.",
      },
      ctx,
    )) as Record<string, unknown>;

    expect(res["success"]).toBe(true);
    expect(activityInserted).toBe(true);
    expect(activityType).toBe("note");
    expect(activityReason).toBe("Cliente solicitou contato via WhatsApp pessoal na parte da tarde.");
  });
});

describe("ChatGPT MCP Tools - search_leads & get_lead", () => {
  it("search_leads busca por telefone, nome ou título e retorna leads enriquecidos", async () => {
    const supabaseMock = {
      from: vi.fn((table: string) => {
        if (table === "contacts") {
          return {
            select: () => ({
              eq: () => ({
                or: () => ({
                  limit: async () => ({
                    data: [
                      {
                        id: CONTACT_ID,
                        name: "João Silva",
                        display_name: null,
                        phone_number: "+5511999998888",
                        email: "joao@exemplo.com",
                        force_human: true,
                      },
                    ],
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "crm_leads") {
          return {
            select: () => ({
              eq: () => ({
                or: () => ({
                  order: () => ({
                    limit: async () => ({
                      data: [
                        {
                          id: LEAD_ID,
                          title: "Projeto Site Novo",
                          description: "Site institucional",
                          pipeline_id: PIPELINE_ID,
                          stage_id: STAGE_ID,
                          status: "open",
                          contact_id: CONTACT_ID,
                          value_cents: 500000,
                          currency: "BRL",
                          tags: ["prospeccao"],
                          created_at: new Date().toISOString(),
                        },
                      ],
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "crm_pipelines") {
          return {
            select: () => ({
              eq: () => ({
                in: async () => ({ data: [{ id: PIPELINE_ID, name: "Vendas" }] }),
              }),
            }),
          };
        }
        if (table === "crm_stages") {
          return {
            select: () => ({
              eq: () => ({
                in: async () => ({ data: [{ id: STAGE_ID, name: "Primeiro Contato" }] }),
              }),
            }),
          };
        }
        return {};
      }),
    };

    const ctx = mockCtx(supabaseMock);
    const res = (await searchLeadsTool.handler(
      { query: "João", limit: 10 },
      ctx,
    )) as { leads: Array<Record<string, unknown>>; count: number };

    expect(res.count).toBe(1);
    expect(res.leads[0]?.title).toBe("Projeto Site Novo");
    expect(res.leads[0]?.contact).toMatchObject({
      name: "João Silva",
      phone: "+5511999998888",
      force_human: true,
    });
  });

  it("get_lead retorna lead completo com contato, estágio e atividades", async () => {
    const supabaseMock = {
      from: vi.fn((table: string) => {
        if (table === "crm_leads") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: LEAD_ID,
                      title: "Consultoria",
                      organization_id: ORG_ID,
                      contact_id: CONTACT_ID,
                      pipeline_id: PIPELINE_ID,
                      stage_id: STAGE_ID,
                      status: "open",
                    },
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "contacts") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: CONTACT_ID,
                      name: "Maria Santos",
                      phone_number: "+5511988889999",
                      force_human: true,
                    },
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "crm_pipelines") {
          const chain: Record<string, unknown> = {};
          chain.eq = () => chain;
          chain.maybeSingle = async () => ({ data: { name: "Serviços" } });
          return { select: () => chain };
        }
        if (table === "crm_stages") {
          const chain: Record<string, unknown> = {};
          chain.eq = () => chain;
          chain.maybeSingle = async () => ({ data: { name: "Proposta Enviada" } });
          return { select: () => chain };
        }
        if (table === "crm_lead_activities") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: async () => ({
                      data: [
                        {
                          id: "act-1",
                          type: "note",
                          reason: "Nota de alinhamento",
                          performed_at: new Date().toISOString(),
                        },
                      ],
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      }),
    };

    const ctx = mockCtx(supabaseMock);
    const res = (await getLeadTool.handler({ lead_id: LEAD_ID }, ctx)) as {
      lead: Record<string, unknown>;
    };

    expect(res.lead["id"]).toBe(LEAD_ID);
    expect(res.lead["title"]).toBe("Consultoria");
    expect(res.lead["stage_name"]).toBe("Proposta Enviada");
    expect(res.lead["pipeline_name"]).toBe("Serviços");
  });
});

describe("ChatGPT MCP Tools - list_pipeline_stages", () => {
  it("lista pipelines com suas etapas ordenadas", async () => {
    const supabaseMock = {
      from: vi.fn((table: string) => {
        if (table === "crm_pipelines") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: async () => ({
                    data: [
                      { id: PIPELINE_ID, name: "Comercial", is_default: true, position: 1000 },
                    ],
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "crm_stages") {
          return {
            select: () => ({
              eq: () => ({
                in: () => ({
                  order: async () => ({
                    data: [
                      {
                        id: STAGE_ID,
                        pipeline_id: PIPELINE_ID,
                        name: "Novo",
                        slug: "novo",
                        position: 1000,
                        is_won: false,
                        is_lost: false,
                      },
                      {
                        id: STAGE_ID_2,
                        pipeline_id: PIPELINE_ID,
                        name: "Fechado Ganho",
                        slug: "ganho",
                        position: 2000,
                        is_won: true,
                        is_lost: false,
                      },
                    ],
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      }),
    };

    const ctx = mockCtx(supabaseMock);
    const res = (await listPipelineStagesTool.handler({}, ctx)) as {
      pipelines: Array<{
        id: string;
        name: string;
        stages: Array<{ id: string; name: string }>;
      }>;
    };

    expect(res.pipelines.length).toBe(1);
    expect(res.pipelines[0]?.name).toBe("Comercial");
    expect(res.pipelines[0]?.stages.length).toBe(2);
    expect(res.pipelines[0]?.stages[0]?.name).toBe("Novo");
  });
});

describe("ChatGPT MCP Tools - upsert_lead_contact", () => {
  it("atualiza telefone e normaliza para E.164 preservando force_human=true e dados existentes", async () => {
    let updatedPatch: Record<string, unknown> | null = null;
    let activityEmitted = false;

    const currentContact = {
      id: CONTACT_ID,
      name: "Dr. Roberto",
      display_name: "Dr. Roberto",
      phone_number: "+5531988888888",
      email: "roberto@exemplo.com",
      force_human: true,
      is_blocked: false,
    };

    const supabaseMock = {
      from: vi.fn((table: string) => {
        if (table === "crm_leads") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: LEAD_ID,
                      contact_id: CONTACT_ID,
                      organization_id: ORG_ID,
                      stage_id: STAGE_ID,
                      pipeline_id: PIPELINE_ID,
                      title: "Lead Dr. Roberto",
                    },
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "contacts") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: currentContact }),
                  single: async () => ({
                    data: {
                      ...currentContact,
                      phone_number: "+5531999999999",
                    },
                  }),
                }),
                in: () => ({
                  neq: () => ({
                    limit: () => ({
                      maybeSingle: async () => ({ data: null }),
                    }),
                  }),
                }),
              }),
            }),
            update: (patch: Record<string, unknown>) => {
              updatedPatch = patch;
              return {
                eq: () => ({
                  eq: async () => ({ error: null }),
                }),
              };
            },
          };
        }
        if (table === "conversations") {
          return {
            select: () => ({
              eq: () => ({
                eq: async () => ({
                  data: [{ status: "open", assignee_kind: "user", bot_silenced_until: "infinity" }],
                }),
              }),
            }),
          };
        }
        if (table === "crm_lead_activities") {
          return {
            insert: async () => {
              activityEmitted = true;
              return { error: null };
            },
          };
        }
        return {};
      }),
    };

    const ctx = mockCtx(supabaseMock);
    const res = (await upsertLeadContactTool.handler(
      {
        lead_id: LEAD_ID,
        contact_phone: "31999999999",
      },
      ctx,
    )) as Record<string, unknown>;

    expect(res["action"]).toBe("updated");
    expect(res["lead_id"]).toBe(LEAD_ID);
    expect(res["contact_id"]).toBe(CONTACT_ID);
    expect(res["phone_number"]).toBe("+5531999999999");
    expect(res["force_human"]).toBe(true);
    expect(res["can_xavier_respond"]).toBe(false);
    expect(updatedPatch).toEqual({ phone_number: "+5531999999999" });
    expect(activityEmitted).toBe(true);
  });

  it("impede duplicação de telefone na mesma organização se outro contato já o possui", async () => {
    const OTHER_CONTACT_ID = "00000000-0000-4000-8000-000000000099";
    const currentContact = {
      id: CONTACT_ID,
      name: "Dr. Roberto",
      phone_number: "+5531988888888",
      email: "roberto@exemplo.com",
      force_human: false,
      is_blocked: false,
    };

    const supabaseMock = {
      from: vi.fn((table: string) => {
        if (table === "crm_leads") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: LEAD_ID,
                      contact_id: CONTACT_ID,
                      organization_id: ORG_ID,
                    },
                  }),
                }),
              }),
            }),
          };
        }
        if (table === "contacts") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: currentContact }),
                }),
                in: () => ({
                  neq: () => ({
                    limit: () => ({
                      maybeSingle: async () => ({ data: { id: OTHER_CONTACT_ID } }),
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        return {};
      }),
    };

    const ctx = mockCtx(supabaseMock);
    await expect(
      upsertLeadContactTool.handler(
        {
          lead_id: LEAD_ID,
          contact_phone: "+5531999999999",
        },
        ctx,
      ),
    ).rejects.toThrow(/já pertence a outro contato/);
  });

  it("vincula contato existente pelo telefone quando o lead não possui contact_id", async () => {
    let linkedContactId: string | null = null;
    const EXISTING_CONTACT_ID = "00000000-0000-4000-8000-000000000055";
    const existingContact = {
      id: EXISTING_CONTACT_ID,
      name: "Dra. Caroline Oliveira",
      display_name: "Dra. Caroline Oliveira",
      phone_number: "+5531977777777",
      email: "caroline@exemplo.com",
      force_human: true,
      is_blocked: false,
    };

    const supabaseMock = {
      from: vi.fn((table: string) => {
        if (table === "crm_leads") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: LEAD_ID,
                      contact_id: null,
                      organization_id: ORG_ID,
                      stage_id: STAGE_ID,
                      title: "Dra. Caroline Oliveira",
                    },
                  }),
                }),
              }),
            }),
            update: (patch: { contact_id: string }) => {
              linkedContactId = patch.contact_id;
              return {
                eq: () => ({
                  eq: async () => ({ error: null }),
                }),
              };
            },
          };
        }
        if (table === "contacts") {
          return {
            select: () => {
              const chain: Record<string, unknown> = {};
              chain.eq = () => chain;
              chain.in = () => chain;
              chain.limit = () => chain;
              chain.maybeSingle = async () => ({ data: existingContact });
              chain.single = async () => ({ data: existingContact });
              return chain;
            },
          };
        }
        if (table === "conversations") {
          return {
            select: () => ({
              eq: () => ({
                eq: async () => ({ data: [] }),
              }),
            }),
          };
        }
        if (table === "crm_lead_activities") {
          return {
            insert: async () => ({ error: null }),
          };
        }
        return {};
      }),
    };

    const ctx = mockCtx(supabaseMock);
    const res = (await upsertLeadContactTool.handler(
      {
        lead_id: LEAD_ID,
        contact_phone: "+5531977777777",
      },
      ctx,
    )) as Record<string, unknown>;

    expect(res["action"]).toBe("linked_existing");
    expect(res["contact_id"]).toBe(EXISTING_CONTACT_ID);
    expect(linkedContactId).toBe(EXISTING_CONTACT_ID);
    expect(res["force_human"]).toBe(true);
    expect(res["can_xavier_respond"]).toBe(false);
  });

  it("cria e vincula novo contato quando o lead não possui contact_id e telefone não existe", async () => {
    let createdContact: Record<string, unknown> | null = null;
    let linkedContactId: string | null = null;
    const NEW_CONTACT_ID = "00000000-0000-4000-8000-000000000077";

    const supabaseMock = {
      from: vi.fn((table: string) => {
        if (table === "crm_leads") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: LEAD_ID,
                      contact_id: null,
                      organization_id: ORG_ID,
                      stage_id: STAGE_ID,
                      title: "Lead Novo",
                    },
                  }),
                }),
              }),
            }),
            update: (patch: { contact_id: string }) => {
              linkedContactId = patch.contact_id;
              return {
                eq: () => ({
                  eq: async () => ({ error: null }),
                }),
              };
            },
          };
        }
        if (table === "contacts") {
          return {
            select: () => {
              const chain: Record<string, unknown> = {};
              chain.eq = () => chain;
              chain.in = () => chain;
              chain.limit = () => chain;
              chain.maybeSingle = async () => ({ data: null });
              chain.single = async () => ({
                data: {
                  id: NEW_CONTACT_ID,
                  name: "Novo Cliente",
                  display_name: "Novo Cliente",
                  phone_number: "+5531966666666",
                  email: "novo@exemplo.com",
                  force_human: false,
                  is_blocked: false,
                },
              });
              return chain;
            },
            insert: (payload: Record<string, unknown>) => {
              createdContact = payload;
              return {
                select: () => ({
                  single: async () => ({
                    data: {
                      id: NEW_CONTACT_ID,
                      name: payload["name"],
                      display_name: payload["name"],
                      phone_number: payload["phone_number"],
                      email: payload["email"],
                      force_human: false,
                      is_blocked: false,
                    },
                  }),
                }),
              };
            },
          };
        }
        if (table === "conversations") {
          return {
            select: () => ({
              eq: () => ({
                eq: async () => ({ data: [] }),
              }),
            }),
          };
        }
        if (table === "crm_lead_activities") {
          return {
            insert: async () => ({ error: null }),
          };
        }
        return {};
      }),
    };

    const ctx = mockCtx(supabaseMock);
    const res = (await upsertLeadContactTool.handler(
      {
        lead_id: LEAD_ID,
        contact_name: "Novo Cliente",
        contact_phone: "(31) 96666-6666",
        contact_email: "novo@exemplo.com",
      },
      ctx,
    )) as Record<string, unknown>;

    expect(res["action"]).toBe("created_and_linked");
    expect(res["contact_id"]).toBe(NEW_CONTACT_ID);
    expect(linkedContactId).toBe(NEW_CONTACT_ID);
    expect(createdContact).toMatchObject({
      organization_id: ORG_ID,
      name: "Novo Cliente",
      phone_number: "+5531966666666",
      email: "novo@exemplo.com",
      source: "mcp_chatgpt",
    });
    expect(res["force_human"]).toBe(false);
    expect(res["can_xavier_respond"]).toBe(true);
  });

  it("respeita isolamento por organização rejeitando lead de outro tenant", async () => {
    const supabaseMock = {
      from: vi.fn((table: string) => {
        if (table === "crm_leads") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: null }),
                }),
              }),
            }),
          };
        }
        return {};
      }),
    };

    const ctx = mockCtx(supabaseMock);
    await expect(
      upsertLeadContactTool.handler(
        {
          lead_id: LEAD_ID,
          contact_name: "Invasor",
        },
        ctx,
      ),
    ).rejects.toThrow("Lead não encontrado nesta organização.");
  });
});

