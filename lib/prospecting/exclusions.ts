/**
 * Proteção estrutural e persistente contra abordagem e follow-up automático
 * de leads manuais da Fluxalvo CRM.
 *
 * Atua em três pontos do funil:
 * 1. Na descoberta (busca de empresas / Google Places / importação)
 * 2. Antes da inscrição no follow-up
 * 3. Antes do envio de cada mensagem / follow-up
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const SETE_LEADS_MANUAIS_PROTEGIDOS = [
  "Dra. Caroline Oliveira - Harmonização Facial",
  "Estética Avançada Glaucia Lopes",
  "Rayane Resende Estética Avançada",
  "Dra. Aline Cecília Biomedicina Estética",
  "Liv’s Clínica de Estética - Contagem",
  "Clínica Perle - Harmonização Facial e Estética Avançada",
  "Aline de Castro Estética Facial",
] as const;

export function normalizarParaComparacao(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos
    .replace(/[’'"`\-–—.,/\\()]/g, " ") // pontuação vira espaço
    .replace(/\s+/g, " ")
    .trim();
}

const NOMES_NORMALIZADOS_PROTEGIDOS = SETE_LEADS_MANUAIS_PROTEGIDOS.map((n) => ({
  original: n,
  normalizado: normalizarParaComparacao(n),
}));

/**
 * Regra para Caroline:
 * - Não inventar telefone
 * - Não inventar e-mail
 * - Não associar contato por nome arbitrário
 * - Utilizar somente identificadores reais disponíveis ou título exato do lead
 */
export function correspondeALeadManualProtegido(
  tituloOuNome: string | null | undefined,
  opcoes?: { isContactName?: boolean },
): { protegido: boolean; leadProtegido?: string } {
  if (!tituloOuNome || typeof tituloOuNome !== "string") {
    return { protegido: false };
  }

  const norm = normalizarParaComparacao(tituloOuNome);
  if (!norm) return { protegido: false };

  for (const item of NOMES_NORMALIZADOS_PROTEGIDOS) {
    // Se for nome de contato e for a Caroline, não faz associação por nome arbitrário
    if (opcoes?.isContactName && item.original.includes("Caroline Oliveira")) {
      // Exige match exato do nome completo para contato
      if (norm === item.normalizado) {
        return { protegido: true, leadProtegido: item.original };
      }
      continue;
    }

    if (norm === item.normalizado) {
      return { protegido: true, leadProtegido: item.original };
    }

    // Match de título comercial ou clínica (ex: "Clínica Perle", "Liv's Clínica")
    if (!opcoes?.isContactName) {
      if (norm.includes(item.normalizado) || item.normalizado.includes(norm)) {
        if (norm.length >= 10) {
          return { protegido: true, leadProtegido: item.original };
        }
      }
    }
  }

  return { protegido: false };
}

export interface ChecarExclusaoParams {
  organizationId: string;
  leadId?: string | null;
  contactId?: string | null;
  phone?: string | null;
  placeId?: string | null;
  title?: string | null;
}

export async function checarExclusaoDeProspeccao(
  admin: SupabaseClient,
  params: ChecarExclusaoParams,
): Promise<{ excluido: boolean; motivo?: string }> {
  const { organizationId, leadId, contactId, phone, placeId, title } = params;

  // 1. Verificação em memória dos 7 leads manuais protegidos pelo título
  if (title) {
    const match = correspondeALeadManualProtegido(title);
    if (match.protegido) {
      return {
        excluido: true,
        motivo: `Lead manual protegido contra abordagem/follow-up de prospecção: ${match.leadProtegido}`,
      };
    }
  }

  // 2. Consulta à tabela de exclusões persistentes (prospecting_exclusions)
  if (leadId) {
    const { data: excLead } = await admin
      .from("prospecting_exclusions")
      .select("reason, canonical_name")
      .eq("organization_id", organizationId)
      .eq("lead_id", leadId)
      .maybeSingle();

    if (excLead) {
      return {
        excluido: true,
        motivo: `Exclusão persistente ativa para o lead: ${excLead.reason}`,
      };
    }
  }

  if (contactId) {
    const { data: excContact } = await admin
      .from("prospecting_exclusions")
      .select("reason, canonical_name")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId)
      .maybeSingle();

    if (excContact) {
      return {
        excluido: true,
        motivo: `Exclusão persistente ativa para o contato: ${excContact.reason}`,
      };
    }
  }

  if (phone) {
    const { data: excPhone } = await admin
      .from("prospecting_exclusions")
      .select("reason, canonical_name")
      .eq("organization_id", organizationId)
      .eq("phone", phone)
      .maybeSingle();

    if (excPhone) {
      return {
        excluido: true,
        motivo: `Exclusão persistente ativa para o telefone informado: ${excPhone.reason}`,
      };
    }
  }

  if (placeId) {
    const { data: excPlace } = await admin
      .from("prospecting_exclusions")
      .select("reason, canonical_name")
      .eq("organization_id", organizationId)
      .eq("place_id", placeId)
      .maybeSingle();

    if (excPlace) {
      return {
        excluido: true,
        motivo: `Exclusão persistente ativa para o place_id: ${excPlace.reason}`,
      };
    }
  }

  // 3. Verificação em crm_leads e contacts se leadId ou contactId foram informados
  if (leadId) {
    const { data: lead } = await admin
      .from("crm_leads")
      .select("title")
      .eq("organization_id", organizationId)
      .eq("id", leadId)
      .maybeSingle();

    if (lead?.title) {
      const match = correspondeALeadManualProtegido(lead.title);
      if (match.protegido) {
        return {
          excluido: true,
          motivo: `Lead manual protegido pelo cadastro: ${match.leadProtegido}`,
        };
      }
    }
  }

  if (contactId) {
    const { data: contact } = await admin
      .from("contacts")
      .select("name")
      .eq("organization_id", organizationId)
      .eq("id", contactId)
      .maybeSingle();

    if (contact?.name) {
      const match = correspondeALeadManualProtegido(contact.name, { isContactName: true });
      if (match.protegido) {
        return {
          excluido: true,
          motivo: `Contato manual protegido: ${match.leadProtegido}`,
        };
      }
    }
  }

  return { excluido: false };
}
