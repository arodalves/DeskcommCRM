// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpContext } from "@/lib/mcp/types";
import type { McpAuthResult } from "@/lib/mcp/auth";

const state = vi.hoisted(() => ({ pool: null as pg.Pool | null }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => state.pool! }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn() }));
vi.mock("@/lib/mcp/rate-limit", () => ({ verificarTetoMcp: vi.fn() }));
import {
  listProspectingCampaignsTool as campaigns,
  listCampaignConversationsTool as conversations,
  getLeadConversationTool as history,
  getCampaignProspectingSummaryTool as summary,
  readPosition,
  writePosition,
  prospectingReadTools,
} from "./prospecting-read";
import { createChatGptMcpServer } from "./server";
import { auditMcpToolCall } from "@/lib/mcp/audit";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ctx = {
  organizationId: id(1),
  apiTokenId: id(2),
  role: "agent",
  actor: { type: "api_token", id: id(2) },
} as McpContext;
const call = async (
  tool: typeof campaigns | typeof conversations | typeof history | typeof summary,
  input: unknown,
  context = ctx,
) => (await tool.handler(input as never, context)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(() => {
  vi.stubEnv("INTERNAL_SECRET", "test-commercial-cursor-secret");
});
afterAll(() => vi.unstubAllEnvs());

describe("contrato e cursores das consultas comerciais", () => {
  it("declara quatro ferramentas somente leitura, com limites validados e auditoria sem PII", () => {
    expect(prospectingReadTools.map((t) => t.name)).toHaveLength(4);
    for (const tool of prospectingReadTools) {
      expect(tool.category).toBe("read");
      expect(tool.requiresScope).toBe("mcp:read");
      expect(tool.requiresRole).toBe("agent");
      expect(
        tool.redigirParaAuditoria!({ campaign_name: "PII", lead_id: id(20), cursor: "secret" }),
      ).toEqual({ read_only: true });
    }
    for (const limit of [0, -1, 101, 1.5, "10"])
      expect(z.object(history.inputSchema).safeParse({ lead_id: id(20), limit }).success).toBe(
        false,
      );
    expect(z.object(history.inputSchema).parse({ lead_id: id(20) }).limit).toBe(25);
  });
  it("vincula cursor à organização, ator, ferramenta e filtros; detecta adulteração", () => {
    const input = { limit: 1, order: "asc", status: "sent" };
    const token = writePosition(
      ctx,
      "test",
      input,
      "2026-01-01T00:00:00.000Z",
      id(30),
      "2026-01-02T00:00:00.000Z",
    );
    expect(readPosition(ctx, "test", { ...input, cursor: token })!.id).toBe(id(30));
    for (const context of [
      { ...ctx, organizationId: id(9) },
      { ...ctx, apiTokenId: id(9) },
      { ...ctx, role: "viewer" as const },
    ]) {
      expect(() => readPosition(context, "test", { ...input, cursor: token })).toThrow("Cursor");
    }
    expect(() => readPosition(ctx, "other", { ...input, cursor: token })).toThrow("Cursor");
    expect(() => readPosition(ctx, "test", { ...input, status: "failed", cursor: token })).toThrow(
      "Cursor",
    );
    expect(() => readPosition(ctx, "test", { ...input, cursor: token + "x" })).toThrow("Cursor");
    expect(() => readPosition(ctx, "test", { ...input, cursor: "invalid" })).toThrow("Cursor");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 3_600_001);
    expect(() => readPosition(ctx, "test", { ...input, cursor: token })).toThrow("Cursor");
    vi.restoreAllMocks();
  });
  it("rejeita seletor ausente, duplo e papel insuficiente antes de consultar", async () => {
    await expect(call(summary, {})).rejects.toThrow();
    await expect(call(summary, { campaign_id: id(10), campaign_name: "x" })).rejects.toThrow();
    await expect(call(history, { lead_id: id(20) }, { ...ctx, role: "viewer" })).rejects.toThrow(
      "insufficient",
    );
  });
  it("SDK tools/list publica schemas e readOnlyHint; tools/call preserva autorização de papel e escopo", async () => {
    for (const auth of [
      { ...ctx, scopes: [] },
      { ...ctx, role: "viewer", scopes: ["mcp:read"] },
    ]) {
      const server = createChatGptMcpServer(auth as McpAuthResult, "test");
      const client = new Client({ name: "commercial-test", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const listed = await client.listTools();
        expect(listed.tools).toHaveLength(16);
        for (const tool of prospectingReadTools) {
          const exposed = listed.tools.find((t) => t.name === tool.name)!;
          expect(exposed.annotations?.readOnlyHint).toBe(true);
          expect(exposed.inputSchema.type).toBe("object");
        }
        const result = await client.callTool({
          name: "get_lead_conversation",
          arguments: { lead_id: id(20) },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toMatch(/scope|insufficient/);
        expect(vi.mocked(auditMcpToolCall).mock.calls.at(-1)![0].args).toEqual({ read_only: true });
      } finally {
        await client.close();
        await server.close();
      }
    }
  });
});

// Executa SQL real sobre tabelas TEMPORÁRIAS; não lê nem modifica dados da instalação.
describe.skipIf(!process.env.MCP_READ_TEST_DATABASE_URL)(
  "consultas comerciais — PostgreSQL real",
  () => {
    beforeAll(async () => {
      const url = new URL(process.env.MCP_READ_TEST_DATABASE_URL!);
      if (!["127.0.0.1", "localhost"].includes(url.hostname))
        throw new Error("Banco de teste deve ser local");
      state.pool = new pg.Pool({ connectionString: url.href, max: 1 });
      await state.pool.query(`
      create temporary table prospecting_campaigns(id uuid,organization_id uuid,name text,config jsonb,search jsonb,status text,search_status text,result_count int,skipped_count int,created_at timestamptz,updated_at timestamptz,next_send_at timestamptz);
      create temporary table prospecting_candidates(id uuid,organization_id uuid,campaign_id uuid,data jsonb,status text,created_at timestamptz,attempted_at timestamptz,lead_id uuid,contact_id uuid,conversation_id uuid,message_id uuid,service_boundary jsonb);
      create temporary table crm_leads(id uuid,organization_id uuid,contact_id uuid,title text,stage_id uuid,status text);
      create temporary table contacts(id uuid,organization_id uuid,name text,display_name text,phone_number text,ai_opt_out bool,is_blocked bool,force_human bool);
      create temporary table conversations(id uuid,organization_id uuid,contact_id uuid,active_ai_agent_id uuid,channel_session_id uuid,last_handoff_at timestamptz,last_handoff_reason text,status text default 'open',service_closed_at timestamptz);
      create temporary table crm_stages(id uuid,organization_id uuid,name text,is_lost bool);
      create temporary table ai_agents(id uuid,organization_id uuid,name text);
      create temporary table channel_sessions(id uuid,organization_id uuid,phone_number text);
      create temporary table messages(id uuid,organization_id uuid,contact_id uuid,conversation_id uuid,body text,type text,direction text,created_at timestamptz,sent_at timestamptz,status text,delivered_at timestamptz,read_at timestamptz,sent_via text,sent_by_user_id uuid,media_mime text,media_size_bytes int,media_storage_path text,media_url text,metadata jsonb default '{}',revoked_at timestamptz,service_revision int);
    `);
      for (const org of [1, 9]) {
        await state.pool.query(
          `insert into prospecting_campaigns values($1,$2,$3,$4,'{"niche":"Móveis","location":"Betim"}','paused','succeeded',4,1,'2026-01-01','2026-01-01','2026-01-02')`,
          [
            id(org === 1 ? 10 : 19),
            id(org),
            "Móveis planejados — Betim",
            { qualified_stage_id: id(50), agent_id: id(60), channel_session_id: id(70) },
          ],
        );
      }
      await state.pool.query(`insert into crm_stages values($1,$2,'Qualificado',false);`, [
        id(50),
        id(1),
      ]);
      await state.pool.query(`insert into ai_agents values($1,$2,'Xavier')`, [id(60), id(1)]);
      await state.pool.query(`insert into channel_sessions values($1,$2,'553100000000')`, [
        id(70),
        id(1),
      ]);
      for (let n = 0; n < 4; n++) {
        await state.pool.query(
          `insert into contacts values($1,$2,'Contato',null,'553100000001',$3,false,$4)`,
          [id(100 + n), id(1), n === 3, n === 1],
        );
        await state.pool.query(`insert into crm_leads values($1,$2,$3,'Empresa',$4,'open')`, [
          id(20 + n),
          id(1),
          id(100 + n),
          n === 1 ? id(50) : null,
        ]);
        await state.pool.query(`insert into conversations values($1,$2,$3,$4,$5,null,null)`, [
          id(200 + n),
          id(1),
          id(100 + n),
          id(60),
          id(70),
        ]);
        await state.pool.query(
          `insert into prospecting_candidates values($1,$2,$3,'{"name":"Empresa"}',$4,'2026-01-02','2026-01-03',$5,$6,$7,$8,'{"service_revision":1}')`,
          [
            id(30 + n),
            id(1),
            id(10),
            ["sent", "sent", "failed", "queued"][n],
            id(20 + n),
            id(100 + n),
            id(200 + n),
            id(300 + n),
          ],
        );
        await state.pool.query(
          `insert into messages(id,organization_id,contact_id,conversation_id,body,type,direction,created_at,sent_at,status,sent_via,service_revision)
        values($1,$2,$3,$4,'Abordagem','text','outbound','2026-01-03','2026-01-03',$5,'ai',1)`,
          [
            id(300 + n),
            id(1),
            id(100 + n),
            id(200 + n),
            ["delivered", "read", "failed", "queued"][n],
          ],
        );
      }
      const inbound = async (
        n: number,
        num: number,
        body: string,
        metadata: object = {},
        revision = 1,
      ) =>
        state.pool!.query(
          `
      insert into messages(id,organization_id,contact_id,conversation_id,body,type,direction,created_at,sent_at,status,metadata,service_revision)
      values($1,$2,$3,$4,$5,'text','inbound','2026-01-04','2026-01-04','received',$6,$7)`,
          [id(num), id(1), id(100 + n), id(200 + n), body, metadata, revision],
        );
      await inbound(0, 400, "Mensagem automática: retornaremos em breve");
      await inbound(1, 401, "Tenho interesse", { response_kind: "human" });
      await inbound(1, 402, "Pode enviar uma proposta");
      await inbound(1, 403, "Mensagem automática: tenho interesse");
      await inbound(3, 404, "Não temos interesse");
      await inbound(0, 405, "Tenho interesse", {}, 2); // Outro atendimento não contamina a campanha.
      await state.pool.query(
        `insert into messages(id,organization_id,contact_id,conversation_id,body,type,direction,created_at,status) values($1,$2,$3,$4,'SEGREDO OUTRA ORG','text','inbound','2026-01-04','received')`,
        [id(499), id(9), id(100), id(200)],
      );
      await state.pool.query(
        `update messages set media_mime='audio/ogg',media_size_bytes=123,media_storage_path='private/path' where id=$1`,
        [id(402)],
      );
    }, 30_000);
    afterAll(async () => {
      await state.pool?.end();
    });

    it("lista campanhas com contagens sem vazamento por nome igual", async () => {
      const result = await call(campaigns, {});
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({
        id: id(10),
        companies_registered: 4,
        companies_approached: 2,
        companies_pending: 1,
        companies_failed: 1,
        agent_name: "Xavier",
        segment: "Móveis",
        location: "Betim",
      });
    });
    it("busca por nome, pagina empates sem duplicar e filtra respostas/status/acompanhamento", async () => {
      const first = await call(conversations, {
        campaign_name: "Móveis planejados — Betim",
        limit: 2,
      });
      const second = await call(conversations, {
        campaign_name: "Móveis planejados — Betim",
        limit: 2,
        cursor: first.meta.cursor,
      });
      expect([...first.data, ...second.data].map((r: { id: string }) => r.id)).toEqual(
        [30, 31, 32, 33].map(id),
      );
      expect(second.meta.has_more).toBe(false);
      for (const [filter, expected] of [
        [{ response: "automatic" }, [id(30)]],
        [{ response: "human" }, [id(31)]],
        [{ status: "failed" }, [id(32)]],
        [{ needs_follow_up: true }, [id(31), id(32)]],
      ] as const) {
        const result = await call(conversations, { campaign_id: id(10), ...filter });
        expect(result.data.map((r: { id: string }) => r.id)).toEqual(expected);
      }
    });
    it("isola campanha/lead alheios e nome ambíguo", async () => {
      await expect(call(conversations, { campaign_id: id(19) })).rejects.toThrow(
        "Campanha não encontrada",
      );
      await expect(call(history, { lead_id: id(99) })).rejects.toThrow("Lead não encontrado");
      const other = await call(campaigns, {}, { ...ctx, organizationId: id(9) });
      expect(other.data.map((r: { id: string }) => r.id)).toEqual([id(19)]);
      await state.pool!.query(
        `insert into prospecting_campaigns(id,organization_id,name,created_at) values($1,$2,$3,'2026-01-01')`,
        [id(11), id(1), "Móveis planejados — Betim"],
      );
      await expect(call(summary, { campaign_name: "Móveis planejados — Betim" })).rejects.toThrow(
        "ambígua",
      );
      await state.pool!.query("delete from prospecting_campaigns where id=$1", [id(11)]);
    });
    it("preserva texto integral e ordem cronológica em todas as páginas do histórico, sem baixar mídia", async () => {
      let cursor: string | undefined;
      const rows: Record<string, unknown>[] = [];
      do {
        const result = await call(history, {
          lead_id: id(21),
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        rows.push(...result.data);
        cursor = result.meta.cursor;
      } while (cursor);
      expect(rows.map((r) => r.id)).toEqual([id(301), id(401), id(402), id(403)]);
      expect(rows[0]!.sender).toBe("ai_agent");
      expect(rows[1]!.sender).toBe("client");
      expect(rows[1]!.body).toBe("Tenho interesse");
      expect(rows[2]).toMatchObject({
        media_mime: "audio/ogg",
        media_size_bytes: 123,
        media_available: true,
      });
      expect(rows[2]).not.toHaveProperty("media_storage_path");
      expect(JSON.stringify(rows)).not.toContain("SEGREDO");
    });
    it("indicadores integrais, automação nunca qualifica sozinha, denominadores e evidências", async () => {
      const result = await call(summary, { campaign_id: id(10) });
      expect(result.totals).toMatchObject({
        companies_total: 4,
        companies_prospected: 2,
        messages_sent: 2,
        messages_delivered: 2,
        messages_failed: 1,
        messages_pending: 1,
        contacts_replied: 3,
        contacts_human_confirmed: 1,
        contacts_automatic_inferred: 2,
        leads_qualified_confirmed: 1,
        leads_unqualified_confirmed: 0,
        leads_interest_inferred: 1,
        opt_outs_confirmed: 1,
        opportunities_needing_human_follow_up: 2,
      });
      expect(result.rates.response).toEqual({ numerator: 2, denominator: 2, value: 1 });
      expect(result.rates.qualification).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
      const filtered = await call(conversations, { campaign_id: id(10), response: "human" });
      expect(filtered.data[0].interest_evidence_message_ids).toEqual([id(401), id(402)]);
    });
    it("campanha vazia, histórico sem contato e taxas sem denominador", async () => {
      const result = await call(
        summary,
        { campaign_id: id(19) },
        { ...ctx, organizationId: id(9) },
      );
      expect(result.totals.companies_total).toBe(0);
      expect(result.rates.response).toEqual({ numerator: 0, denominator: 0, value: null });
      expect(
        (await call(conversations, { campaign_id: id(19) }, { ...ctx, organizationId: id(9) }))
          .data,
      ).toEqual([]);
      await state.pool!.query("insert into crm_leads(id,organization_id) values($1,$2)", [
        id(29),
        id(1),
      ]);
      expect((await call(history, { lead_id: id(29) })).data).toEqual([]);
    });
    it("READ ONLY rejeita escrita no banco real e rollback preserva conexão", async () => {
      const client = await state.pool!.connect();
      try {
        await client.query("begin read only");
        // Tabelas temporárias admitem escrita em read only: public prova a restrição real.
        await expect(
          client.query("create table public.must_not_exist(id int)"),
        ).rejects.toMatchObject({ code: "25006" });
        await client.query("rollback");
      } finally {
        client.release();
      }
      expect((await call(campaigns, {})).data).toHaveLength(1);
    });
    it("pagina timestamps com microssegundos sem repetir ou pular registros", async () => {
      await state.pool!.query(
        "update prospecting_candidates set created_at='2026-01-02T00:00:00.123456Z' where campaign_id=$1",
        [id(10)],
      );
      await state.pool!.query(
        "update prospecting_campaigns set created_at='2026-01-01T00:00:00.123456Z' where organization_id=$1",
        [id(1)],
      );
      await state.pool!.query(
        "insert into prospecting_campaigns(id,organization_id,name,created_at) values($1,$2,'Precision','2026-01-01T00:00:00.123456Z')",
        [id(12), id(1)],
      );
      await state.pool!.query(
        "update messages set sent_at='2026-01-04T00:00:00.123456Z' where id=any($1::uuid[])",
        [[id(401), id(402), id(403)]],
      );
      try {
        for (const order of ["asc", "desc"]) {
          const first = await call(conversations, { campaign_id: id(10), limit: 1, order });
          const next = await call(conversations, {
            campaign_id: id(10),
            limit: 1,
            order,
            cursor: first.meta.cursor,
          });
          expect(next.data[0].id).toBe(order === "asc" ? id(31) : id(32));
          const c1 = await call(campaigns, { limit: 1, order });
          const c2 = await call(campaigns, { limit: 1, order, cursor: c1.meta.cursor });
          expect([c1.data[0].id, c2.data[0].id]).toEqual(
            order === "asc" ? [id(10), id(12)] : [id(12), id(10)],
          );
        }
        const h1 = await call(history, { lead_id: id(21), limit: 2 });
        const h2 = await call(history, { lead_id: id(21), limit: 2, cursor: h1.meta.cursor });
        expect([...h1.data, ...h2.data].map((r: { id: string }) => r.id)).toEqual([
          id(301),
          id(401),
          id(402),
          id(403),
        ]);
      } finally {
        await state.pool!.query("delete from prospecting_campaigns where id=$1", [id(12)]);
      }
    });

    it("histórico distingue humano, mídia, falha e revogação; recusas não viram interesse", async () => {
      await state.pool!.query(
        `update messages set sent_via='user',sent_by_user_id=$1 where id=$2`,
        [id(88), id(302)],
      );
      await state.pool!.query(`update messages set revoked_at=now() where id=$1`, [id(400)]);
      const failed = await call(history, { lead_id: id(22) });
      expect(failed.data[0]).toMatchObject({ sender: "human", status: "failed" });
      const revoked = await call(history, { lead_id: id(20) });
      expect(revoked.data.find((r: { id: string }) => r.id === id(400))).toMatchObject({
        body: null,
        revoked: true,
      });
      const refused = await call(conversations, { campaign_id: id(10), response: "unknown" });
      expect(refused.data.find((r: { id: string }) => r.id === id(33))).toMatchObject({
        interest_inferred: false,
        refusal_inferred: true,
        needs_follow_up: false,
      });
    });
    it("pagina histórico pela data da mensagem mesmo quando foi registrada depois", async () => {
      await state.pool!.query(
        "update messages set sent_at='2026-01-02',created_at='2026-01-05' where id=$1",
        [id(402)],
      );
      const first = await call(history, { lead_id: id(21), limit: 1 });
      expect(first.data[0].id).toBe(id(402));
      const next = await call(history, { lead_id: id(21), limit: 1, cursor: first.meta.cursor });
      expect(next.data[0].id).toBe(id(301));
    });
    it.each([
      ["image", "image/png"],
      ["document", "application/pdf"],
    ])("retorna metadados mínimos de %s sem URL ou download", async (type, mime) => {
      await state.pool!.query(
        "update messages set type=$1,media_mime=$2,metadata=metadata || '{\"filename\":\"arquivo\"}'::jsonb,media_url='https://private.invalid/file' where id=$3",
        [type, mime, id(402)],
      );
      const result = await call(history, { lead_id: id(21) });
      expect(result.data[0]).toMatchObject({
        type,
        media_mime: mime,
        media_filename: "arquivo",
        media_available: true,
      });
      expect(result.data[0]).not.toHaveProperty("media_url");
    });
    it("Taby/Lumen, Odair e etapa isolada não inventam qualificação ou acompanhamento", async () => {
      await state.pool!.query("update crm_leads set stage_id=$1 where id=$2",[id(50),id(20)]);
      await state.pool!.query(`insert into messages(id,organization_id,contact_id,conversation_id,body,type,direction,created_at,sent_at,status,metadata,service_revision)
        values($1,$2,$3,$4,'Taby Planejados agradece seu contato. Como podemos ajudar?','text','inbound','2026-01-06','2026-01-06','received','{}',1)`,[id(550),id(1),id(100),id(200)]);
      let result=await call(conversations,{campaign_id:id(10)});
      expect(result.data.find((r:{id:string})=>r.id===id(30))).toMatchObject({pipeline_qualified:true,qualified_confirmed:false,human_inferred_count:0,needs_follow_up:false});
      await state.pool!.query("update messages set body='Já tenho alguém  obrigado ok' where id=$1",[id(550)]);
      result=await call(conversations,{campaign_id:id(10)});
      expect(result.data.find((r:{id:string})=>r.id===id(30))).toMatchObject({refusal_inferred:true,qualified_confirmed:false,needs_follow_up:false});
      await state.pool!.query("update messages set body='Boa tarde Adriano' where id=$1",[id(550)]);
      result=await call(conversations,{campaign_id:id(10)});
      expect(result.data.find((r:{id:string})=>r.id===id(30))).toMatchObject({response:'unknown',human_inferred_count:0,qualified_confirmed:false,needs_follow_up:false});
    });

  },
);
