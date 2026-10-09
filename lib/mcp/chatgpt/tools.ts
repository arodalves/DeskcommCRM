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
import { canonicalPhoneBR, phoneLookupVariants } from "@/lib/channels/phone-variants";
import { silencioVigente } from "@/lib/inbox/comando-da-conversa";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import type { McpContext, McpToolDefinition } from "@/lib/mcp/types";

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

    for (const c of (matchedContacts ?? [])) {
      contactMap.set(c.id, c);
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

    // Carrega contatos que possam estar vinculados aos leads encontrados por título
    const missingContactIds = (leads ?? [])
      .map((l) => l.contact_id)
      .filter((cid): cid is string => Boolean(cid) && !contactMap.has(cid));

    if (missingContactIds.length > 0) {
      const { data: moreContacts } = await ctx.supabase
        .from("contacts")
        .select("id, name, display_name, phone_number, email, force_human")
        .eq("organization_id", ctx.organizationId)
        .in("id", missingContactIds);

      for (const mc of moreContacts ?? []) {
        contactMap.set(mc.id, mc);
      }
    }

    // Enriquecimento com pipeline e estágio
    const pipelineIds = [...new Set((leads ?? []).map((l) => l.pipeline_id))];
    const stageIds = [...new Set((leads ?? []).map((l) => l.stage_id))];

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

    const pipelineMap = new Map((pipelinesRes.data ?? []).map((p) => [p.id, p.name]));
    const stageMap = new Map((stagesRes.data ?? []).map((s) => [s.id, s.name]));

    const enriched = (leads ?? []).map((l) => {
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
    let leadId: string | null = input.lead_id ?? null;

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
    const convList = (conversations ?? []).map((c) => {
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

    const pipeIds = (pipelines ?? []).map((p) => p.id);
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

    for (const s of stages ?? []) {
      const arr = stagesByPipe.get(s.pipeline_id) ?? [];
      arr.push(s);
      stagesByPipe.set(s.pipeline_id, arr);
    }

    return {
      pipelines: (pipelines ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        is_default: p.is_default,
        stages: stagesByPipe.get(p.id) ?? [],
      })),
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
] as unknown as ReadonlyArray<McpToolDefinition>;
