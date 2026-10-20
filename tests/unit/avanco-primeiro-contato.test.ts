import { describe, expect, it, vi } from "vitest";
import {
  sincronizarPrimeiroContatoSeElegivel,
  type EntradaAvancoPrimeiroContato,
  type DepsAvancoPrimeiroContato,
} from "@/lib/agent-engine/agent/avanco-primeiro-contato";
import type { LeadStateRow, LeadStage } from "@/lib/agent-engine/agent/lead-state";
import type { ChannelSendResult } from "@/lib/agent-engine/channel-adapter";

function mockEntrada(overrides: Partial<EntradaAvancoPrimeiroContato> = {}): EntradaAvancoPrimeiroContato {
  return {
    pool: {} as any,
    crmCfg: { supabase: {} as any, crmBaseUrl: "http://localhost:3000" } as any,
    tenantId: "tenant-fluxalvo",
    leadId: "lead-surdo",
    jobId: "job-123",
    messages: [
      { direction: "inbound", body: "Olá! Gostaria de saber mais sobre a assessoria da Fluxalvo." },
    ],
    outcomes: [
      { kind: "sent", messageId: "msg-out-1" } as ChannelSendResult,
    ],
    ...overrides,
  };
}

describe("sincronizarPrimeiroContatoSeElegivel (Avanço Determinístico para 'Já respondi')", () => {
  // Teste 1: inbound humano + primeira resposta Xavier aceita → Já respondi
  it("1. inbound humano + primeira resposta Xavier aceita → avança determinístico para contacted", async () => {
    let stateAtual: LeadStage = "new";
    const applyState = vi.fn(async () => {
      stateAtual = "contacted";
      return { ok: true as const, state: { stage: "contacted" } as LeadStateRow, transition: { from: "new" as LeadStage, to: "contacted" as LeadStage }, message: "ok" };
    });
    const mirror = vi.fn(async () => ({ ok: true as const }));
    const getLeadState = vi.fn(async () => ({ stage: stateAtual } as LeadStateRow));

    const res = await sincronizarPrimeiroContatoSeElegivel(
      mockEntrada(),
      { getLeadState, applyState, mirror },
    );

    expect(res).toEqual({ moveu: true, toStage: "contacted" });
    expect(applyState).toHaveBeenCalledTimes(1);
    expect(applyState).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: "tenant-fluxalvo", leadId: "lead-surdo", jobId: "job-123" },
      { stage: "contacted", reason: "primeira_resposta_humana_enviada" },
    );
    expect(mirror).toHaveBeenCalledTimes(1);
  });

  // Teste 2: inbound humano + falha no envio → permanece Chamou agora
  it("2. inbound humano + falha no envio → não avança (sem_envio_com_sucesso)", async () => {
    const applyState = vi.fn();
    const mirror = vi.fn();

    const res = await sincronizarPrimeiroContatoSeElegivel(
      mockEntrada({
        outcomes: [{ kind: "failed", error: "network_timeout" } as unknown as ChannelSendResult],
      }),
      { applyState, mirror },
    );

    expect(res).toEqual({ moveu: false, motivo: "sem_envio_com_sucesso" });
    expect(applyState).not.toHaveBeenCalled();
    expect(mirror).not.toHaveBeenCalled();
  });

  // Teste 3: resposta automática de ausência → permanece Chamou agora
  it("3. resposta automática de ausência → não avança (resposta_automatica)", async () => {
    const applyState = vi.fn();
    const mirror = vi.fn();

    const res = await sincronizarPrimeiroContatoSeElegivel(
      mockEntrada({
        messages: [
          { direction: "inbound", body: "Olá, nosso horário de atendimento é de segunda a sexta das 8h às 18h. Estamos ausentes no momento." },
        ],
      }),
      { applyState, mirror },
    );

    expect(res).toEqual({ moveu: false, motivo: "resposta_automatica" });
    expect(applyState).not.toHaveBeenCalled();
    expect(mirror).not.toHaveBeenCalled();
  });

  // Teste 4: menu/chatbot → permanece Chamou agora
  it("4. menu/chatbot → não avança (resposta_automatica)", async () => {
    const applyState = vi.fn();
    const mirror = vi.fn();

    const res = await sincronizarPrimeiroContatoSeElegivel(
      mockEntrada({
        messages: [
          { direction: "inbound", body: "Olá! Escolha uma opção:\n1 - Comercial\n2 - Financeiro\n3 - Suporte" },
        ],
      }),
      { applyState, mirror },
    );

    expect(res).toEqual({ moveu: false, motivo: "resposta_automatica" });
    expect(applyState).not.toHaveBeenCalled();
    expect(mirror).not.toHaveBeenCalled();
  });

  // Teste 5: bloqueio automático → permanece Chamou agora
  it("5. bloqueio automático de fornecedores → não avança (resposta_automatica)", async () => {
    const applyState = vi.fn();
    const mirror = vi.fn();

    const res = await sincronizarPrimeiroContatoSeElegivel(
      mockEntrada({
        messages: [
          { direction: "inbound", body: "Não aceitamos propostas de novos fornecedores ou parcerias." },
        ],
      }),
      { applyState, mirror },
    );

    expect(res).toEqual({ moveu: false, motivo: "resposta_automatica" });
    expect(applyState).not.toHaveBeenCalled();
    expect(mirror).not.toHaveBeenCalled();
  });

  // Teste 6: prospecção outbound inicial → permanece Chamou agora
  it("6. prospecção outbound inicial (sem inbound) → não avança (sem_inbound)", async () => {
    const applyState = vi.fn();
    const mirror = vi.fn();

    const res = await sincronizarPrimeiroContatoSeElegivel(
      mockEntrada({
        messages: [
          { direction: "outbound", body: "Olá! Aqui é o Xavier da Fluxalvo, tudo bem?" },
        ],
      }),
      { applyState, mirror },
    );

    expect(res).toEqual({ moveu: false, motivo: "sem_inbound" });
    expect(applyState).not.toHaveBeenCalled();
    expect(mirror).not.toHaveBeenCalled();
  });

  // Teste 7: prospect responde humanamente + Xavier responde → Já respondi
  it("7. prospecção: prospect responde humanamente + Xavier responde → Já respondi", async () => {
    const applyState = vi.fn(async () => ({
      ok: true as const,
      state: { stage: "contacted" } as LeadStateRow,
      transition: { from: "new" as LeadStage, to: "contacted" as LeadStage },
      message: "ok",
    }));
    const mirror = vi.fn(async () => ({ ok: true as const }));
    const getLeadState = vi.fn(async () => ({ stage: "new" } as LeadStateRow));

    const res = await sincronizarPrimeiroContatoSeElegivel(
      mockEntrada({
        messages: [
          { direction: "outbound", body: "Olá! Aqui é o Xavier da Fluxalvo, tudo bem?" },
          { direction: "inbound", body: "Tudo bem Xavier! Tenho interesse sim, me explica como funciona." },
        ],
      }),
      { getLeadState, applyState, mirror },
    );

    expect(res).toEqual({ moveu: true, toStage: "contacted" });
    expect(applyState).toHaveBeenCalledTimes(1);
    expect(mirror).toHaveBeenCalledTimes(1);
  });

  // Teste 8: execução repetida → não duplica stage_changed (idempotência)
  it("8. execução repetida / lead já em contacted → não duplica e não avança de novo", async () => {
    const applyState = vi.fn();
    const mirror = vi.fn();
    const getLeadState = vi.fn(async () => ({ stage: "contacted" } as LeadStateRow));

    const res = await sincronizarPrimeiroContatoSeElegivel(
      mockEntrada(),
      { getLeadState, applyState, mirror },
    );

    expect(res).toEqual({ moveu: false, motivo: "estagio_ja_avancado", stageAtual: "contacted" });
    expect(applyState).not.toHaveBeenCalled();
    expect(mirror).not.toHaveBeenCalled();
  });

  // Teste 9: Deusdete continua compatível (LLM já moveu durante o turno)
  it("9. Deusdete continua compatível: se LLM já avançou para contacted, avanço determinístico é no-op seguro", async () => {
    const applyState = vi.fn();
    const mirror = vi.fn();
    // No caso Deusdete, a tool update_lead_state da LLM já mudou o estado para 'contacted'
    const getLeadState = vi.fn(async () => ({ stage: "contacted" } as LeadStateRow));

    const res = await sincronizarPrimeiroContatoSeElegivel(
      mockEntrada({ leadId: "902743c9-6dbb-41e3-83bb-b73606167ee0" }),
      { getLeadState, applyState, mirror },
    );

    expect(res).toMatchObject({ moveu: false, motivo: "estagio_ja_avancado" });
    expect(applyState).not.toHaveBeenCalled();
    expect(mirror).not.toHaveBeenCalled();
  });

  // Teste 10: cenário Surdo passa a avançar deterministicamente
  it("10. cenário Surdo: LLM não chamou a tool, mas avanço determinístico move com sucesso para contacted", async () => {
    let stageAtual: LeadStage = "new";
    const getLeadState = vi.fn(async () => ({ stage: stageAtual } as LeadStateRow));
    const applyState = vi.fn(async () => {
      stageAtual = "contacted";
      return {
        ok: true as const,
        state: { stage: "contacted" } as LeadStateRow,
        transition: { from: "new" as LeadStage, to: "contacted" as LeadStage },
        message: "ok",
      };
    });
    const mirror = vi.fn(async () => ({ ok: true as const }));

    const res = await sincronizarPrimeiroContatoSeElegivel(
      mockEntrada({
        leadId: "a914f0c9-9a8e-428c-bfb2-e3bace9fbda0",
        messages: [
          { direction: "inbound", body: "Olá! Quero saber mais sobre os serviços da Fluxalvo" },
        ],
        outcomes: [
          { kind: "sent", messageId: "msg-xavier-surdo" } as ChannelSendResult,
        ],
      }),
      { getLeadState, applyState, mirror },
    );

    expect(res).toEqual({ moveu: true, toStage: "contacted" });
    expect(applyState).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: "tenant-fluxalvo", leadId: "a914f0c9-9a8e-428c-bfb2-e3bace9fbda0", jobId: "job-123" },
      { stage: "contacted", reason: "primeira_resposta_humana_enviada" },
    );
    expect(mirror).toHaveBeenCalledTimes(1);
  });
});
