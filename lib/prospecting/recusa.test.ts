// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  inbox: vi.fn(),
  lead: { pipeline_id: "pipeline", status: "open" },
}));
vi.mock("@/lib/leads/encerramento", () => ({ encerraDemanda: mocks.close }));
vi.mock("@/lib/agent-engine/db/repository", () => ({ insertInboxItem: mocks.inbox }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: mocks.lead, error: null }),
      };
      return q;
    },
  }),
}));
import { aplicarRecusaDeProspeccao } from "./recusa";
const input = {
  org: "org",
  contactId: "ct",
  conversationId: "v",
  agentId: "gael",
  channelId: "2442",
  texto: "Já tenho alguém  obrigado ok",
  requestId: "run",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.lead = { pipeline_id: "pipeline", status: "open" };
  mocks.close.mockResolvedValue({ jaEstava: false });
});
function pool(found = true) {
  return {
    query: vi.fn(async (sql: string) => ({
      rows:
        sql.startsWith("select p.id") && found
          ? [{ id: "candidate", lead_id: "lead", pipeline_id: "pipeline" }]
          : [],
    })),
  };
}
it("Odair: cancela tentativas e move o card pelo escritor canônico com motivo e evidência", async () => {
  const db = pool();
  expect(await aplicarRecusaDeProspeccao(db as never, input)).toBe(true);
  expect(mocks.close).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ organization_id: "org" }),
    expect.objectContaining({
      leadId: "lead",
      desfecho: "lost",
      motivo: "other",
      payloadNaTimeline: expect.objectContaining({ evidence_text: input.texto }),
    }),
  );
  expect(db.query.mock.calls[1]![0]).toContain("status='cancelled'");
  expect(db.query.mock.calls[0]![0]).toContain("c.config->>'channel_session_id'=$5");
});
it("sem vínculo à campanha não altera atendimento receptivo", async () => {
  expect(
    await aplicarRecusaDeProspeccao(pool(false) as never, {
      ...input,
      agentId: "xavier",
      channelId: "1266",
    }),
  ).toBe(false);
  expect(mocks.close).not.toHaveBeenCalled();
});
it("CRM existente é informação; não recusa nem encerra", async () => {
  const db = pool();
  expect(await aplicarRecusaDeProspeccao(db as never, { ...input, texto: "Já temos CRM" })).toBe(
    false,
  );
  expect(mocks.close).not.toHaveBeenCalled();
});
it("resposta ambígua abre revisão sem movimentar o card", async () => {
  expect(
    await aplicarRecusaDeProspeccao(pool() as never, { ...input, texto: "Já tenho alguém" }),
  ).toBe(true);
  expect(mocks.inbox).toHaveBeenCalled();
  expect(mocks.close).not.toHaveBeenCalled();
});
it("retry de negócio perdido não repete movimentação nem atividade", async () => {
  mocks.lead.status = "lost";
  expect(await aplicarRecusaDeProspeccao(pool() as never, input)).toBe(true);
  expect(mocks.close).not.toHaveBeenCalled();
});
it("falha no encerramento deixa revisão visível e preserva cancelamento", async () => {
  mocks.close.mockRejectedValue(new Error("required_fields"));
  const db = pool();
  expect(await aplicarRecusaDeProspeccao(db as never, input)).toBe(true);
  expect(mocks.inbox).toHaveBeenCalled();
  expect(db.query.mock.calls[1]![0]).toContain("commercial_refusal");
});

it.skipIf(!process.env.MCP_READ_TEST_DATABASE_URL)(
  "SQL real: recusa cancela apenas a conversa e organização de origem",
  async () => {
    const { Pool } = await import("pg");
    const url = new URL(process.env.MCP_READ_TEST_DATABASE_URL!);
    if (url.hostname !== "127.0.0.1") throw new Error("Banco deve ser local");
    const db = new Pool({ connectionString: url.href, max: 1 });
    try {
      await db.query(`
      create temporary table prospecting_candidates(id text,organization_id text,lead_id text,campaign_id text,contact_id text,conversation_id text,status text,provider_accepted_at timestamptz,data jsonb,updated_at timestamptz);
      create temporary table prospecting_campaigns(id text,organization_id text,config jsonb);
      create temporary table contacts(id text,organization_id text,force_human bool);
      create temporary table conversations(id text,organization_id text,contact_id text,active_ai_agent_id text,channel_session_id text,assigned_to_user_id text,status text,service_closed_at timestamptz,status_changed_at timestamptz);
      create temporary table followup_enrollments(id text,organization_id text,prospecting_candidate_id text,status text,cancel_reason text,completed_at timestamptz,next_eval_at timestamptz,claimed_until timestamptz,updated_at timestamptz,revision int default 0);
      create temporary table cron_jobs(id text,organization_id text,contact_id text,enabled bool,job_kind text,payload jsonb,updated_at timestamptz);
      insert into prospecting_candidates values('candidate','org','lead','campaign','ct','v','sent',now(),'{}',now());
      insert into prospecting_campaigns values('campaign','org','{"agent_id":"gael","channel_session_id":"2442","pipeline_id":"pipeline"}');
      insert into contacts values('ct','org',false);
      insert into conversations values('v','org','ct','gael','2442',null,'open',null,null);
      insert into followup_enrollments(id,organization_id,prospecting_candidate_id,status) values('one','org','candidate','active'),('other','other-org','candidate','active');
      insert into cron_jobs values('one','org','ct',true,'followup_turn','{"service_boundary":{"conversation_id":"v"}}',now()),('xavier','org','ct',true,'followup_turn','{"service_boundary":{"conversation_id":"other-conversation"}}',now());
    `);
      expect(await aplicarRecusaDeProspeccao(db, input)).toBe(true);
      expect(
        (await db.query("select data ? 'commercial_refusal' refused from prospecting_candidates"))
          .rows[0].refused,
      ).toBe(true);
      expect((await db.query("select status from conversations")).rows[0].status).toBe("closed");
      expect(
        (await db.query("select status from followup_enrollments where id='one'")).rows[0].status,
      ).toBe("cancelled");
      expect(
        (await db.query("select status from followup_enrollments where id='other'")).rows[0].status,
      ).toBe("active");
      expect((await db.query("select enabled from cron_jobs where id='one'")).rows[0].enabled).toBe(
        false,
      );
      expect(
        (await db.query("select enabled from cron_jobs where id='xavier'")).rows[0].enabled,
      ).toBe(true);
    } finally {
      await db.end();
    }
  },
);
