/**
 * Ferramentas MCP dedicadas à conexão com ChatGPT.
 *
 * Expõe 10 ferramentas com foco na operação segura de CRM e gestão de leads,
 * garantindo isolamento multi-tenant, auditoria e preservação estrita do
 * mecanismo de atendimento humano (bloqueio do Xavier).
 */
import { z } from "zod";

import {
  createLeadHandler,
  getLeadHandler,
  moveLeadHandler,
  updateLeadHandler,
} from "@/app/api/v1/leads/_handler";
import { audit } from "@/lib/audit";
import { beginServiceAtOrigin } from "@/lib/atendimento/origem";
import { canonicalPhoneBR, normalizePhoneBR, phoneLookupVariants } from "@/lib/channels/phone-variants";
import { silencioVigente } from "@/lib/inbox/comando-da-conversa";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import type { McpToolDefinition } from "@/lib/mcp/types";
import { checarExclusaoDeProspeccao } from "@/lib/prospecting/exclusions";
import type { CampaignConfig } from "@/lib/prospecting/schema";

// ---------------------------------------------------------------------------
// 1. search_leads
// ---------------------------------------------------------------------------
const searchLeadsInputShape = {
  query: z
    .string()
    .min(1)
    .max(200)
    .describe("Termo de busca: nome do lead, nome do contato, telefone ou e-mail"),
  limit: z.number().int().min(1).max(50).default(10).describe("Limite máximo de resultados"),
};

export const searchLeadsTool: McpToolDefinition<typeof searchLeadsInputShape> = {
  name: "search_leads",
  description:
    "Busca leads no CRM por termo textual (nome do lead, contato, telefone ou e-mail). " +
    "Retorna os dados cadastrais básicos, contato associado, estágio e pipeline.",
  inputSchema: searchLeadsInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const q = input.query.trim();
    const phoneVariants = phoneLookupVariants(q);

    // 1. Busca contatos correspondentes por telefone, nome ou email
    const contactOrFilters = [
      `name.ilike.%${q}%`,
      `display_name.ilike.%${q}%`,
      `email.ilike.%${q}%`,
    ];
    if (phoneVariants.length > 0) {
      contactOrFilters.push(`phone_number.in.(${phoneVariants.join(",")})`);
    }

    const { data: matchedContacts } = await ctx.supabase
      .from("contacts")
      .select("id, name, display_name, phone_number, email, force_human")
      .eq("organization_id", ctx.organizationId)
      .or(contactOrFilters.join(","))
      .limit(50);

    const contactMap = new Map<string, {
      id: string;
      name: string | null;
      display_name: string | null;
      phone_number: string | null;
      email: string | null;
      force_human: boolean;
    }>();
    const contactIds: string[] = [];

    for (const c of (matchedContacts ?? []) as Array<{
      id: string;
      name: string | null;
      display_name: string | null;
      phone_number: string | null;
      email: string | null;
      force_human: boolean | null;
    }>) {
      contactMap.set(c.id, {
        id: c.id,
        name: c.name,
        display_name: c.display_name,
        phone_number: c.phone_number,
        email: c.email,
        force_human: Boolean(c.force_human),
      });
      contactIds.push(c.id);
    }

    // 2. Busca leads correspondentes
    const leadOrFilters = [`title.ilike.%${q}%`, `description.ilike.%${q}%`];
    if (contactIds.length > 0) {
      leadOrFilters.push(`contact_id.in.(${contactIds.join(",")})`);
    }

    const { data: leads, error: leadErr } = await ctx.supabase
      .from("crm_leads")
      .select(
        "id, title, description, pipeline_id, stage_id, status, contact_id, value_cents, currency, tags, created_at, owner_user_id, owner_agent_id, owner_kind",
      )
      .eq("organization_id", ctx.organizationId)
      .or(leadOrFilters.join(","))
      .order("created_at", { ascending: false })
      .limit(input.limit);

    if (leadErr) throw new Error(`Erro na busca de leads: ${leadErr.message}`);

    const leadRows = (leads ?? []) as Array<{
      id: string;
      title: string;
      description: string | null;
      pipeline_id: string;
      stage_id: string;
      status: string;
      contact_id: string | null;
      value_cents: number;
      currency: string;
      tags: string[] | null;
      created_at: string;
      owner_user_id: string | null;
      owner_agent_id: string | null;
      owner_kind: string | null;
    }>;

    // Carrega contatos que possam estar vinculados aos leads encontrados por título
    const missingContactIds = leadRows
      .map((l) => l.contact_id)
      .filter((cid): cid is string => typeof cid === "string" && cid.length > 0)
      .filter((cid) => !contactMap.has(cid));

    if (missingContactIds.length > 0) {
      const { data: moreContacts } = await ctx.supabase
        .from("contacts")
        .select("id, name, display_name, phone_number, email, force_human")
        .eq("organization_id", ctx.organizationId)
        .in("id", missingContactIds);

      for (const mc of (moreContacts ?? []) as Array<{
        id: string;
        name: string | null;
        display_name: string | null;
        phone_number: string | null;
        email: string | null;
        force_human: boolean | null;
      }>) {
        contactMap.set(mc.id, {
          id: mc.id,
          name: mc.name,
          display_name: mc.display_name,
          phone_number: mc.phone_number,
          email: mc.email,
          force_human: Boolean(mc.force_human),
        });
      }
    }

    // Enriquecimento com pipeline e estágio
    const pipelineIds = [...new Set(leadRows.map((l) => l.pipeline_id).filter((pid): pid is string => Boolean(pid)))];
    const stageIds = [...new Set(leadRows.map((l) => l.stage_id).filter((sid): sid is string => Boolean(sid)))];

    const [pipelinesRes, stagesRes] = await Promise.all([
      pipelineIds.length > 0
        ? ctx.supabase
            .from("crm_pipelines")
            .select("id, name")
            .eq("organization_id", ctx.organizationId)
            .in("id", pipelineIds)
        : Promise.resolve({ data: [] }),
      stageIds.length > 0
        ? ctx.supabase
            .from("crm_stages")
            .select("id, name")
            .eq("organization_id", ctx.organizationId)
            .in("id", stageIds)
        : Promise.resolve({ data: [] }),
    ]);

    const pipelineMap = new Map(
      ((pipelinesRes.data ?? []) as Array<{ id: string; name: string }>).map((p) => [p.id, p.name]),
    );
    const stageMap = new Map(
      ((stagesRes.data ?? []) as Array<{ id: string; name: string }>).map((s) => [s.id, s.name]),
    );

    const enriched = leadRows.map((l) => {
      const c = l.contact_id ? contactMap.get(l.contact_id) : null;
      return {
        id: l.id,
        title: l.title,
        description: l.description,
        status: l.status,
        tags: l.tags ?? [],
        value_cents: l.value_cents,
        currency: l.currency,
        created_at: l.created_at,
        pipeline: { id: l.pipeline_id, name: pipelineMap.get(l.pipeline_id) ?? "Desconhecido" },
        stage: { id: l.stage_id, name: stageMap.get(l.stage_id) ?? "Desconhecido" },
        contact: c
          ? {
              id: c.id,
              name: c.name ?? c.display_name,
              phone: c.phone_number,
              email: c.email,
              force_human: c.force_human,
            }
          : null,
      };
    });

    return { leads: enriched, count: enriched.length };
  },
};

// ---------------------------------------------------------------------------
// 2. get_lead
// ---------------------------------------------------------------------------
const getLeadInputShape = {
  lead_id: z.string().uuid().describe("UUID do lead"),
};

export const getLeadTool: McpToolDefinition<typeof getLeadInputShape> = {
  name: "get_lead",
  description: "Retorna todos os detalhes de um lead pelo seu UUID, incluindo contato e estágio.",
  inputSchema: getLeadInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const rawLead = await getLeadHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      input.lead_id,
    );

    const lead = rawLead as Record<string, unknown>;

    let contact: Record<string, unknown> | null = null;
    if (lead["contact_id"]) {
      const { data: ct } = await ctx.supabase
        .from("contacts")
        .select("id, name, display_name, phone_number, email, force_human, is_blocked, tags")
        .eq("organization_id", ctx.organizationId)
        .eq("id", lead["contact_id"] as string)
        .maybeSingle();
      contact = ct ? (ct as unknown as Record<string, unknown>) : null;
    }

    let pipelineName = "Desconhecido";
    if (lead["pipeline_id"]) {
      const { data: pipe } = await ctx.supabase
        .from("crm_pipelines")
        .select("name")
        .eq("id", lead["pipeline_id"] as string)
        .eq("organization_id", ctx.organizationId)
        .maybeSingle();
      if (pipe?.name) pipelineName = pipe.name;
    }

    let stageName = "Desconhecido";
    if (lead["stage_id"]) {
      const { data: stg } = await ctx.supabase
        .from("crm_stages")
        .select("name")
        .eq("id", lead["stage_id"] as string)
        .eq("organization_id", ctx.organizationId)
        .maybeSingle();
      if (stg?.name) stageName = stg.name;
    }

    const { data: activities } = await ctx.supabase
      .from("crm_lead_activities")
      .select("id, type, reason, actor_kind, performed_at")
      .eq("organization_id", ctx.organizationId)
      .eq("lead_id", input.lead_id)
      .order("performed_at", { ascending: false })
      .limit(10);

    return {
      lead: {
        ...lead,
        pipeline_name: pipelineName,
        stage_name: stageName,
        contact,
        recent_activities: activities ?? [],
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 3. create_lead (com garantia Fail-Closed para set_human_service)
// ---------------------------------------------------------------------------
const createLeadInputShape = {
  title: z.string().min(2).max(200).describe("Nome do lead ou empresa"),
  contact_name: z.string().max(200).optional().describe("Nome do contato"),
  contact_phone: z
    .string()
    .max(40)
    .optional()
    .describe("Telefone do contato (ex: +5511999999999 ou 11999999999)"),
  contact_email: z.string().email().optional().describe("E-mail do contato"),
  contact_id: z
    .string()
    .uuid()
    .optional()
    .describe("UUID de contato existente (opcional se informar telefone)"),
  pipeline_id: z
    .string()
    .uuid()
    .optional()
    .describe("UUID do pipeline (se omitido, usa o pipeline padrão)"),
  stage_id: z
    .string()
    .uuid()
    .optional()
    .describe("UUID do estágio/etapa (se omitido, usa o primeiro estágio do pipeline)"),
  description: z.string().max(2000).optional().describe("Observação ou anotação inicial sobre o lead"),
  source: z
    .string()
    .max(80)
    .optional()
    .default("mcp_chatgpt")
    .describe("Origem do lead (ex: site_inicial, manual, whatsapp)"),
  tags: z.array(z.string().max(50)).optional().default([]).describe("Lista de tags para o lead"),
  owner_user_id: z.string().uuid().optional().describe("UUID do usuário humano responsável"),
  value_cents: z.number().int().nonnegative().optional().describe("Valor do negócio em centavos"),
  set_human_service: z
    .boolean()
    .optional()
    .default(false)
    .describe("Se true, trava o contato em atendimento humano e IMPEDE o Xavier de falar"),
};

export const createLeadTool: McpToolDefinition<typeof createLeadInputShape> = {
  name: "create_lead",
  description:
    "Cria um lead e garante a criação/vinculação do contato correspondente sem duplicatas. " +
    "Quando set_human_service=true, aplica garantia fail-closed travando o contato com force_human=true " +
    "e silenciando conversas ANTES da criação do lead, impedindo que o Xavier responda.",
  inputSchema: createLeadInputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    // 1. Resolução do pipeline
    let pipelineId = input.pipeline_id;
    if (!pipelineId) {
      const { data: defPipe } = await ctx.supabase
        .from("crm_pipelines")
        .select("id")
        .eq("organization_id", ctx.organizationId)
        .eq("is_archived", false)
        .order("is_default", { ascending: false })
        .order("position", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!defPipe?.id) throw new Error("Nenhum pipeline ativo encontrado na organização.");
      pipelineId = defPipe.id;
    }

    // 2. Resolução do estágio
    let stageId = input.stage_id;
    if (!stageId) {
      const { data: firstStage } = await ctx.supabase
        .from("crm_stages")
        .select("id")
        .eq("organization_id", ctx.organizationId)
        .eq("pipeline_id", pipelineId)
        .order("position", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!firstStage?.id) throw new Error("Nenhum estágio encontrado para o pipeline informado.");
      stageId = firstStage.id;
    }

    if (!pipelineId || !stageId) {
      throw new Error("Pipeline e estágio são obrigatórios para a criação do lead.");
    }

    // 3. Resolução ou criação do contato
    let contactId: string | null = input.contact_id ?? null;

    if (!contactId && input.contact_phone) {
      const canonical = canonicalPhoneBR(input.contact_phone);
      const variants = phoneLookupVariants(input.contact_phone);

      const { data: existingContact } = await ctx.supabase
        .from("contacts")
        .select("id, force_human")
        .eq("organization_id", ctx.organizationId)
        .in("phone_number", variants)
        .limit(1)
        .maybeSingle();

      if (existingContact?.id) {
        contactId = existingContact.id;
      } else {
        // Criação do novo contato com fail-closed para force_human
        const { data: newContact, error: insContactErr } = await ctx.supabase
          .from("contacts")
          .insert({
            organization_id: ctx.organizationId,
            name: input.contact_name ?? input.title,
            phone_number: canonical,
            email: input.contact_email ?? null,
            source: input.source,
            // GARANTIA FAIL-CLOSED: nasce travado no banco se set_human_service for true
            force_human: input.set_human_service === true,
          })
          .select("id")
          .single();

        if (insContactErr) {
          // Em caso de colisão concorrente (23505), recupera o existente
          if (insContactErr.code === "23505") {
            const { data: conflictContact } = await ctx.supabase
              .from("contacts")
              .select("id")
              .eq("organization_id", ctx.organizationId)
              .in("phone_number", variants)
              .limit(1)
              .maybeSingle();
            if (conflictContact?.id) contactId = conflictContact.id;
          } else {
            throw new Error(`Falha ao criar contato: ${insContactErr.message}`);
          }
        } else if (newContact?.id) {
          contactId = newContact.id;
        }
      }
    }

    // Se o contato já existia e set_human_service é true, trava IMEDIATAMENTE antes do lead
    if (contactId && input.set_human_service === true) {
      const { error: lockErr } = await ctx.supabase
        .from("contacts")
        .update({ force_human: true })
        .eq("id", contactId)
        .eq("organization_id", ctx.organizationId);

      if (lockErr) {
        throw new Error(`Falha de segurança ao travar contato em modo humano: ${lockErr.message}`);
      }
    }

    // 4. Criação do lead através do handler canônico
    const lead = await createLeadHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      {
        pipeline_id: pipelineId,
        stage_id: stageId,
        title: input.title,
        description: input.description ?? null,
        contact_id: contactId,
        value_cents: input.value_cents ?? null,
        owner_user_id: input.owner_user_id ?? null,
        tags: input.tags ?? [],
        source: input.source ?? "mcp_chatgpt",
      },
    );

    const leadId = String(lead["id"]);

    // 5. Se houver descrição/observação, também registra como anotação na timeline
    if (input.description && leadId) {
      await emitLeadActivity(ctx.supabase, {
        organizationId: ctx.organizationId,
        leadId,
        contactId,
        type: "note",
        sourceModule: "mcp_chatgpt",
        actor: ctx.actor,
        reason: input.description,
        payload: { text: input.description },
      });
    }

    // 6. Se set_human_service foi solicitado, silencia conversas e registra atividade
    if (input.set_human_service === true && contactId) {
      await ctx.supabase
        .from("conversations")
        .update({
          bot_silenced_until: "infinity",
          assignee_kind: "user",
          last_handoff_at: new Date().toISOString(),
          last_handoff_reason: "Atendimento humano configurado no cadastro (MCP)",
          status: "pending",
        })
        .eq("contact_id", contactId)
        .eq("organization_id", ctx.organizationId);

      await emitLeadActivity(ctx.supabase, {
        organizationId: ctx.organizationId,
        leadId,
        contactId,
        type: "handoff_triggered",
        sourceModule: "mcp_chatgpt",
        actor: ctx.actor,
        reason: "Atendimento humano configurado no cadastro",
      });
    }

    return {
      success: true,
      lead,
      contact: contactId
        ? {
            id: contactId,
            force_human: input.set_human_service === true,
          }
        : null,
      human_service_active: input.set_human_service === true,
      xavier_blocked: input.set_human_service === true,
      message:
        input.set_human_service === true
          ? "Lead e contato criados com sucesso. Atendimento humano ativado (Xavier bloqueado)."
          : "Lead criado com sucesso.",
    };
  },
};

// ---------------------------------------------------------------------------
// 4. update_lead
// ---------------------------------------------------------------------------
const updateLeadInputShape = {
  lead_id: z.string().uuid().describe("UUID do lead a atualizar"),
  title: z.string().min(2).max(200).optional().describe("Novo título"),
  description: z.string().max(2000).optional().describe("Nova descrição"),
  value_cents: z.number().int().nonnegative().optional().describe("Novo valor em centavos"),
  tags: z.array(z.string().max(50)).optional().describe("Novas tags"),
  custom_fields: z.record(z.string(), z.unknown()).optional().describe("Campos customizados"),
};

export const updateLeadTool: McpToolDefinition<typeof updateLeadInputShape> = {
  name: "update_lead",
  description:
    "Atualiza propriedades cadastrais básicas de um lead. " +
    "PROTEÇÃO: Não altera o status de automação/Xavier nem limpa force_human.",
  inputSchema: updateLeadInputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { lead_id, ...patch } = input;
    const lead = await updateLeadHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      lead_id,
      patch,
    );
    return { success: true, lead };
  },
};

// ---------------------------------------------------------------------------
// 5. add_lead_note
// ---------------------------------------------------------------------------
const addLeadNoteInputShape = {
  lead_id: z.string().uuid().describe("UUID do lead"),
  note: z.string().min(1).max(2000).describe("Texto da anotação interna"),
};

export const addLeadNoteTool: McpToolDefinition<typeof addLeadNoteInputShape> = {
  name: "add_lead_note",
  description:
    "Adiciona uma anotação interna à linha do tempo oficial do lead (crm_lead_activities). " +
    "A anotação fica visível para os atendentes humanos no painel do CRM.",
  inputSchema: addLeadNoteInputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { data: lead, error: readErr } = await ctx.supabase
      .from("crm_leads")
      .select("id, contact_id")
      .eq("id", input.lead_id)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();

    if (readErr) throw new Error(`Erro ao localizar lead: ${readErr.message}`);
    if (!lead) throw new Error("Lead não encontrado.");

    const res = await emitLeadActivity(ctx.supabase, {
      organizationId: ctx.organizationId,
      leadId: input.lead_id,
      contactId: lead.contact_id,
      type: "note",
      sourceModule: "mcp_chatgpt",
      actor: ctx.actor,
      reason: input.note,
      payload: { text: input.note },
    });

    if (!res.ok) throw new Error(`Falha ao registrar anotação: ${res.error}`);

    await ctx.supabase
      .from("crm_leads")
      .update({ last_activity_at: new Date().toISOString() })
      .eq("id", input.lead_id)
      .eq("organization_id", ctx.organizationId);

    return {
      success: true,
      lead_id: input.lead_id,
      note: input.note,
      created_at: new Date().toISOString(),
    };
  },
};

// ---------------------------------------------------------------------------
// 6. move_lead_stage
// ---------------------------------------------------------------------------
const moveLeadStageInputShape = {
  lead_id: z.string().uuid().describe("UUID do lead a mover"),
  to_stage_id: z.string().uuid().describe("UUID do estágio de destino"),
  reason: z.string().max(500).optional().describe("Motivo da movimentação"),
};

export const moveLeadStageTool: McpToolDefinition<typeof moveLeadStageInputShape> = {
  name: "move_lead_stage",
  description:
    "Move um lead para outro estágio dentro do mesmo pipeline. " +
    "PROTEÇÃO: Não reativa o agente Xavier e preserva qualquer trava humana ativa.",
  inputSchema: moveLeadStageInputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const lead = await moveLeadHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      input.lead_id,
      {
        to_stage_id: input.to_stage_id,
        reason: input.reason,
      },
    );
    return { success: true, lead };
  },
};

// ---------------------------------------------------------------------------
// 7. set_human_service
// ---------------------------------------------------------------------------
const setHumanServiceInputShape = {
  lead_id: z.string().uuid().optional().describe("UUID do lead"),
  contact_id: z.string().uuid().optional().describe("UUID do contato"),
  phone: z.string().max(40).optional().describe("Telefone do contato (caso não tenha UUID)"),
  reason: z
    .string()
    .max(500)
    .optional()
    .default("Atendimento manual solicitado via ChatGPT")
    .describe("Motivo do atendimento humano"),
};

export const setHumanServiceTool: McpToolDefinition<typeof setHumanServiceInputShape> = {
  name: "set_human_service",
  description:
    "Coloca o lead/contato em atendimento humano definitivo. Altera o mecanismo REAL " +
    "que impede o Xavier de responder: grava contacts.force_human=true e silencia conversas " +
    "com bot_silenced_until='infinity'.",
  inputSchema: setHumanServiceInputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    let contactId: string | null = input.contact_id ?? null;
    const leadId: string | null = input.lead_id ?? null;

    if (leadId && !contactId) {
      const { data: lead } = await ctx.supabase
        .from("crm_leads")
        .select("id, contact_id")
        .eq("id", leadId)
        .eq("organization_id", ctx.organizationId)
        .maybeSingle();

      if (!lead) throw new Error("Lead não encontrado.");
      contactId = lead.contact_id;
    }

    if (!contactId && input.phone) {
      const variants = phoneLookupVariants(input.phone);
      const { data: ct } = await ctx.supabase
        .from("contacts")
        .select("id")
        .eq("organization_id", ctx.organizationId)
        .in("phone_number", variants)
        .limit(1)
        .maybeSingle();

      if (ct?.id) contactId = ct.id;
    }

    if (!contactId) {
      throw new Error("Contato não localizado para aplicar atendimento humano.");
    }

    // 1. Aplica a trava do contato
    const { error: ctErr } = await ctx.supabase
      .from("contacts")
      .update({ force_human: true })
      .eq("id", contactId)
      .eq("organization_id", ctx.organizationId);

    if (ctErr) throw new Error(`Falha ao travar contato: ${ctErr.message}`);

    // 2. Silencia qualquer conversa ativa do contato
    const agora = new Date().toISOString();
    await ctx.supabase
      .from("conversations")
      .update({
        bot_silenced_until: "infinity",
        assignee_kind: "user",
        last_handoff_at: agora,
        last_handoff_reason: input.reason,
        status: "pending",
      })
      .eq("contact_id", contactId)
      .eq("organization_id", ctx.organizationId);

    // 3. Emite atividade na timeline do lead se houver lead vinculado
    if (leadId) {
      await emitLeadActivity(ctx.supabase, {
        organizationId: ctx.organizationId,
        leadId,
        contactId,
        type: "handoff_triggered",
        sourceModule: "mcp_chatgpt",
        actor: ctx.actor,
        reason: input.reason,
      });
    }

    return {
      success: true,
      contact_id: contactId,
      lead_id: leadId,
      force_human: true,
      bot_silenced: true,
      xavier_blocked: true,
      message:
        "Atendimento humano ativado com sucesso. O contato foi travado com force_human=true " +
        "e a IA Xavier está terminantemente impedida de responder a este cliente.",
    };
  },
};

// ---------------------------------------------------------------------------
// 8. get_contact_automation_status (Ferramenta de leitura de auditoria)
// ---------------------------------------------------------------------------
const getContactAutomationStatusInputShape = {
  lead_id: z.string().uuid().optional().describe("UUID do lead"),
  contact_id: z.string().uuid().optional().describe("UUID do contato"),
  phone: z.string().max(40).optional().describe("Telefone do contato"),
};

export const getContactAutomationStatusTool: McpToolDefinition<
  typeof getContactAutomationStatusInputShape
> = {
  name: "get_contact_automation_status",
  description:
    "Consulta o status REAL de automação e handoff do contato: verifica se contacts.force_human=true, " +
    "se as conversas estão silenciadas (bot_silenced_until='infinity') e se o Xavier pode responder.",
  inputSchema: getContactAutomationStatusInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    let contactId: string | null = input.contact_id ?? null;

    if (input.lead_id && !contactId) {
      const { data: lead } = await ctx.supabase
        .from("crm_leads")
        .select("contact_id")
        .eq("id", input.lead_id)
        .eq("organization_id", ctx.organizationId)
        .maybeSingle();

      if (lead?.contact_id) contactId = lead.contact_id;
    }

    if (!contactId && input.phone) {
      const variants = phoneLookupVariants(input.phone);
      const { data: ct } = await ctx.supabase
        .from("contacts")
        .select("id")
        .eq("organization_id", ctx.organizationId)
        .in("phone_number", variants)
        .limit(1)
        .maybeSingle();

      if (ct?.id) contactId = ct.id;
    }

    if (!contactId) {
      throw new Error("Contato não localizado para consulta de status de automação.");
    }

    const { data: contact, error: ctErr } = await ctx.supabase
      .from("contacts")
      .select("id, name, display_name, phone_number, email, force_human, is_blocked, ai_authorized_at")
      .eq("id", contactId)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();

    if (ctErr || !contact) throw new Error("Registro de contato não encontrado.");

    const { data: conversations } = await ctx.supabase
      .from("conversations")
      .select(
        "id, status, assignee_kind, assigned_to_user_id, bot_silenced_until, last_handoff_at, last_handoff_reason, active_ai_agent_id",
      )
      .eq("contact_id", contactId)
      .eq("organization_id", ctx.organizationId);

    const agora = new Date();
    const convList = ((conversations ?? []) as Array<{
      id: string;
      status: string;
      assignee_kind: string | null;
      assigned_to_user_id: string | null;
      bot_silenced_until: string | null;
      last_handoff_at: string | null;
      last_handoff_reason: string | null;
      active_ai_agent_id: string | null;
    }>).map((c) => {
      const sil = silencioVigente(c.bot_silenced_until, agora);
      return {
        id: c.id,
        status: c.status,
        assignee_kind: c.assignee_kind,
        is_silenced: sil.vigente,
        silenced_durably: sil.duravel,
        bot_silenced_until: c.bot_silenced_until,
        last_handoff_at: c.last_handoff_at,
        last_handoff_reason: c.last_handoff_reason,
      };
    });

    const isForceHuman = contact.force_human === true;
    const isBlocked = contact.is_blocked === true;
    const hasSilencedConversation = convList.some((c) => c.is_silenced);
    const hasHumanAssignee = convList.some((c) => c.assignee_kind === "user");

    const canXavierRespond = !isForceHuman && !isBlocked && !hasSilencedConversation && !hasHumanAssignee;

    let statusSummary = "Automação com Xavier liberada.";
    if (isForceHuman) {
      statusSummary = "BLOQUEIO TOTAL: contacts.force_human=true. Xavier nunca responderá.";
    } else if (hasSilencedConversation) {
      statusSummary = "CONVERSA SILENCIADA: silêncio durável ativo na conversa. Xavier não responderá.";
    } else if (hasHumanAssignee) {
      statusSummary = "ATENDIMENTO HUMANO: conversa atribuída a atendente humano (assignee_kind='user').";
    } else if (isBlocked) {
      statusSummary = "BLOQUEADO: contato com opt-out/bloqueio ativo.";
    }

    return {
      contact_id: contact.id,
      contact_name: contact.name ?? contact.display_name,
      phone_number: contact.phone_number,
      force_human: isForceHuman,
      is_blocked: isBlocked,
      can_xavier_respond: canXavierRespond,
      status_summary: statusSummary,
      conversations: convList,
    };
  },
};

// ---------------------------------------------------------------------------
// 9. assign_agent (com proteção contra reativação implícita)
// ---------------------------------------------------------------------------
const assignAgentInputShape = {
  lead_id: z.string().uuid().describe("UUID do lead"),
  assignee_type: z.enum(["user", "agent"]).describe("'user' para atendente humano, 'agent' para IA"),
  assignee_id: z.string().uuid().describe("UUID do atendente humano ou do agente de IA"),
};

export const assignAgentTool: McpToolDefinition<typeof assignAgentInputShape> = {
  name: "assign_agent",
  description:
    "Atribui um responsável humano ('user') ou agente de IA ('agent') ao lead. " +
    "PROTEÇÃO ESTRITA: Se o contato estiver com force_human=true, a atribuição a agente de IA é " +
    "RECUSADA para impedir que o Xavier seja reativado implicitamente.",
  inputSchema: assignAgentInputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { data: lead, error: leadErr } = await ctx.supabase
      .from("crm_leads")
      .select("id, contact_id, pipeline_id, stage_id")
      .eq("id", input.lead_id)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();

    if (leadErr || !lead) throw new Error("Lead não encontrado.");

    if (input.assignee_type === "agent") {
      // PROTEÇÃO CONTRA REATIVAÇÃO IMPLÍCITA:
      if (lead.contact_id) {
        const { data: ct } = await ctx.supabase
          .from("contacts")
          .select("force_human")
          .eq("id", lead.contact_id)
          .eq("organization_id", ctx.organizationId)
          .maybeSingle();

        if (ct?.force_human === true) {
          throw new Error(
            "Atribuição de agente de IA RECUSADA: o contato deste lead está travado em atendimento humano " +
            "exclusivo (force_human=true). A IA Xavier não pode ser ativada sobre este contato.",
          );
        }
      }

      // Valida que o agente existe e pertence à organização
      const { data: agentRow } = await ctx.supabase
        .from("ai_agents")
        .select("id, name")
        .eq("id", input.assignee_id)
        .eq("organization_id", ctx.organizationId)
        .maybeSingle();

      if (!agentRow) throw new Error("Agente de IA não encontrado na organização.");

      await ctx.supabase
        .from("crm_leads")
        .update({
          owner_kind: "agent",
          owner_agent_id: input.assignee_id,
          owner_user_id: null,
          assigned_at: new Date().toISOString(),
        })
        .eq("id", input.lead_id)
        .eq("organization_id", ctx.organizationId);

      return {
        success: true,
        lead_id: input.lead_id,
        assignee_type: "agent",
        agent_name: agentRow.name,
      };
    }

    // Atribuição a usuário humano
    const { data: userMember } = await ctx.supabase
      .from("user_organizations")
      .select("user_id")
      .eq("user_id", input.assignee_id)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();

    if (!userMember) throw new Error("Atendente humano não encontrado nesta organização.");

    await ctx.supabase
      .from("crm_leads")
      .update({
        owner_kind: "user",
        owner_user_id: input.assignee_id,
        owner_agent_id: null,
        assigned_at: new Date().toISOString(),
      })
      .eq("id", input.lead_id)
      .eq("organization_id", ctx.organizationId);

    if (lead.contact_id) {
      await ctx.supabase
        .from("conversations")
        .update({
          assignee_kind: "user",
          assigned_to_user_id: input.assignee_id,
        })
        .eq("contact_id", lead.contact_id)
        .eq("organization_id", ctx.organizationId);
    }

    return {
      success: true,
      lead_id: input.lead_id,
      assignee_type: "user",
      assignee_id: input.assignee_id,
    };
  },
};

// ---------------------------------------------------------------------------
// 10. list_pipeline_stages
// ---------------------------------------------------------------------------
const listPipelineStagesInputShape = {
  pipeline_id: z.string().uuid().optional().describe("UUID do pipeline (opcional)"),
};

export const listPipelineStagesTool: McpToolDefinition<typeof listPipelineStagesInputShape> = {
  name: "list_pipeline_stages",
  description:
    "Lista os pipelines ativos da organização e suas respectivas etapas com nomes, IDs e posições.",
  inputSchema: listPipelineStagesInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    let pipeQuery = ctx.supabase
      .from("crm_pipelines")
      .select("id, name, is_default, position")
      .eq("organization_id", ctx.organizationId)
      .eq("is_archived", false)
      .order("position", { ascending: true });

    if (input.pipeline_id) {
      pipeQuery = pipeQuery.eq("id", input.pipeline_id);
    }

    const { data: pipelines, error: pipeErr } = await pipeQuery;
    if (pipeErr) throw new Error(`Erro ao listar pipelines: ${pipeErr.message}`);

    const pipeList = (pipelines ?? []) as Array<{ id: string; name: string; is_default: boolean }>;
    const pipeIds = pipeList.map((p) => p.id);
    const { data: stages, error: stgErr } =
      pipeIds.length > 0
        ? await ctx.supabase
            .from("crm_stages")
            .select("id, pipeline_id, name, slug, position, is_won, is_lost")
            .eq("organization_id", ctx.organizationId)
            .in("pipeline_id", pipeIds)
            .order("position", { ascending: true })
        : { data: [], error: null };

    if (stgErr) throw new Error(`Erro ao listar etapas: ${stgErr.message}`);

    const stagesByPipe = new Map<string, Array<{
      id: string;
      name: string;
      slug: string;
      position: number;
      is_won: boolean;
      is_lost: boolean;
    }>>();

    for (const s of (stages ?? []) as Array<{
      id: string;
      pipeline_id: string;
      name: string;
      slug: string;
      position: number;
      is_won: boolean;
      is_lost: boolean;
    }>) {
      const arr = stagesByPipe.get(s.pipeline_id) ?? [];
      arr.push(s);
      stagesByPipe.set(s.pipeline_id, arr);
    }

    return {
      pipelines: pipeList.map((p) => ({
        id: p.id,
        name: p.name,
        is_default: p.is_default,
        stages: stagesByPipe.get(p.id) ?? [],
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// 11. upsert_lead_contact
// ---------------------------------------------------------------------------
const upsertLeadContactInputShape = {
  lead_id: z.string().uuid().describe("UUID do lead existente no CRM"),
  contact_name: z.string().max(200).optional().describe("Nome do contato"),
  contact_phone: z
    .string()
    .max(40)
    .optional()
    .describe("Telefone do contato (ex: +5531999999999 ou 31999999999)"),
  contact_email: z.string().email().optional().describe("E-mail do contato"),
};

export const upsertLeadContactTool: McpToolDefinition<typeof upsertLeadContactInputShape> = {
  name: "upsert_lead_contact",
  description:
    "Atualiza com segurança os dados do contato associado a um lead existente ou vincula/cria um contato " +
    "sem duplicar cadastros, sem criar novos leads e sem alterar estágio, automação ou atendimento humano.",
  inputSchema: upsertLeadContactInputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    // 1. Localiza o lead na organização atual
    const { data: lead, error: leadErr } = await ctx.supabase
      .from("crm_leads")
      .select("id, contact_id, organization_id, stage_id, pipeline_id, title")
      .eq("id", input.lead_id)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();

    if (leadErr) throw new Error(`Erro ao buscar lead: ${leadErr.message}`);
    if (!lead) throw new Error("Lead não encontrado nesta organização.");

    let targetContactId: string;
    let action: "updated" | "linked_existing" | "created_and_linked";
    const changedFields: string[] = [];

    // 2. Se o lead já tiver contact_id vinculado
    if (lead.contact_id) {
      const { data: currentContact, error: ctErr } = await ctx.supabase
        .from("contacts")
        .select("id, name, display_name, phone_number, email, force_human, is_blocked")
        .eq("id", lead.contact_id)
        .eq("organization_id", ctx.organizationId)
        .maybeSingle();

      if (ctErr || !currentContact) {
        throw new Error("Contato associado ao lead não foi encontrado nesta organização.");
      }

      targetContactId = currentContact.id;
      action = "updated";
      const patch: Record<string, unknown> = {};

      // Atualiza nome se fornecido
      if (input.contact_name !== undefined && input.contact_name.trim() !== "") {
        const newName = input.contact_name.trim();
        if (newName !== currentContact.name) {
          patch.name = newName;
          changedFields.push("name");
        }
      }

      // Atualiza telefone se fornecido (normalizado E.164 com prevenção de duplicidade)
      if (input.contact_phone !== undefined && input.contact_phone.trim() !== "") {
        const normalized = normalizePhoneBR(input.contact_phone) ?? canonicalPhoneBR(input.contact_phone);
        if (normalized !== currentContact.phone_number) {
          const variants = phoneLookupVariants(normalized);
          const { data: duplicateContact } = await ctx.supabase
            .from("contacts")
            .select("id")
            .eq("organization_id", ctx.organizationId)
            .in("phone_number", variants)
            .neq("id", currentContact.id)
            .limit(1)
            .maybeSingle();

          if (duplicateContact?.id) {
            throw new Error(
              `Não é possível atualizar o telefone: o número ${normalized} já pertence a outro contato (ID: ${duplicateContact.id}) nesta organização.`
            );
          }

          patch.phone_number = normalized;
          changedFields.push("phone_number");
        }
      }

      // Atualiza e-mail se fornecido
      if (input.contact_email !== undefined && input.contact_email.trim() !== "") {
        const newEmail = input.contact_email.trim().toLowerCase();
        if (newEmail !== (currentContact.email ?? "").toLowerCase()) {
          patch.email = newEmail;
          changedFields.push("email");
        }
      }

      if (Object.keys(patch).length > 0) {
        const { error: updErr } = await ctx.supabase
          .from("contacts")
          .update(patch)
          .eq("id", currentContact.id)
          .eq("organization_id", ctx.organizationId);

        if (updErr) throw new Error(`Falha ao atualizar dados do contato: ${updErr.message}`);
      }
    } else {
      // 3. Se o lead NÃO tiver contact_id
      const rawPhone = input.contact_phone?.trim();
      const rawEmail = input.contact_email?.trim().toLowerCase();
      const rawName = input.contact_name?.trim();

      if (rawPhone) {
        const normalized = normalizePhoneBR(rawPhone) ?? canonicalPhoneBR(rawPhone);
        const variants = phoneLookupVariants(normalized);

        const { data: existingContact } = await ctx.supabase
          .from("contacts")
          .select("id, name, display_name, phone_number, email, force_human, is_blocked")
          .eq("organization_id", ctx.organizationId)
          .in("phone_number", variants)
          .limit(1)
          .maybeSingle();

        if (existingContact?.id) {
          targetContactId = existingContact.id;
          action = "linked_existing";

          // Enriquecimento seguro se campos faltavam no contato existente
          const patch: Record<string, unknown> = {};
          if (rawName && !existingContact.name) {
            patch.name = rawName;
            changedFields.push("name");
          }
          if (rawEmail && !existingContact.email) {
            patch.email = rawEmail;
            changedFields.push("email");
          }
          if (Object.keys(patch).length > 0) {
            await ctx.supabase
              .from("contacts")
              .update(patch)
              .eq("id", existingContact.id)
              .eq("organization_id", ctx.organizationId);
          }
        } else {
          // Não encontrou por telefone: cria novo contato
          const newName = rawName || lead.title;
          const { data: newContact, error: insErr } = await ctx.supabase
            .from("contacts")
            .insert({
              organization_id: ctx.organizationId,
              name: newName,
              phone_number: normalized,
              email: rawEmail || null,
              source: "mcp_chatgpt",
            })
            .select("id, name, display_name, phone_number, email, force_human, is_blocked")
            .single();

          if (insErr) {
            if (insErr.code === "23505") {
              const { data: conflictContact } = await ctx.supabase
                .from("contacts")
                .select("id, name, display_name, phone_number, email, force_human, is_blocked")
                .eq("organization_id", ctx.organizationId)
                .in("phone_number", variants)
                .limit(1)
                .maybeSingle();
              if (conflictContact?.id) {
                targetContactId = conflictContact.id;
                action = "linked_existing";
              } else {
                throw new Error(`Falha ao criar contato: ${insErr.message}`);
              }
            } else {
              throw new Error(`Falha ao criar contato: ${insErr.message}`);
            }
          } else if (newContact?.id) {
            targetContactId = newContact.id;
            action = "created_and_linked";
            changedFields.push("name", "phone_number");
            if (rawEmail) changedFields.push("email");
          } else {
            throw new Error("Falha inesperada ao obter ID do contato criado.");
          }
        }
      } else {
        // Sem telefone: verifica se há nome ou e-mail suficiente
        if (!rawName && !rawEmail) {
          throw new Error(
            "Para vincular ou criar contato em lead sem contato associado, informe pelo menos telefone, nome ou e-mail."
          );
        }

        let existingByEmail: {
          id: string;
          name: string | null;
          display_name: string | null;
          phone_number: string | null;
          email: string | null;
          force_human: boolean | null;
          is_blocked: boolean | null;
        } | null = null;

        if (rawEmail) {
          const { data: ctByEmail } = await ctx.supabase
            .from("contacts")
            .select("id, name, display_name, phone_number, email, force_human, is_blocked")
            .eq("organization_id", ctx.organizationId)
            .eq("email", rawEmail)
            .limit(1)
            .maybeSingle();
          existingByEmail = ctByEmail;
        }

        if (existingByEmail?.id) {
          targetContactId = existingByEmail.id;
          action = "linked_existing";
          if (rawName && !existingByEmail.name) {
            await ctx.supabase
              .from("contacts")
              .update({ name: rawName })
              .eq("id", existingByEmail.id)
              .eq("organization_id", ctx.organizationId);
            changedFields.push("name");
          }
        } else {
          const newName = rawName || lead.title;
          const { data: newContact, error: insErr } = await ctx.supabase
            .from("contacts")
            .insert({
              organization_id: ctx.organizationId,
              name: newName,
              email: rawEmail || null,
              source: "mcp_chatgpt",
            })
            .select("id, name, display_name, phone_number, email, force_human, is_blocked")
            .single();

          if (insErr) throw new Error(`Falha ao criar contato: ${insErr.message}`);
          if (!newContact?.id) throw new Error("Falha inesperada ao criar contato.");

          targetContactId = newContact.id;
          action = "created_and_linked";
          changedFields.push("name");
          if (rawEmail) changedFields.push("email");
        }
      }

      // Vincula o contato ao lead
      const { error: linkErr } = await ctx.supabase
        .from("crm_leads")
        .update({ contact_id: targetContactId })
        .eq("id", lead.id)
        .eq("organization_id", ctx.organizationId);

      if (linkErr) throw new Error(`Falha ao vincular contato ao lead: ${linkErr.message}`);
    }

    // 4. Busca o contato final para retorno estruturado
    const { data: finalContact, error: finalErr } = await ctx.supabase
      .from("contacts")
      .select("id, name, display_name, phone_number, email, force_human, is_blocked")
      .eq("id", targetContactId)
      .eq("organization_id", ctx.organizationId)
      .single();

    if (finalErr || !finalContact) {
      throw new Error("Erro ao obter registro final do contato.");
    }

    // 5. Calcula can_xavier_respond com segurança
    const { data: convs } = await ctx.supabase
      .from("conversations")
      .select("status, assignee_kind, bot_silenced_until")
      .eq("contact_id", targetContactId)
      .eq("organization_id", ctx.organizationId);

    const agora = new Date();
    const hasSilencedConv = (convs ?? []).some(
      (c: { bot_silenced_until: string | null }) => silencioVigente(c.bot_silenced_until, agora).vigente,
    );
    const hasHumanAssignee = (convs ?? []).some(
      (c: { assignee_kind: string | null }) => c.assignee_kind === "user",
    );
    const isForceHuman = finalContact.force_human === true;
    const isBlocked = finalContact.is_blocked === true;
    const canXavierRespond = !isForceHuman && !isBlocked && !hasSilencedConv && !hasHumanAssignee;

    // 6. Auditoria (timeline do lead e audit log)
    const reasonText =
      action === "updated"
        ? `Contato atualizado via MCP: ${changedFields.join(", ") || "sem alterações"}`
        : action === "linked_existing"
        ? `Contato existente (${targetContactId}) vinculado ao lead via MCP`
        : `Novo contato criado e vinculado ao lead via MCP`;

    await emitLeadActivity(ctx.supabase, {
      organizationId: ctx.organizationId,
      leadId: input.lead_id,
      contactId: targetContactId,
      type: "lead_edited",
      sourceModule: "mcp_chatgpt",
      actor: ctx.actor,
      reason: reasonText,
      payload: {
        action,
        changed_fields: changedFields,
        contact_id: targetContactId,
      },
    });

    void audit({
      action: "lead.updated",
      organizationId: ctx.organizationId,
      actorUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
      actorApiTokenId: ctx.apiTokenId,
      resourceType: "crm_lead",
      resourceId: input.lead_id,
      requestId: ctx.requestId,
      metadata: {
        action,
        contact_id: targetContactId,
        changed_fields: changedFields,
        source: "mcp_upsert_lead_contact",
      },
    });

    // 7. Retorno estruturado conforme especificado
    return {
      lead_id: input.lead_id,
      contact_id: finalContact.id,
      action,
      contact_name: finalContact.name ?? finalContact.display_name,
      phone_number: finalContact.phone_number,
      email: finalContact.email,
      force_human: isForceHuman,
      can_xavier_respond: canXavierRespond,
      changed_fields: changedFields,
    };
  },
};

// ---------------------------------------------------------------------------
// 12. enroll_leads_in_prospecting_campaign
// ---------------------------------------------------------------------------
const enrollLeadsInProspectingCampaignInputShape = {
  lead_ids: z
    .array(z.string().uuid("Cada lead_id deve ser um UUID válido."))
    .min(1, "Pelo menos um lead_id deve ser informado.")
    .describe("Lista de UUIDs dos leads existentes a serem inscritos na campanha de prospecção"),
  campaign_id: z
    .string()
    .uuid("campaign_id deve ser um UUID válido.")
    .optional()
    .describe("UUID da campanha de prospecção (opcional se campaign_name for informado)"),
  campaign_name: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Nome da campanha de prospecção (opcional se campaign_id for informado)"),
  release_for_xavier: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Autorização explícita para liberar force_human e dessilenciar o Xavier para os leads elegíveis inscritos",
    ),
};

export const enrollLeadsInProspectingCampaignTool: McpToolDefinition<
  typeof enrollLeadsInProspectingCampaignInputShape
> = {
  name: "enroll_leads_in_prospecting_campaign",
  description:
    "Inscreve leads existentes em uma campanha de prospecção automatizada do Xavier sem criar leads duplicados e sem contornar as proteções comerciais. Respeita filas, horários, ritmo, exclusões e opt-outs.",
  inputSchema: enrollLeadsInProspectingCampaignInputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    if (!input.campaign_id && !input.campaign_name) {
      throw new Error("Informe campaign_id ou campaign_name.");
    }

    let campaign: {
      id: string;
      name: string;
      status: string;
      config: CampaignConfig | null;
      organization_id: string;
    } | null = null;

    if (input.campaign_id) {
      const { data: c, error: cErr } = await ctx.supabase
        .from("prospecting_campaigns")
        .select("id, name, status, config, organization_id")
        .eq("id", input.campaign_id)
        .eq("organization_id", ctx.organizationId)
        .maybeSingle();

      if (cErr || !c) {
        throw new Error(`Campanha de prospecção não encontrada pelo ID: ${input.campaign_id}`);
      }
      campaign = c;
    } else if (input.campaign_name) {
      const qName = input.campaign_name.trim();
      const { data: matched, error: mErr } = await ctx.supabase
        .from("prospecting_campaigns")
        .select("id, name, status, config, organization_id")
        .eq("organization_id", ctx.organizationId)
        .ilike("name", `%${qName}%`);

      if (mErr || !matched || matched.length === 0) {
        throw new Error(`Nenhuma campanha de prospecção encontrada com o nome: "${qName}"`);
      }

      const exact = matched.find(
        (c: { name: string }) => c.name.toLowerCase() === qName.toLowerCase(),
      );
      if (exact) {
        campaign = exact;
      } else if (matched.length === 1) {
        campaign = matched[0]!;
      } else {
        const candidateNames = matched
          .map((c: { name: string; id: string }) => `"${c.name}" (${c.id})`)
          .join(", ");
        throw new Error(
          `Nome de campanha ambíguo. Foram encontradas ${matched.length} campanhas candidatas: [${candidateNames}]. Especifique o campaign_id ou o nome exato.`,
        );
      }
    }

    if (!campaign) {
      throw new Error("Campanha de prospecção não pôde ser resolvida.");
    }

    const config = campaign.config as CampaignConfig | null;
    if (!config || !config.agent_id || !config.channel_session_id) {
      throw new Error("A campanha de prospecção não possui configuração válida de agente ou canal.");
    }

    const results: Array<{
      lead_id: string;
      lead_title: string;
      contact_id: string | null;
      phone_number: string | null;
      result: "enrolled" | "already_enrolled" | "requires_xavier_release" | "rejected";
      reason: string;
      force_human_before: boolean;
      force_human_after: boolean;
      queued: boolean;
      message_sent: false;
    }> = [];

    let enrolledCount = 0;
    let alreadyEnrolledCount = 0;
    let rejectedCount = 0;
    let requiresReleaseCount = 0;

    const PROTECTED_MANUAL_TAGS = [
      "abordagem-site-inicial",
      "prospeccao-manual",
      "aguardando site para abordagem",
    ];

    for (const leadId of input.lead_ids) {
      // 1. Busca lead
      const { data: lead, error: leadErr } = await ctx.supabase
        .from("crm_leads")
        .select("id, title, status, lost_reason, contact_id, pipeline_id, stage_id, tags")
        .eq("id", leadId)
        .eq("organization_id", ctx.organizationId)
        .maybeSingle();

      if (leadErr || !lead) {
        results.push({
          lead_id: leadId,
          lead_title: "Desconhecido",
          contact_id: null,
          phone_number: null,
          result: "rejected",
          reason: "Lead não encontrado na organização atual.",
          force_human_before: false,
          force_human_after: false,
          queued: false,
          message_sent: false,
        });
        rejectedCount++;
        continue;
      }

      // 2. Contato associado
      if (!lead.contact_id) {
        results.push({
          lead_id: lead.id,
          lead_title: lead.title,
          contact_id: null,
          phone_number: null,
          result: "rejected",
          reason: "Lead não possui contato associado.",
          force_human_before: false,
          force_human_after: false,
          queued: false,
          message_sent: false,
        });
        rejectedCount++;
        continue;
      }

      const { data: contact, error: contactErr } = await ctx.supabase
        .from("contacts")
        .select(
          "id, name, display_name, phone_number, is_blocked, force_human, ai_opt_out, is_anonymized, consent, tags",
        )
        .eq("id", lead.contact_id)
        .eq("organization_id", ctx.organizationId)
        .maybeSingle();

      if (contactErr || !contact) {
        results.push({
          lead_id: lead.id,
          lead_title: lead.title,
          contact_id: lead.contact_id,
          phone_number: null,
          result: "rejected",
          reason: "Contato associado não encontrado na organização.",
          force_human_before: false,
          force_human_after: false,
          queued: false,
          message_sent: false,
        });
        rejectedCount++;
        continue;
      }

      const isForceHuman = contact.force_human === true;

      // 3. Telefone válido
      const rawPhone = contact.phone_number?.trim();
      const normalizedPhone = rawPhone
        ? canonicalPhoneBR(rawPhone) || normalizePhoneBR(rawPhone)
        : null;
      if (!normalizedPhone) {
        results.push({
          lead_id: lead.id,
          lead_title: lead.title,
          contact_id: contact.id,
          phone_number: rawPhone || null,
          result: "rejected",
          reason: "Contato não possui telefone brasileiro válido.",
          force_human_before: isForceHuman,
          force_human_after: isForceHuman,
          queued: false,
          message_sent: false,
        });
        rejectedCount++;
        continue;
      }

      // 4. Tags de pré-site / abordagem manual
      const leadTags = Array.isArray(lead.tags) ? lead.tags : [];
      const contactTags = Array.isArray(contact.tags) ? contact.tags : [];
      const combinedTags = [...leadTags, ...contactTags];

      const foundProtectedTag = combinedTags.find((t) => {
        if (typeof t !== "string") return false;
        return PROTECTED_MANUAL_TAGS.includes(t.toLowerCase().trim());
      });

      if (foundProtectedTag) {
        results.push({
          lead_id: lead.id,
          lead_title: lead.title,
          contact_id: contact.id,
          phone_number: normalizedPhone,
          result: "rejected",
          reason: `Lead possui tag de proteção manual/pré-site: "${foundProtectedTag}". Abordagem automatizada proibida.`,
          force_human_before: isForceHuman,
          force_human_after: isForceHuman,
          queued: false,
          message_sent: false,
        });
        rejectedCount++;
        continue;
      }

      // 5. Exclusões estruturais e 7 leads manuais protegidos
      const exclusao = await checarExclusaoDeProspeccao(ctx.supabase, {
        organizationId: ctx.organizationId,
        leadId: lead.id,
        contactId: contact.id,
        phone: normalizedPhone,
        title: lead.title,
      });

      if (exclusao.excluido) {
        results.push({
          lead_id: lead.id,
          lead_title: lead.title,
          contact_id: contact.id,
          phone_number: normalizedPhone,
          result: "rejected",
          reason: exclusao.motivo || "Lead ou contato protegido contra abordagem de prospecção.",
          force_human_before: isForceHuman,
          force_human_after: isForceHuman,
          queued: false,
          message_sent: false,
        });
        rejectedCount++;
        continue;
      }

      // 6. Contato bloqueado
      if (contact.is_blocked === true) {
        results.push({
          lead_id: lead.id,
          lead_title: lead.title,
          contact_id: contact.id,
          phone_number: normalizedPhone,
          result: "rejected",
          reason: "Contato está bloqueado no sistema.",
          force_human_before: isForceHuman,
          force_human_after: isForceHuman,
          queued: false,
          message_sent: false,
        });
        rejectedCount++;
        continue;
      }

      // 7. Opt-out
      const marketing = contact.consent?.marketing as
        | { declined_at?: unknown; opt_out?: unknown }
        | undefined;
      const hasOptOut = Boolean(
        marketing?.declined_at || marketing?.opt_out || contact.ai_opt_out === true,
      );
      if (hasOptOut) {
        results.push({
          lead_id: lead.id,
          lead_title: lead.title,
          contact_id: contact.id,
          phone_number: normalizedPhone,
          result: "rejected",
          reason: "Contato registrou opt-out de mensagens ou recusa permanente de IA.",
          force_human_before: isForceHuman,
          force_human_after: isForceHuman,
          queued: false,
          message_sent: false,
        });
        rejectedCount++;
        continue;
      }

      // 8. Perda definitiva
      const isLostDefinitive = lead.status === "lost" || lead.lost_reason !== null;
      if (isLostDefinitive) {
        results.push({
          lead_id: lead.id,
          lead_title: lead.title,
          contact_id: contact.id,
          phone_number: normalizedPhone,
          result: "rejected",
          reason: `Lead encerrado como perda definitiva no CRM (${lead.lost_reason || "status lost"}).`,
          force_human_before: isForceHuman,
          force_human_after: isForceHuman,
          queued: false,
          message_sent: false,
        });
        rejectedCount++;
        continue;
      }

      // 9. Atendimento humano ativo incompatível
      const { data: convs } = await ctx.supabase
        .from("conversations")
        .select("id, status, assignee_kind, assigned_to_user_id, bot_silenced_until")
        .eq("contact_id", contact.id)
        .eq("organization_id", ctx.organizationId);

      const hasActiveHumanHandoff = (convs ?? []).some(
        (c: {
          assigned_to_user_id: string | null;
          assignee_kind: string | null;
          status: string;
        }) => c.status === "open" && (c.assigned_to_user_id !== null || c.assignee_kind === "user"),
      );

      if (hasActiveHumanHandoff) {
        results.push({
          lead_id: lead.id,
          lead_title: lead.title,
          contact_id: contact.id,
          phone_number: normalizedPhone,
          result: "rejected",
          reason: "Contato em atendimento humano ativo incompatível com prospecção.",
          force_human_before: isForceHuman,
          force_human_after: isForceHuman,
          queued: false,
          message_sent: false,
        });
        rejectedCount++;
        continue;
      }

      // 10. Já inscrito nesta campanha (Idempotência)
      const placeId = `lead:${lead.id}`;
      const { data: existingInSame } = await ctx.supabase
        .from("prospecting_candidates")
        .select("id, status, place_id, phone, campaign_id")
        .eq("organization_id", ctx.organizationId)
        .eq("campaign_id", campaign.id)
        .or(
          `lead_id.eq.${lead.id},contact_id.eq.${contact.id},place_id.eq.${placeId},phone.eq.${normalizedPhone}`,
        )
        .maybeSingle();

      if (existingInSame) {
        results.push({
          lead_id: lead.id,
          lead_title: lead.title,
          contact_id: contact.id,
          phone_number: normalizedPhone,
          result: "already_enrolled",
          reason: `Lead já inscrito nesta campanha (candidato ${existingInSame.id}, status: ${existingInSame.status}).`,
          force_human_before: isForceHuman,
          force_human_after: isForceHuman,
          queued: false,
          message_sent: false,
        });
        alreadyEnrolledCount++;
        continue;
      }

      // 11. Já inscrito em outra campanha ativa/na fila (Deduplicação)
      const { data: existingInOther } = await ctx.supabase
        .from("prospecting_candidates")
        .select("id, status, campaign_id")
        .eq("organization_id", ctx.organizationId)
        .neq("campaign_id", campaign.id)
        .in("status", ["new", "queued", "sending", "sent"])
        .or(`lead_id.eq.${lead.id},contact_id.eq.${contact.id},phone.eq.${normalizedPhone}`)
        .maybeSingle();

      if (existingInOther) {
        results.push({
          lead_id: lead.id,
          lead_title: lead.title,
          contact_id: contact.id,
          phone_number: normalizedPhone,
          result: "rejected",
          reason: `Telefone/contato já vinculado a outra campanha de prospecção da organização (${existingInOther.campaign_id}).`,
          force_human_before: isForceHuman,
          force_human_after: isForceHuman,
          queued: false,
          message_sent: false,
        });
        rejectedCount++;
        continue;
      }

      // 12. release_for_xavier
      let forceHumanAfter = isForceHuman;

      if (isForceHuman && !input.release_for_xavier) {
        results.push({
          lead_id: lead.id,
          lead_title: lead.title,
          contact_id: contact.id,
          phone_number: normalizedPhone,
          result: "requires_xavier_release",
          reason:
            "Contato protegido com force_human=true. Requer release_for_xavier=true para autorizar a automação.",
          force_human_before: true,
          force_human_after: true,
          queued: false,
          message_sent: false,
        });
        requiresReleaseCount++;
        continue;
      }

      if (isForceHuman && input.release_for_xavier) {
        const { error: updErr } = await ctx.supabase
          .from("contacts")
          .update({ force_human: false })
          .eq("id", contact.id)
          .eq("organization_id", ctx.organizationId)
          .eq("ai_opt_out", false);

        if (updErr) {
          throw new Error(`Falha ao remover force_human do contato: ${updErr.message}`);
        }

        await ctx.supabase
          .from("conversations")
          .update({ bot_silenced_until: null })
          .eq("contact_id", contact.id)
          .eq("organization_id", ctx.organizationId);

        forceHumanAfter = false;

        void audit({
          action: "contact.updated",
          organizationId: ctx.organizationId,
          actorUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
          actorApiTokenId: ctx.apiTokenId,
          resourceType: "contact",
          resourceId: contact.id,
          requestId: ctx.requestId,
          metadata: {
            field: "force_human",
            force_human: false,
            lead_id: lead.id,
            campaign_id: campaign.id,
            campaign_name: campaign.name,
            reason: "release_for_xavier via MCP enroll_leads_in_prospecting_campaign",
          },
        });
      }

      // 13. Inscrição na campanha
      let boundary: unknown = null;
      let conversationId: string | null = null;

      try {
        boundary = await beginServiceAtOrigin(
          ctx.supabase,
          ctx.organizationId,
          contact.id,
          config.channel_session_id,
        );
        conversationId = (boundary as { conversation_id?: string })?.conversation_id ?? null;
      } catch {
        const { data: convFallback } = await ctx.supabase
          .from("conversations")
          .select("id")
          .eq("contact_id", contact.id)
          .eq("organization_id", ctx.organizationId)
          .maybeSingle();
        conversationId = convFallback?.id ?? null;
      }

      if (conversationId) {
        const { data: convData } = await ctx.supabase
          .from("conversations")
          .select("metadata")
          .eq("id", conversationId)
          .eq("organization_id", ctx.organizationId)
          .maybeSingle();

        const prevMetadata =
          convData?.metadata && typeof convData.metadata === "object" ? convData.metadata : {};

        await ctx.supabase
          .from("conversations")
          .update({
            active_ai_agent_id: config.agent_id,
            metadata: {
              ...prevMetadata,
              prospecting_campaign_id: campaign.id,
            },
          })
          .eq("id", conversationId)
          .eq("organization_id", ctx.organizationId);
      }

      const candidateStatus = campaign.status === "draft" ? "new" : "queued";
      const candidateData = {
        key: placeId,
        name: lead.title,
        phone: normalizedPhone,
        lead_id: lead.id,
        contact_id: contact.id,
      };

      const { data: insertedCandidate, error: insErr } = await ctx.supabase
        .from("prospecting_candidates")
        .insert({
          organization_id: ctx.organizationId,
          campaign_id: campaign.id,
          place_id: placeId,
          phone: normalizedPhone,
          data: candidateData,
          status: candidateStatus,
          contact_id: contact.id,
          lead_id: lead.id,
          conversation_id: conversationId,
          service_boundary: boundary,
          selected: true,
        })
        .select("id, status")
        .single();

      if (insErr) {
        results.push({
          lead_id: lead.id,
          lead_title: lead.title,
          contact_id: contact.id,
          phone_number: normalizedPhone,
          result: "rejected",
          reason: `Falha ao inserir candidato na campanha: ${insErr.message}`,
          force_human_before: isForceHuman,
          force_human_after: forceHumanAfter,
          queued: false,
          message_sent: false,
        });
        rejectedCount++;
        continue;
      }

      await emitLeadActivity(ctx.supabase, {
        organizationId: ctx.organizationId,
        leadId: lead.id,
        contactId: contact.id,
        type: "lead_edited",
        sourceModule: "mcp_chatgpt",
        actor: ctx.actor,
        reason: `Inscrito na campanha de prospecção "${campaign.name}" via MCP`,
        payload: {
          campaign_id: campaign.id,
          campaign_name: campaign.name,
          candidate_id: insertedCandidate.id,
          status: candidateStatus,
          release_for_xavier: input.release_for_xavier && isForceHuman,
        },
      });

      void audit({
        action: "lead.updated",
        organizationId: ctx.organizationId,
        actorUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
        actorApiTokenId: ctx.apiTokenId,
        resourceType: "crm_lead",
        resourceId: lead.id,
        requestId: ctx.requestId,
        metadata: {
          event: "candidate_enrolled",
          campaign_id: campaign.id,
          campaign_name: campaign.name,
          candidate_id: insertedCandidate.id,
          lead_id: lead.id,
          contact_id: contact.id,
          phone: normalizedPhone,
          status: candidateStatus,
          released_for_xavier: input.release_for_xavier && isForceHuman,
        },
      });

      results.push({
        lead_id: lead.id,
        lead_title: lead.title,
        contact_id: contact.id,
        phone_number: normalizedPhone,
        result: "enrolled",
        reason: `Inscrito com sucesso na fila da campanha "${campaign.name}".`,
        force_human_before: isForceHuman,
        force_human_after: forceHumanAfter,
        queued: true,
        message_sent: false,
      });
      enrolledCount++;
    }

    return {
      campaign_id: campaign.id,
      campaign_name: campaign.name,
      total_requested: input.lead_ids.length,
      enrolled: enrolledCount,
      already_enrolled: alreadyEnrolledCount,
      rejected: rejectedCount,
      requires_xavier_release: requiresReleaseCount,
      results,
    };
  },
};

export const chatGptTools: ReadonlyArray<McpToolDefinition> = [
  searchLeadsTool,
  getLeadTool,
  createLeadTool,
  updateLeadTool,
  addLeadNoteTool,
  moveLeadStageTool,
  setHumanServiceTool,
  getContactAutomationStatusTool,
  assignAgentTool,
  listPipelineStagesTool,
  upsertLeadContactTool,
  enrollLeadsInProspectingCampaignTool,
] as unknown as ReadonlyArray<McpToolDefinition>;
