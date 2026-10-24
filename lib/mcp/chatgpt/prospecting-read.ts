/** Consultas do MCP externo: nenhuma mutação nem chamada ao runtime dos agentes. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { ensureRole } from "@/lib/mcp/auth";
import type { McpContext, McpToolDefinition } from "@/lib/mcp/types";

const page = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .describe("Itens por página: 1 a 100; padrão 25."),
  cursor: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe("Cursor opaco retornado pela mesma ferramenta e filtros; expira em uma hora."),
};
const campaign = {
  campaign_id: z.string().uuid().optional().describe("ID da campanha; informe apenas ID ou nome."),
  campaign_name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe("Nome exato, sem diferenciar maiúsculas; em caso de nomes repetidos use ID."),
};
const selector = z
  .object(campaign)
  .strict()
  .refine(
    (i) => Boolean(i.campaign_id) !== Boolean(i.campaign_name),
    "Informe exatamente um de campaign_id ou campaign_name.",
  );
const listShape = {
  ...page,
  status: z.enum(["draft", "running", "paused", "completed"]).optional(),
  order: z
    .enum(["asc", "desc"])
    .default("desc")
    .describe("Ordenação por criação e ID, estável em empates."),
};
const conversationShape = {
  ...campaign,
  ...page,
  status: z.enum(["new", "queued", "sending", "sent", "skipped", "failed"]).optional(),
  response: z
    .enum(["none", "automatic", "human", "unknown"])
    .optional()
    .describe(
      "human requer registro explícito; automatic é interpretação textual; textos possivelmente humanos sem confirmação são unknown.",
    ),
  needs_follow_up: z
    .boolean()
    .optional()
    .describe(
      "Sinal de revisão humana (interesse, mensagem pendente de resposta, falha ou transferência), excluindo recusas e bloqueios.",
    ),
  order: z.enum(["asc", "desc"]).default("asc"),
};
const historyShape = {
  lead_id: z.string().uuid().describe("ID do lead na organização autorizada."),
  ...page,
};

const positionSchema = z
  .object({
    at: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
    snapshot: z.string().datetime({ offset: true }),
    expires: z.number().int(),
    scope: z.string(),
  })
  .strict();
type Position = z.infer<typeof positionSchema>;

function key() {
  const value = process.env.INTERNAL_SECRET;
  if (!value) throw new Error("Consulta indisponível: segredo da infraestrutura ausente.");
  return value;
}
function scope(ctx: McpContext, tool: string, input: Record<string, unknown>) {
  const { cursor: _cursor, limit: _limit, ...filters } = input;
  void _cursor;
  void _limit;
  return createHash("sha256")
    .update(
      JSON.stringify([
        "prospecting-read-v1",
        ctx.organizationId,
        ctx.apiTokenId,
        ctx.role,
        ctx.actor,
        tool,
        filters,
      ]),
    )
    .digest("hex");
}
export function readPosition(
  ctx: McpContext,
  tool: string,
  input: Record<string, unknown>,
): Position | null {
  if (!input.cursor) return null;
  try {
    const [body, signature, extra] = String(input.cursor).split(".");
    if (!body || !signature || extra) throw new Error();
    const expected = createHmac("sha256", key()).update(body).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const result = positionSchema.parse(
      JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
    );
    if (result.expires < Date.now() || result.scope !== scope(ctx, tool, input)) throw new Error();
    return result;
  } catch {
    throw new Error("Cursor inválido ou expirado para esta consulta.");
  }
}
export function writePosition(
  ctx: McpContext,
  tool: string,
  input: Record<string, unknown>,
  at: string,
  id: string,
  snapshot: string,
) {
  const body = Buffer.from(
    JSON.stringify({
      at,
      id,
      snapshot,
      expires: Date.now() + 3_600_000,
      scope: scope(ctx, tool, input),
    }),
  ).toString("base64url");
  return `${body}.${createHmac("sha256", key()).update(body).digest("base64url")}`;
}

/** A transação também protege contra escritas acidentais e consultas caras. */
async function readOnly<T>(ctx: McpContext, fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  ensureRole(ctx.role, "agent");
  const db = await getRequestPool().connect();
  let discard: Error | undefined;
  try {
    await db.query("begin isolation level repeatable read read only");
    await db.query("set local statement_timeout = '8s'");
    const result = await fn(db);
    await db.query("commit");
    return result;
  } catch (err) {
    try {
      await db.query("rollback");
    } catch {
      discard = new Error("read_transaction_failed");
    }
    if (err instanceof Error && /^(Cursor|Campanha|Lead|Informe)/.test(err.message)) throw err;
    throw new Error("Não foi possível consultar o histórico comercial. Tente novamente.");
  } finally {
    db.release(discard);
  }
}

async function resolveCampaign(db: pg.PoolClient, ctx: McpContext, raw: unknown) {
  const input = selector.parse(raw);
  const result = await db.query<{ id: string; name: string }>(
    `select id,name from prospecting_campaigns where organization_id=$1
      and ${input.campaign_id ? "id=$2::uuid" : "lower(name)=lower($2)"} limit 2`,
    [ctx.organizationId, input.campaign_id ?? input.campaign_name],
  );
  if (!result.rows.length) throw new Error("Campanha não encontrada ou sem permissão.");
  if (result.rows.length > 1) throw new Error("Campanha ambígua: utilize campaign_id.");
  return result.rows[0]!;
}

// Classificações textuais são INTERPRETAÇÕES. Ausência de padrão NÃO confirma humano.
// Não se aplicam a outbound, nem qualificam lead, nem atualizam qualquer estado.
const AUTO_RX =
  "mensagem autom[áa]tica|resposta autom[áa]tica|assistente virtual|fora do hor[áa]rio|hor[áa]rio de atendimento|n[ãa]o estamos dispon[íi]veis|estamos ausentes|deixe (seu nome|sua mensagem|seu recado|sua solicita[çc][ãa]o)|digite [1-9]|(escolha|selecione) uma op[çc][ãa]o|retornaremos.*breve|em breve (retornamos|retornaremos|responderemos)|assim que poss[íi]vel.*(retorno|retornaremos|responderemos|retornarei)|agradece(mos)? (seu |o |pelo )?contato.*(atendimento|responder|breve|como podemos ajudar)|obrigad[ao] pel[oe] (seu )?contato.*(atendimento|responder|breve)";
const INTEREST_RX =
  "tenho interesse|temos interesse|quero (conhecer|contratar|entender)|pode(m)? (me )?enviar (uma )?proposta|me apresente melhor o que tem a nos oferecer|quanto custa|qual (o )?(valor|pre[çc]o)|como funciona|precisamos integrar";
const REFUSAL_RX = "n[ãa]o (tenho|temos) interesse|n[ãa]o quero contratar|sem interesse|^j[áa] (tenho|temos) (algu[ée]m|uma pessoa|um fornecedor|uma ag[êe]ncia)[^?]*(obrigad[oa]|agrade[çc]o)([.! ]*(ok|tudo bem))?[.! ]*$";

/** Uma linha por candidato; nenhum JOIN de mensagens multiplica empresas. */
export const campaignRowsSql = `
with candidates as (
 select p.*, c.config from prospecting_candidates p
 join prospecting_campaigns c on c.organization_id=p.organization_id and c.id=p.campaign_id
 where p.organization_id=$1 and p.campaign_id=$2::uuid and p.created_at <= $3::timestamptz
), scoped_messages as (
 select p.id candidate_id,m.*,
   (m.direction='inbound' and coalesce(m.body,'') ~* $4) automatic_inferred,
   (m.direction='inbound' and coalesce(m.metadata->>'response_kind'='human',false)) human_confirmed
 from candidates p join messages m on m.organization_id=p.organization_id
   and m.conversation_id=p.conversation_id and m.contact_id=p.contact_id
 where m.created_at <= $3::timestamptz and m.revoked_at is null
   and (m.id=p.message_id or (
     m.created_at >= coalesce(p.attempted_at,p.created_at)
     and (p.service_boundary->>'service_revision' is null
       or m.service_revision::text=p.service_boundary->>'service_revision')))
), stats as (
 select candidate_id,
 count(*) filter(where direction='outbound' and status in ('sent','delivered','read'))::int messages_sent,
 count(*) filter(where direction='outbound' and status in ('delivered','read'))::int messages_delivered,
 count(*) filter(where direction='outbound' and status='failed')::int messages_failed,
 count(*) filter(where direction='outbound' and status in ('queued','sending','pending'))::int messages_pending,
 count(*) filter(where direction='inbound')::int inbound_count,
 count(*) filter(where automatic_inferred and not human_confirmed)::int automatic_inferred_count,
 count(*) filter(where human_confirmed)::int human_confirmed_count,
 count(*) filter(where direction='inbound' and not automatic_inferred and not human_confirmed)::int unknown_response_count,
 count(*) filter(where direction='inbound' and not automatic_inferred and not human_confirmed and coalesce(body,'') ~* '(sou (a|o) |me chamo |j[áa] (temos|tenho|usamos|utilizamos)|nosso crm|nossa equipe|tenho interesse|temos interesse|quanto custa|como funciona)')::int human_inferred_count,
 bool_or(direction='inbound' and not automatic_inferred and coalesce(body,'') ~* $5 and coalesce(body,'') !~* $6) interest_inferred,
 (array_agg(id order by created_at,id) filter(where direction='inbound' and not automatic_inferred and coalesce(body,'') ~* $5 and coalesce(body,'') !~* $6))[1:5] interest_evidence_message_ids,
 bool_or(direction='inbound' and not automatic_inferred and coalesce(body,'') ~* $6) refusal_inferred,
 (array_agg(id order by created_at,id) filter(where direction='inbound' and not automatic_inferred and coalesce(body,'') ~* $6))[1:5] refusal_evidence_message_ids,
 max(created_at) filter(where direction='inbound') last_inbound_at,
 max(created_at) filter(where direction='inbound' and (not automatic_inferred or human_confirmed)) last_nonautomatic_inbound_at,
 max(created_at) filter(where direction='outbound' and status in ('sent','delivered','read')) last_sent_at
 from scoped_messages group by candidate_id
)
select p.id,p.created_at,p.status approach_status,p.attempted_at,
 to_char(p.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at,
 p.data->>'name' company_name,l.id lead_id,l.title lead_title,
 ct.id contact_id,coalesce(ct.name,ct.display_name) contact_name,ct.phone_number,
 v.id conversation_id,v.active_ai_agent_id responsible_agent_id,a.name responsible_agent_name,
 cs.id whatsapp_connection_id,cs.phone_number whatsapp_number,
 l.stage_id,s.name stage_name,l.status lead_status,
 coalesce(l.stage_id::text=p.config->>'qualified_stage_id',false) pipeline_qualified,
 (coalesce(l.stage_id::text=p.config->>'qualified_stage_id',false) and coalesce(st.human_confirmed_count,0)>0 and coalesce(st.interest_inferred,false) and not coalesce(st.refusal_inferred,false)) qualified_confirmed,
 coalesce(s.is_lost,false) unqualified_confirmed,
 case when ct.id is null then null else coalesce(ct.ai_opt_out,false) end opt_out_confirmed,
 ct.is_blocked contact_blocked,ct.force_human,v.last_handoff_at,v.last_handoff_reason,
 (v.last_handoff_at is not null or coalesce(ct.force_human,false)) human_transfer_confirmed,
 initial.status initial_delivery_status,
 last_msg.id last_message_id,last_msg.body last_message,last_msg.created_at last_message_at,
 coalesce(st.messages_sent,0) messages_sent,coalesce(st.messages_delivered,0) messages_delivered,
 coalesce(st.messages_failed,0) messages_failed,coalesce(st.messages_pending,0) messages_pending,
 coalesce(st.inbound_count,0) inbound_count,
 coalesce(st.automatic_inferred_count,0) automatic_inferred_count,
 coalesce(st.human_confirmed_count,0) human_confirmed_count,
 coalesce(st.unknown_response_count,0) unknown_response_count,
 coalesce(st.human_inferred_count,0) human_inferred_count,
 coalesce(st.interest_inferred,false) interest_inferred,
 st.interest_evidence_message_ids,
 coalesce(st.refusal_inferred,false) refusal_inferred,
 st.refusal_evidence_message_ids,
 case when coalesce(st.inbound_count,0)=0 then 'none'
   when st.human_confirmed_count>0 then 'human'
   when st.unknown_response_count>0 then 'unknown' else 'automatic' end response,
 coalesce(st.last_sent_at>st.last_inbound_at or (st.last_sent_at is not null and st.last_inbound_at is null),false) awaiting_response,
 (not coalesce(ct.ai_opt_out,false) and not coalesce(ct.is_blocked,false)
   and not coalesce(st.refusal_inferred,false)
   and l.status='open' and not coalesce(s.is_lost,false)
   and v.status='open' and v.service_closed_at is null
   and (coalesce(st.interest_inferred,false) or coalesce(ct.force_human,false)
     or ((coalesce(st.human_confirmed_count,0)>0 or coalesce(st.human_inferred_count,0)>0)
       and st.last_nonautomatic_inbound_at is not null and (st.last_sent_at is null or st.last_nonautomatic_inbound_at>st.last_sent_at))
     or coalesce(st.messages_failed,0)>0)) needs_follow_up
from candidates p
left join crm_leads l on l.organization_id=p.organization_id and l.id=p.lead_id
left join contacts ct on ct.organization_id=p.organization_id and ct.id=p.contact_id
left join conversations v on v.organization_id=p.organization_id and v.id=p.conversation_id and v.contact_id=p.contact_id
left join crm_stages s on s.organization_id=p.organization_id and s.id=l.stage_id
left join ai_agents a on a.organization_id=p.organization_id and a.id=v.active_ai_agent_id
left join channel_sessions cs on cs.organization_id=p.organization_id and cs.id=v.channel_session_id
left join messages initial on initial.organization_id=p.organization_id and initial.id=p.message_id and initial.contact_id=p.contact_id and initial.conversation_id=p.conversation_id
left join stats st on st.candidate_id=p.id
left join lateral (select id,body,created_at from scoped_messages m where m.candidate_id=p.id order by created_at desc,id desc limit 1) last_msg on true
`;

const interpretation = {
  automatic:
    "Interpretação textual conservadora, não confirmação de autoria; demais respostas sem metadado são unknown.",
  human:
    "Confirmado apenas se já existir messages.metadata.response_kind = human; não há produtor desse metadado garantido no CRM atual. Somente indícios textuais positivos contam como human_inferred; ausência de padrão automático e mídia sem texto permanecem unknown.",
  interest:
    "Interpretação textual com referência à conversa; não altera qualificação. Confirme no histórico integral.",
  qualification:
    "pipeline_qualified informa apenas a etapa. qualified_confirmed exige também resposta humana registrada, evidência textual de interesse e ausência de recusa; não prova intenção sem evidência.",
  attribution:
    "Mensagens da conversa/contato vinculados desde attempted_at (ou criação do candidato), na revisão de atendimento registrada quando disponível. Não prova causalidade da resposta.",
};
function parameters(ctx: McpContext, id: string, snapshot: string) {
  return [ctx.organizationId, id, snapshot, AUTO_RX, INTEREST_RX, REFUSAL_RX];
}
function pageResult(
  rows: pg.QueryResultRow[],
  ctx: McpContext,
  name: string,
  input: Record<string, unknown> & { limit: number },
  snapshot: string,
) {
  const has_more = rows.length > input.limit;
  const data = rows.slice(0, input.limit);
  const last = data.at(-1);
  return {
    data: data.map(({ cursor_at: _cursorAt, ...row }) => {
      void _cursorAt;
      return row;
    }),
    meta: {
      has_more,
      snapshot_at: snapshot,
      cursor:
        has_more && last
          ? writePosition(ctx, name, input, last.cursor_at, last.id, snapshot)
          : null,
    },
  };
}
const common = {
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  redigirParaAuditoria: () => ({ read_only: true }),
} as const;

export const listProspectingCampaignsTool: McpToolDefinition<typeof listShape> = {
  ...common,
  name: "list_prospecting_campaigns",
  description:
    "Lista campanhas existentes de Gael/Xavier por organização, com agente, WhatsApp, segmento, localização, status, contagens e datas. Somente leitura; paginação por cursor.",
  inputSchema: listShape,
  handler: async (raw, ctx) => {
    const input = z.object(listShape).strict().parse(raw);
    const pos = readPosition(ctx, "list_prospecting_campaigns", input);
    const snapshot = pos?.snapshot ?? new Date().toISOString();
    return readOnly(ctx, async (db) => {
      const direction = input.order === "asc" ? "asc" : "desc";
      const result = await db.query(
        `
        select c.id,c.name,c.status,c.search_status,c.search->>'niche' segment,c.search->>'location' location,
        a.id agent_id,a.name agent_name,cs.id whatsapp_connection_id,cs.phone_number whatsapp_number,
        c.result_count companies_found,c.skipped_count search_results_excluded,
        n.*,c.created_at,c.updated_at,c.next_send_at,to_jsonb(c)->>'activated_at' activated_at,
        to_char(c.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at
        from prospecting_campaigns c
        left join ai_agents a on a.organization_id=c.organization_id and a.id::text=c.config->>'agent_id'
        left join channel_sessions cs on cs.organization_id=c.organization_id and cs.id::text=c.config->>'channel_session_id'
        left join lateral (select count(*)::int companies_registered,
          count(*) filter(where p.status='sent')::int companies_approached,
          count(*) filter(where p.status in ('new','queued','sending'))::int companies_pending,
          count(*) filter(where p.status='skipped')::int companies_excluded,
          count(*) filter(where p.status='failed')::int companies_failed
          from prospecting_candidates p where p.organization_id=c.organization_id and p.campaign_id=c.id) n on true
        where c.organization_id=$1 and c.created_at <= $2::timestamptz
        and ($3::text is null or c.status=$3)
        and ($4::timestamptz is null or (c.created_at,c.id) ${direction === "asc" ? ">" : "<"} ($4::timestamptz,$5::uuid))
        order by c.created_at ${direction},c.id ${direction} limit $6`,
        [
          ctx.organizationId,
          snapshot,
          input.status ?? null,
          pos?.at ?? null,
          pos?.id ?? null,
          input.limit + 1,
        ],
      );
      return pageResult(result.rows, ctx, "list_prospecting_campaigns", input, snapshot);
    });
  },
};

export const listCampaignConversationsTool: McpToolDefinition<typeof conversationShape> = {
  ...common,
  name: "list_campaign_conversations",
  description:
    "Consulta empresas e conversas de uma campanha por ID OU nome exato (ex.: Móveis planejados — Betim). Inclui pipeline, entrega, respostas confirmadas/desconhecidas, sinais comerciais interpretados, opt-out e acompanhamento. Somente leitura, filtros e cursor.",
  inputSchema: conversationShape,
  handler: async (raw, ctx) => {
    const input = z.object(conversationShape).strict().parse(raw);
    const selected = selector.parse({
      campaign_id: input.campaign_id,
      campaign_name: input.campaign_name,
    });
    const pos = readPosition(ctx, "list_campaign_conversations", input);
    const snapshot = pos?.snapshot ?? new Date().toISOString();
    return readOnly(ctx, async (db) => {
      const c = await resolveCampaign(db, ctx, selected);
      const dir = input.order === "asc" ? "asc" : "desc";
      const result = await db.query(
        `select * from (${campaignRowsSql}) r
        where ($7::text is null or approach_status=$7) and ($8::text is null or response=$8)
        and ($9::boolean is null or needs_follow_up=$9)
        and ($10::timestamptz is null or (created_at,id) ${dir === "asc" ? ">" : "<"} ($10::timestamptz,$11::uuid))
        order by created_at ${dir},id ${dir} limit $12`,
        [
          ...parameters(ctx, c.id, snapshot),
          input.status ?? null,
          input.response ?? null,
          input.needs_follow_up ?? null,
          pos?.at ?? null,
          pos?.id ?? null,
          input.limit + 1,
        ],
      );
      return {
        campaign: c,
        ...pageResult(result.rows, ctx, "list_campaign_conversations", input, snapshot),
        interpretation,
      };
    });
  },
};

export const getLeadConversationTool: McpToolDefinition<typeof historyShape> = {
  ...common,
  name: "get_lead_conversation",
  description:
    "Histórico integral paginado do contato associado ao lead, em ordem cronológica (sent_at,id; fallback created_at), com mensagens recebidas/enviadas, autoria, entrega e metadados mínimos de mídia. Não baixa mídia. Inclui todos os atendimentos do contato, não apenas a campanha.",
  inputSchema: historyShape,
  handler: async (raw, ctx) => {
    const input = z.object(historyShape).strict().parse(raw);
    const pos = readPosition(ctx, "get_lead_conversation", input);
    const snapshot = pos?.snapshot ?? new Date().toISOString();
    return readOnly(ctx, async (db) => {
      const lead = await db.query(
        `select l.id,ct.id contact_id from crm_leads l
        left join contacts ct on ct.organization_id=l.organization_id and ct.id=l.contact_id
        where l.organization_id=$1 and l.id=$2`,
        [ctx.organizationId, input.lead_id],
      );
      if (!lead.rows.length) throw new Error("Lead não encontrado ou sem permissão.");
      const result = await db.query(
        `select m.id,m.conversation_id,m.body,m.type,m.direction,m.created_at,m.sent_at,
        coalesce(m.sent_at,m.created_at) position_at,
        to_char(coalesce(m.sent_at,m.created_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at,
        m.status,m.delivered_at,m.read_at,m.sent_via,m.sent_by_user_id,
        case when m.direction='inbound' then 'client'
          when m.sent_by_user_id is not null or m.sent_via in ('external_device','user') then 'human'
          when m.sent_via='ai' then 'ai_agent'
          when m.sent_via='automation' then 'automation' else 'unknown' end sender,
        m.media_mime,m.media_size_bytes,
        m.metadata->>'duration' media_duration,m.metadata->>'filename' media_filename,
        (m.media_storage_path is not null or m.media_url is not null) media_available,
        m.metadata->>'response_kind' response_kind_recorded,
        (m.direction='inbound' and coalesce(m.body,'') ~* $7) automatic_inferred,
        m.metadata->>'refusal' refusal_recorded,m.metadata->>'handoff' handoff_recorded,
        m.revoked_at,
        v.last_handoff_at,v.last_handoff_reason,ct.ai_opt_out opt_out_confirmed,ct.force_human
        from messages m
        join conversations v on v.organization_id=m.organization_id and v.id=m.conversation_id and v.contact_id=m.contact_id
        join contacts ct on ct.organization_id=m.organization_id and ct.id=m.contact_id
        where m.organization_id=$1 and m.contact_id=$2::uuid and m.created_at <= $3::timestamptz
        and ($4::timestamptz is null or (coalesce(m.sent_at,m.created_at),m.id)>($4::timestamptz,$5::uuid))
        order by coalesce(m.sent_at,m.created_at),m.id limit $6`,
        [
          ctx.organizationId,
          lead.rows[0]!.contact_id,
          snapshot,
          pos?.at ?? null,
          pos?.id ?? null,
          input.limit + 1,
          AUTO_RX,
        ],
      );
      // Mensagem revogada nunca deve reexpor o corpo anterior.
      for (const row of result.rows)
        if (row.revoked_at) {
          row.body = null;
          row.revoked = true;
        }
      return {
        lead_id: input.lead_id,
        history_scope: "contact_all_conversations",
        ...pageResult(result.rows, ctx, "get_lead_conversation", input, snapshot),
        interpretation,
      };
    });
  },
};

export const getCampaignProspectingSummaryTool: McpToolDefinition<typeof campaign> = {
  ...common,
  name: "get_campaign_prospecting_summary",
  description:
    "Resumo comercial de campanha por ID OU nome exato, com totais integrais, entregas, falhas, respostas humanas confirmadas/automáticas interpretadas/desconhecidas, pipeline, opt-outs e acompanhamento. Taxas incluem numeradores/denominadores. Não inventa qualificação nem altera dados.",
  inputSchema: campaign,
  handler: async (raw, ctx) => {
    const input = selector.parse(raw);
    return readOnly(ctx, async (db) => {
      const c = await resolveCampaign(db, ctx, input);
      const snapshot = new Date().toISOString();
      const result = await db.query(
        `select count(*)::int companies_total,
        count(*) filter(where messages_sent>0)::int companies_prospected,
        coalesce(sum(messages_sent),0)::int messages_sent,
        coalesce(sum(messages_delivered),0)::int messages_delivered,
        coalesce(sum(messages_failed),0)::int messages_failed,
        coalesce(sum(messages_pending),0)::int messages_pending,
        count(distinct contact_id) filter(where inbound_count>0)::int contacts_replied,
        count(*) filter(where inbound_count>0 and messages_sent>0)::int prospected_companies_replied,
        count(distinct contact_id) filter(where automatic_inferred_count>0)::int contacts_automatic_inferred,
        count(distinct contact_id) filter(where human_confirmed_count>0)::int contacts_human_confirmed,
        count(distinct contact_id) filter(where human_inferred_count>0)::int contacts_human_inferred,
        count(distinct contact_id) filter(where unknown_response_count>0)::int contacts_response_unknown,
        count(distinct lead_id) filter(where interest_inferred)::int leads_interest_inferred,
        count(distinct lead_id) filter(where qualified_confirmed)::int leads_qualified_confirmed,
        count(distinct lead_id) filter(where unqualified_confirmed)::int leads_unqualified_confirmed,
        count(*) filter(where qualified_confirmed and messages_sent>0)::int prospected_companies_qualified,
        count(*) filter(where awaiting_response)::int conversations_awaiting_response,
        count(*) filter(where refusal_inferred)::int refusals_inferred,
        count(distinct contact_id) filter(where opt_out_confirmed)::int opt_outs_confirmed,
        count(*) filter(where needs_follow_up)::int opportunities_needing_human_follow_up
        from (${campaignRowsSql}) r`,
        parameters(ctx, c.id, snapshot),
      );
      const totals = result.rows[0]!;
      const rate = (numerator: number, denominator: number) => ({
        numerator,
        denominator,
        value: denominator === 0 ? null : numerator / denominator,
      });
      return {
        campaign: c,
        snapshot_at: snapshot,
        totals,
        rates: {
          response: rate(totals.prospected_companies_replied, totals.companies_prospected),
          qualification: rate(totals.prospected_companies_qualified, totals.companies_prospected),
          denominator_definition:
            "Empresas com ao menos uma mensagem outbound sent/delivered/read no escopo da campanha; numeradores restritos a essas mesmas empresas.",
        },
        interpretation,
      };
    });
  },
};

export const prospectingReadTools = [
  listProspectingCampaignsTool,
  listCampaignConversationsTool,
  getLeadConversationTool,
  getCampaignProspectingSummaryTool,
] as unknown as ReadonlyArray<McpToolDefinition>;
