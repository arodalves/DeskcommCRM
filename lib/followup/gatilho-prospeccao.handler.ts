/**
 * Handler do dispatcher event_log para o aceite inicial da prospecção.
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  EVENTO_PROSPECCAO_ACEITE_INICIAL,
  EVENTO_PROSPECCAO_CONVERSA_INTERROMPIDA,
  aplicaGatilhoDeProspeccao,
  aplicaGatilhoConversaInterrompida,
} from "./gatilho-prospeccao";

export const FOLLOWUP_GATILHO_PROSPECCAO_HANDLER_KEY = "followup-gatilho-prospeccao.v1";

export const followupGatilhoProspeccaoHandler: EventHandler = {
  key: FOLLOWUP_GATILHO_PROSPECCAO_HANDLER_KEY,
  naOrgParada: "pula",
  events: [EVENTO_PROSPECCAO_ACEITE_INICIAL, EVENTO_PROSPECCAO_CONVERSA_INTERROMPIDA],
  async handle(row): Promise<HandlerResult> {
    try {
      const admin = createAdminClient();
      if (row.event_type === EVENTO_PROSPECCAO_ACEITE_INICIAL) {
        const summary = await aplicaGatilhoDeProspeccao({ admin }, row);
        return {
          consumer_key: FOLLOWUP_GATILHO_PROSPECCAO_HANDLER_KEY,
          status: summary.matched && summary.enrolled > 0 ? "ok" : "skipped",
          detail:
            `aceite_inicial: armados=${summary.pointers_armados} enrolled=${summary.enrolled} ` +
            `retroativo=${summary.skipped_retroactive} existente=${summary.skipped_existing} ` +
            `exclusao=${summary.skipped_exclusion} campanha=${summary.skipped_unmatched_campaign}`,
        };
      }

      if (row.event_type === EVENTO_PROSPECCAO_CONVERSA_INTERROMPIDA) {
        const summary = await aplicaGatilhoConversaInterrompida({ admin }, row);
        return {
          consumer_key: FOLLOWUP_GATILHO_PROSPECCAO_HANDLER_KEY,
          status: summary.matched && summary.enrolled > 0 ? "ok" : "skipped",
          detail:
            `conversa_interrompida: armados=${summary.pointers_armados} enrolled=${summary.enrolled} ` +
            `retroativo=${summary.skipped_retroactive} existente=${summary.skipped_existing} ` +
            `exclusao=${summary.skipped_exclusion} campanha=${summary.skipped_unmatched_campaign}`,
        };
      }

      return {
        consumer_key: FOLLOWUP_GATILHO_PROSPECCAO_HANDLER_KEY,
        status: "skipped",
        detail: "evento_desconhecido",
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { consumer_key: FOLLOWUP_GATILHO_PROSPECCAO_HANDLER_KEY, status: "error", detail };
    }
  },
};
