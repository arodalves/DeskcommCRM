import { describe, it, expect } from "vitest";
import { ehRespostaAutomatica, normalizarTexto } from "@/lib/prospecting/resposta-automatica";

describe("ehRespostaAutomatica — detecção de mensagens automáticas / ausência / bots", () => {
  it("detecta mensagens de ausência e indisponibilidade típicas", () => {
    expect(ehRespostaAutomatica("No momento não estamos disponíveis.")).toBe(true);
    expect(ehRespostaAutomatica("Deixe seu nome e sua solicitação que em breve retornaremos.")).toBe(true);
    expect(ehRespostaAutomatica("Retornaremos sua mensagem o mais breve possível.")).toBe(true);
    expect(
      ehRespostaAutomatica(
        "Obrigada pelo seu contato.\n\nNo momento não estamos disponíveis,  retornaremos sua mensagem o mais breve possível.\n\nAgradeço pelo compreensão \n\nVitória Armários Planejados.",
      ),
    ).toBe(true);
    expect(
      ehRespostaAutomatica(
        "A Vitória Armários agradece seu contato. No momento não estamos disponíveis. Deixe seu nome e sua solicitação que em breve retornaremos.",
      ),
    ).toBe(true);
    expect(ehRespostaAutomatica("Estamos fora do horário de atendimento. Nosso expediente é de seg a sex das 8h às 18h.")).toBe(true);
    expect(ehRespostaAutomatica("Olá! No momento estamos ausentes, logo retornaremos seu contato.")).toBe(true);
    expect(ehRespostaAutomatica("Agradecemos o seu contato! No momento estamos em atendimento externo, retornaremos em breve.")).toBe(true);
  });

  it("detecta bots, menus numéricos e respostas padronizadas declaradas", () => {
    expect(ehRespostaAutomatica("Esta é uma mensagem automática. Escolha uma opção para continuar.")).toBe(true);
    expect(ehRespostaAutomatica("Olá! Digite 1 para Comercial ou 2 para Financeiro.")).toBe(true);
    expect(ehRespostaAutomatica("1 - Orçamentos\n2 - Financeiro\n3 - Falar com atendente")).toBe(true);
    expect(ehRespostaAutomatica("Sou o assistente virtual da marcenaria. Como posso ajudar?")).toBe(true);
  });

  it("detecta recusa padronizada automática de fornecedores / parcerias", () => {
    expect(ehRespostaAutomatica("Olá! No momento não estamos aceitando fornecedores ou novas parcerias.")).toBe(true);
    expect(ehRespostaAutomatica("Não estamos contratando fornecedores no momento.")).toBe(true);
  });

  it("NÃO confunde respostas humanas com respostas automáticas", () => {
    expect(ehRespostaAutomatica("Olá! Tudo bem? Pode fazer a pergunta sim.")).toBe(false);
    expect(
      ehRespostaAutomatica("Oi Xavier, tudo bem? A gente faz o acompanhamento pelo WhatsApp mesmo quando dá tempo."),
    ).toBe(false);
    expect(ehRespostaAutomatica("Boa tarde, quem fala?")).toBe(false);
    expect(ehRespostaAutomatica("Olá, do que se trata?")).toBe(false);
    expect(ehRespostaAutomatica("Sim, pode perguntar.")).toBe(false);
    expect(ehRespostaAutomatica("Não tenho interesse.")).toBe(false);
    expect(ehRespostaAutomatica("Não quero, obrigado.")).toBe(false);
    expect(ehRespostaAutomatica("Me manda um email com a apresentação.")).toBe(false);
    expect(ehRespostaAutomatica("Pode me ligar mais tarde?")).toBe(false);
    expect(ehRespostaAutomatica("Qual o valor do sistema de vocês?")).toBe(false);
  });

  it("lida corretamente com entradas vazias, nulas ou indefinidas", () => {
    expect(ehRespostaAutomatica("")).toBe(false);
    expect(ehRespostaAutomatica(null)).toBe(false);
    expect(ehRespostaAutomatica(undefined)).toBe(false);
    expect(ehRespostaAutomatica("   ")).toBe(false);
  });
});
