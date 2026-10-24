// @vitest-environment node
import { describe, expect, it } from "vitest";
import { sinaisComerciais } from "@/lib/prospecting/sinais-comerciais";
import { eventoDeProspeccaoElegivel } from "@/lib/prospecting/evento-elegivel";
import { ORIENTACAO_CONSULTIVA } from "@/lib/prospecting/orientacao-consultiva";

describe("evidência comercial sem custo de IA", () => {
  it.each(["Já tenho alguém, obrigado", "Já tenho alguém  obrigado ok", "Não tenho interesse"])(
    "Odair: recusa explícita %s",
    (t) => {
      expect(sinaisComerciais(t)).toMatchObject({ recusa: true, interesse: false });
    },
  );
  it.each([
    "Já temos CRM",
    "Já tenho alguém",
    "Já tenho alguém, mas preciso integrar o site. Obrigado",
    "Já temos CRM, como funciona a integração?",
  ])("objeção negociável: %s", (t) => {
    expect(sinaisComerciais(t).recusa).toBe(false);
  });
  it.each([
    "Taby Planejados agradece seu contato. Como podemos ajudar?",
    "Lumen Planejados agradece seu contato. Como podemos ajudar?",
    "Dione Móveis Planejados agradece seu contato. Para orçamento se for possível favor já enviar os detalhes, assim que possível retornarei",
    "Estamos ausentes, retornaremos em breve",
  ])("resposta automática aparente: %s", (t) => {
    expect(sinaisComerciais(t)).toMatchObject({
      automatica: true,
      interesse: false,
      humanaInferida: false,
      recusa: false,
    });
  });
  it("saudação isolada e mídia sem texto continuam desconhecidas", () => {
    for (const t of ["Boa tarde Adriano", "Sim !", "", null])
      expect(sinaisComerciais(t).humanaInferida).toBe(false);
  });
  it("Idalane: o texto de aplicação preserva a opção do CRM existente", () => {
    expect(ORIENTACAO_CONSULTIVA).toContain("não insista em substituir o CRM");
    expect(ORIENTACAO_CONSULTIVA).toContain("Não ofereça pré-site pronto");
  });
});

const event = {
  candidate_id: "p",
  campaign_id: "c",
  contact_id: "ct",
  conversation_id: "v",
  message_id: "m",
};
function database(overrides: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    prospecting_candidates: {
      id: "p",
      campaign_id: "c",
      contact_id: "ct",
      conversation_id: "v",
      message_id: "m",
      status: "sent",
      provider_accepted_at: "2026-10-23T12:00:00Z",
      data: {},
    },
    prospecting_campaigns: {
      status: "running",
      config: { agent_id: "gael", channel_session_id: "2442" },
    },
    conversations: { status: "open", active_ai_agent_id: "gael", channel_session_id: "2442" },
    contacts: {},
    message: {
      status: "sent",
      external_id: "provider-id",
      sent_at: "2026-10-23T12:00:01Z",
      conversation_id: "v",
      direction: "outbound",
      sent_via: "ai",
    },
    inbounds: [],
    ...overrides,
  };
  const filters: Array<[string, string, unknown]> = [];
  const db = {
    from(table: string) {
      let inbound = false;
      const q = {
        select() {
          return q;
        },
        eq(k: string, v: unknown) {
          filters.push([table, k, v]);
          if (k === "direction" && v === "inbound") inbound = true;
          return q;
        },
        gte() {
          return q;
        },
        order() {
          return q;
        },
        limit() {
          return q;
        },
        maybeSingle() {
          return Promise.resolve({
            data: table === "messages" ? data.message : data[table],
            error: null,
          });
        },
        then(resolve: (r: unknown) => unknown) {
          return Promise.resolve(
            resolve({ data: inbound ? data.inbounds : data[table], error: null }),
          );
        },
      };
      return q;
    },
  };
  return { db: db as never, filters };
}
describe("inscrição exige prova atual, agente e conexão da campanha", () => {
  it("aceite auditável pode armar; todas as consultas isolam organização", async () => {
    const { db, filters } = database();
    expect(await eventoDeProspeccaoElegivel(db, "org", event, false)).toMatchObject({
      agentId: "gael",
    });
    for (const table of [
      "prospecting_candidates",
      "prospecting_campaigns",
      "conversations",
      "contacts",
      "messages",
    ])
      expect(filters).toContainEqual([table, "organization_id", "org"]);
  });
  it.each(["sending", "queued", "failed"])("envio %s não arma", async (status) => {
    const { db } = database({ message: { status } });
    expect(await eventoDeProspeccaoElegivel(db, "org", event, false)).toBeNull();
  });
  it.each([
    { force_human: true },
    { is_blocked: true },
    { ai_opt_out: true },
    { consent: { marketing: { opt_out: true } } },
  ])("handoff, bloqueio e opt-out impedem inscrição", async (contact) => {
    const { db } = database({ contacts: contact });
    expect(await eventoDeProspeccaoElegivel(db, "org", event, false)).toBeNull();
  });
  it("Xavier / conexão oficial não entram pela campanha de Gael", async () => {
    const { db } = database({
      conversations: { status: "open", active_ai_agent_id: "xavier", channel_session_id: "1266" },
    });
    expect(await eventoDeProspeccaoElegivel(db, "org", event, false)).toBeNull();
  });
  it.each([
    "Já tenho alguém  obrigado ok",
    "Oi",
    "Lumen Planejados agradece seu contato. Como podemos ajudar?",
  ])("não arma conversa interrompida por %s", async (body) => {
    const { db } = database({ inbounds: [{ body, created_at: "2026-10-23T12:00:00Z" }] });
    expect(await eventoDeProspeccaoElegivel(db, "org", event, true)).toBeNull();
  });
  it("conversa comercial genuína e envio aceito armam a interrupção", async () => {
    const { db } = database({
      inbounds: [{ body: "Como funciona a integração?", created_at: "2026-10-23T12:00:00Z" }],
    });
    expect(await eventoDeProspeccaoElegivel(db, "org", event, true)).toMatchObject({
      agentId: "gael",
    });
  });
});
