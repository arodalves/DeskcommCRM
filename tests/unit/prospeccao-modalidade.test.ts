import { describe, it, expect, vi } from "vitest";
import { prospectingConversationContext } from "@/lib/prospecting/context";
import { orientacaoDaSequencia, temAvisoDeSaida } from "@/lib/prospecting/sequencia-de-abordagem";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
const a = "10000000-0000-4000-8000-000000000001";
const b = "10000000-0000-4000-8000-000000000002";
const aviso = "Se preferir não receber novos contatos, pode me avisar.";
function db(agent = a, channel = b, provider = "waha", history: object[] = []) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("prospecting_candidates"))
      return {
        rows: [
          {
            provider,
            config: {
              agent_id: agent,
              channel_session_id: channel,
              pipeline_id: a,
              stage_id: a,
              qualified_stage_id: b,
              instruction: "Oferta comercial Fluxalvo",
              qualification: "Necessidade confirmada",
              legal_basis_ref: "LIA",
            },
          },
        ],
      };
    return {
      rows: sql.includes("limit 10")
        ? [{ direction: "inbound", body: "Sou a Ana", status: "delivered" }, ...history]
        : history,
    };
  });
  return { query };
}
describe("isolamento da modalidade de prospecção ativa", () => {
  it.each([
    [a, b],
    [b, a],
  ])("aceita agente %s explicitamente vinculado à conexão %s", async (agent, channel) => {
    const d = db(agent, channel);
    const result = await prospectingConversationContext(
      d as unknown as Queryable,
      "org",
      "conv",
      agent,
      channel,
    );
    expect(result).toContain("motivo comercial");
    const [sql, args] = d.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("v.contact_id=p.contact_id");
    expect(sql).toContain("initial.status in ('sent','delivered','read')");
    expect(sql).toContain("c.config->>'agent_id'=$3");
    expect(sql).toContain("s.id::text=$4");
    expect(args).toEqual(["org", "conv", agent, channel]);
  });
  it.each([
    [b, b],
    [a, a],
    [undefined, b],
    [a, undefined],
  ])("não aplica com identidade ou conexão divergente/ausente", async (agent, channel) => {
    expect(
      await prospectingConversationContext(db() as unknown as Queryable, "org", "conv", agent, channel),
    ).toBe("");
  });
  it("Meta receptiva não recebe a sequência mesmo que haja configuração de campanha", async () => {
    expect(
      await prospectingConversationContext(
        db(a, b, "meta_cloud") as unknown as Queryable,
        "org",
        "conv",
        a,
        b,
      ),
    ).toBe("");
  });
  it("contato receptivo sem candidato não recebe contexto", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    expect(
      await prospectingConversationContext({ query } as unknown as Queryable, "org", "conv", a, b),
    ).toBe("");
    expect(query).toHaveBeenCalledTimes(1);
  });
  it.each(["failed", "queued", "sending", undefined])(
    "aviso com status %s não suprime saída",
    async (status) => {
      const d = db(a, b, "waha", [{ direction: "outbound", body: aviso, status }]);
      expect(await prospectingConversationContext(d as unknown as Queryable, "org", "conv", a, b)).toContain(
        "uma única vez",
      );
    },
  );
  it.each(["sent", "delivered", "read"])("aviso com status %s evita duplicação", async (status) => {
    const d = db(a, b, "waha", [{ direction: "outbound", body: aviso, status }]);
    expect(await prospectingConversationContext(d as unknown as Queryable, "org", "conv", a, b)).toContain(
      "Não repita esse aviso",
    );
  });
  it.each([
    "Não consegui contato com o responsável.",
    "Não vamos receber mercadoria.",
    "Precisamos parar a produção.",
  ])("não trata texto operacional como aviso: %s", (texto) => {
    expect(temAvisoDeSaida(texto)).toBe(false);
    expect(
      orientacaoDaSequencia([
        { direction: "inbound", body: "Olá" },
        { direction: "outbound", body: texto, status: "sent" },
      ]),
    ).toContain("uma única vez");
  });
  it("falha de leitura de histórico não presume apresentação", async () => {
    const d = db();
    d.query.mockRejectedValueOnce(new Error("offline"));
    await expect(
      prospectingConversationContext(d as unknown as Queryable, "org", "conv", a, b),
    ).rejects.toThrow("offline");
  });
});
