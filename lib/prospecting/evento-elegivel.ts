import type { SupabaseClient } from "@supabase/supabase-js";
import { sinaisComerciais } from "./sinais-comerciais";

/** Revalida o estado atual; o payload durável sozinho não autoriza uma retomada. */
export async function eventoDeProspeccaoElegivel(
  db: SupabaseClient,
  org: string,
  input: {
    candidate_id: string;
    campaign_id: string;
    contact_id: string;
    conversation_id: string;
    message_id: string;
  },
  interrompida: boolean,
): Promise<{ agentId: string; acceptedAt: string; sentAt: string } | null> {
  const { data: p, error } = await db
    .from("prospecting_candidates")
    .select("id,campaign_id,contact_id,conversation_id,message_id,status,provider_accepted_at,data")
    .eq("organization_id", org)
    .eq("id", input.candidate_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (
    !p ||
    p.status !== "sent" ||
    !p.provider_accepted_at ||
    p.data?.commercial_refusal ||
    p.campaign_id !== input.campaign_id ||
    p.contact_id !== input.contact_id ||
    p.conversation_id !== input.conversation_id ||
    (!interrompida && p.message_id !== input.message_id)
  )
    return null;
  const [campaign, conv, contact, msg, inbounds] = await Promise.all([
    db
      .from("prospecting_campaigns")
      .select("config,status")
      .eq("organization_id", org)
      .eq("id", p.campaign_id)
      .maybeSingle(),
    db
      .from("conversations")
      .select("channel_session_id,active_ai_agent_id,status,assigned_to_user_id,bot_silenced_until")
      .eq("organization_id", org)
      .eq("id", p.conversation_id)
      .maybeSingle(),
    db
      .from("contacts")
      .select("force_human,is_blocked,is_anonymized,ai_opt_out,consent")
      .eq("organization_id", org)
      .eq("id", p.contact_id)
      .maybeSingle(),
    db
      .from("messages")
      .select("status,sent_at,external_id,conversation_id,direction,sent_via")
      .eq("organization_id", org)
      .eq("id", input.message_id)
      .maybeSingle(),
    db
      .from("messages")
      .select("body,created_at")
      .eq("organization_id", org)
      .eq("conversation_id", p.conversation_id)
      .eq("direction", "inbound")
      .gte("created_at", p.provider_accepted_at)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  for (const result of [campaign, conv, contact, msg, inbounds])
    if (result.error) throw new Error(result.error.message);
  const c = campaign.data,
    v = conv.data,
    ct = contact.data,
    m = msg.data;
  if (
    !c ||
    !v ||
    !ct ||
    !m ||
    c.status === "cancelled" ||
    v.status !== "open" ||
    v.assigned_to_user_id ||
    v.bot_silenced_until === "infinity" ||
    Date.parse(v.bot_silenced_until ?? "") > Date.now()
  )
    return null;
  if (
    ct.force_human ||
    ct.is_blocked ||
    ct.is_anonymized ||
    ct.ai_opt_out ||
    ct.consent?.marketing?.opt_out ||
    ct.consent?.marketing?.declined_at
  )
    return null;
  const cfg = c.config as { agent_id?: string; channel_session_id?: string };
  if (
    !cfg.agent_id ||
    cfg.agent_id !== v.active_ai_agent_id ||
    cfg.channel_session_id !== v.channel_session_id
  )
    return null;
  if (
    m.conversation_id !== p.conversation_id ||
    m.direction !== "outbound" ||
    !["sent", "delivered", "read"].includes(m.status) ||
    !m.external_id ||
    !m.sent_at ||
    (interrompida && m.sent_via !== "ai")
  )
    return null;
  const replies = inbounds.data ?? [];
  if (replies.some((r) => sinaisComerciais(r.body).recusa)) return null;
  if (!interrompida && replies.length) return null;
  if (
    interrompida &&
    (!replies.some((r) => sinaisComerciais(r.body).interesse) ||
      replies.some((r) => Date.parse(r.created_at) >= Date.parse(m.sent_at)))
  )
    return null;
  return { agentId: cfg.agent_id, acceptedAt: p.provider_accepted_at, sentAt: m.sent_at };
}
