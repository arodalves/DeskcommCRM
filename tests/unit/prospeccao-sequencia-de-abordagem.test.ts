import { describe, it, expect, vi } from "vitest";
import { primeiraAbordagem, orientacaoDaSequencia } from "@/lib/prospecting/sequencia-de-abordagem";
import { prospectingConversationContext } from "@/lib/prospecting/context";
import { ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";
import type { Queryable } from "@/lib/agent-engine/queue/queue";

const aviso = "Caso prefira não receber novos contatos, basta me avisar.";
const oi = "Olá, boa tarde! Tudo bem? Com quem eu falo, por gentileza?";
const entrada = (body: string | null) => ({ direction: "inbound", body });
const saida = (body: string) => ({ direction: "outbound", body, status: "sent" });
describe("sequência da prospecção", () => {
  it("não confunde bloqueio automático de fornecedores com recusa humana", () => {
    expect(orientacaoDaSequencia([entrada("Não temos interesse em fornecedores.")])).toContain(
      "Mensagem automática",
    );
  });
  it("compõe saudação sem acrescentar nem manter rodapé duplicado", () => {
    expect(primeiraAbordagem(oi)).toBe(oi);
    expect(primeiraAbordagem(`${oi}\n\n${aviso}\n\n${aviso}`)).toBe(oi);
    expect(() => primeiraAbordagem(aviso)).toThrow();
  });
  it("apresenta identidade e motivo comercial com saída natural após humano", () => {
    const regra = orientacaoDaSequencia([entrada("Aqui é a Ana, pode falar"), saida(oi)]);
    expect(regra).toContain("nome e a empresa reais");
    expect(regra).toContain("motivo comercial");
    expect(regra).toContain("uma única vez");
    expect(regra).not.toContain("PARAR");
  });
  it.each(["Não quero receber mais mensagens", "Não me contate mais", "Sem interesse", "pare"])(
    "respeita recusa: %s",
    (texto) => {
      expect(orientacaoDaSequencia([entrada(texto)])).toContain("não insista");
    },
  );
  it("continua reconhecendo opt-out sem comando artificial", () => {
    expect(ehPedidoDeOptOut("Não quero receber novos contatos")).toBe(true);
  });
  it.each([
    "Mensagem automática: retornaremos em breve",
    "Digite 1 para comercial",
    "Para agilizar seu orçamento",
  ])("automação não dispara apresentação: %s", (body) => {
    expect(orientacaoDaSequencia([entrada(body)])).toContain("não antecipe");
  });
  it("contato já abordado com aviso antigo não recebe aviso repetido", () => {
    expect(orientacaoDaSequencia([entrada("Sou a Ana"), saida(`${oi}\n${aviso}`)])).toContain(
      "Não repita",
    );
    expect(
      orientacaoDaSequencia([
        entrada("Sim"),
        saida("Se preferir não receber novos contatos, pode me avisar."),
      ]),
    ).toContain("Não repita");
  });
  it("sem texto não infere humano", () => {
    expect(orientacaoDaSequencia([entrada(null)])).toContain("Aguarde");
  });
  it("não injeta sequência no agente de outra campanha", async () => {
    const id = "10000000-0000-4000-8000-000000000001";
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          config: {
            agent_id: id,
            channel_session_id: id,
            pipeline_id: id,
            stage_id: id,
            qualified_stage_id: id,
            instruction: "Oferta do operador",
            qualification: "Critérios confirmados",
            legal_basis_ref: "LIA",
          },
        },
      ],
    });
    expect(
      await prospectingConversationContext(
        { query } as unknown as Queryable,
        "org",
        "conv",
        "outro-agente",
        id,
      ),
    ).toBe("");
    expect(query).toHaveBeenCalledTimes(1);
  });
});
