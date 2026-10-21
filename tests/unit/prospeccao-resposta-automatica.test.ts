import { describe, it, expect, vi } from "vitest";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import {
  ehRespostaAutomatica,
  ehBloqueioDeFornecedor,
  classificarNivelAutomacao,
  contarTentativasContraBot,
} from "@/lib/prospecting/resposta-automatica";
import { prospectingConversationContext } from "@/lib/prospecting/context";

describe("Classificação de Níveis de Automação e Respostas Automáticas", () => {
  it("1. Resposta automática simples (Nível 1): detecta ausência, horário, retorno em breve e boas-vindas", () => {
    const exemplos = [
      "No momento não estamos disponíveis.",
      "Deixe seu nome e sua solicitação que em breve retornaremos.",
      "Retornaremos sua mensagem o mais breve possível.",
      "Obrigada pelo seu contato.\n\nNo momento não estamos disponíveis, retornaremos sua mensagem o mais breve possível.\n\nVitória Armários Planejados.",
      "A Vitória Armários agradece seu contato. No momento não estamos disponíveis. Deixe seu nome e sua solicitação que em breve retornaremos.",
      "Estamos fora do horário de atendimento. Nosso expediente é de seg a sex das 8h às 18h.",
      "Olá! No momento estamos ausentes, logo retornaremos seu contato.",
      "Agradecemos o seu contato! No momento estamos em atendimento externo, retornaremos em breve.",
      "Olá! Esta é uma mensagem automática de boas-vindas da Marcenaria Silva.",
    ];

    for (const texto of exemplos) {
      expect(classificarNivelAutomacao(texto)).toBe(1);
      expect(ehRespostaAutomatica(texto)).toBe(true);
    }
  });

  it("2. Menu básico (Nível 2): detecta seleção de setores, triagem e menus numerados", () => {
    const exemplos = [
      "Olá! Digite 1 para Comercial ou 2 para Financeiro.",
      "1 - Orçamentos\n2 - Financeiro\n3 - Outros Assuntos",
      "Escolha um setor:\n1. Vendas\n2. Suporte",
      "Envie 1 para falar com um atendente ou 2 para ver nosso catálogo.",
      "Selecione uma opção do menu para direcionarmos seu atendimento.",
    ];

    for (const texto of exemplos) {
      expect(classificarNivelAutomacao(texto)).toBe(2);
      expect(ehRespostaAutomatica(texto)).toBe(true);
    }
  });

  it("3. Bloqueio automático a fornecedores: detecta recusa de bot sem confundir com recusa humana", () => {
    const exemplos = [
      "Olá! No momento não estamos aceitando fornecedores ou novas parcerias.",
      "Não estamos contratando fornecedores no momento.",
      "Não temos interesse em parcerias ou fornecedores.",
      "Agradecemos o contato, mas não aceitamos propostas de fornecedor por este canal.",
    ];

    for (const texto of exemplos) {
      expect(ehBloqueioDeFornecedor(texto)).toBe(true);
      expect(ehRespostaAutomatica(texto)).toBe(true);
      expect(classificarNivelAutomacao(texto)).toBe(2);
    }
  });

  it("4. Bot com sinais de automação mais avançada (Nível 3): detecta coleta estruturada de dados e agendamento", () => {
    const exemplos = [
      "Para agilizar seu orçamento, qual o tipo de móvel planejado que você precisa?",
      "Para iniciar o orçamento, já possui projeto e medidas do ambiente?",
      "Nosso assistente irá coletar seus dados para orçamento. Informe seu nome completo e cidade.",
      "Gostaria de agendar uma visita técnica gratuita com nosso projetista?",
      "Para enviar seu orçamento, qual o tipo de móvel e qual a sua cidade?",
    ];

    for (const texto of exemplos) {
      expect(classificarNivelAutomacao(texto)).toBe(3);
      expect(ehRespostaAutomatica(texto)).toBe(true);
    }
  });

  it("5. Recusa humana real (Nível 0): não confunde mensagens humanas com bots", () => {
    const exemplos = [
      "Olá! Tudo bem? Pode fazer a pergunta sim.",
      "Oi Xavier, tudo bem? A gente faz o acompanhamento pelo WhatsApp mesmo quando dá tempo.",
      "Boa tarde, quem fala?",
      "Olá, do que se trata?",
      "Sim, pode perguntar.",
      "Não tenho interesse, obrigado.",
      "Não temos interesse em nenhuma parceria ou sistema, por favor não insistir.",
      "Não quero mais receber mensagens.",
      "Nós já temos um sistema de CRM próprio e uma equipe que faz follow-up estruturado diariamente.",
    ];

    for (const texto of exemplos) {
      expect(classificarNivelAutomacao(texto)).toBe(0);
      expect(ehBloqueioDeFornecedor(texto)).toBe(false);
      expect(ehRespostaAutomatica(texto)).toBe(false);
    }
  });

  it("6. Proteção contra loops: conta tentativas consecutivas contra bot e detecta limite de 1 tentativa", () => {
    // Caso 1: Nenhuma tentativa anterior contra bot (mesmo que a mensagem inicial contenha a palavra 'comercial')
    const convoSemTentativa = [
      {
        direction: "outbound",
        body: "Olá! Sou Xavier, da Fluxalvo... Posso falar com o responsável comercial para entender como vocês acompanham os pedidos de orçamento pelo WhatsApp?",
      },
      { direction: "inbound", body: "1 - Orçamentos\n2 - Financeiro\n3 - Outros Assuntos" },
    ];
    expect(contarTentativasContraBot(convoSemTentativa)).toBe(0);

    // Caso 1b: Caso real Imagine Planejados DM (Dawan pede para deixar solicitação)
    const convoImaginePlanejados = [
      {
        direction: "outbound",
        body: "Olá! Sou Xavier, da Fluxalvo, e encontrei a Imagine Planejados DM em uma pesquisa pública de marcenarias. Posso falar com o responsável comercial para entender como vocês acompanham os pedidos de orçamento pelo WhatsApp?\n\nCaso prefira não receber novos contatos, basta me avisar.",
      },
      {
        direction: "inbound",
        body: "Olá, seja bem vindo (a).\n\nAqui é o Dawan, do Imagine Planejados e será um prazer auxiliar na realização do móvel do seu sonho!  \n\nPor favor, deixe sua solicitação que em breve responderei. \n\n🏡",
      },
    ];
    expect(contarTentativasContraBot(convoImaginePlanejados)).toBe(0);

    // Caso 2: 1 tentativa realizada (escolheu opção ou tentou contornar bloqueio)
    const convoUmaTentativa = [
      { direction: "outbound", body: "Olá! Sou Xavier, da Fluxalvo..." },
      { direction: "inbound", body: "1 - Orçamentos\n2 - Financeiro\n3 - Outros Assuntos" },
      { direction: "outbound", body: "6 - Outros Assuntos" },
      { direction: "inbound", body: "Não temos interesse em parcerias ou fornecedores." },
    ];
    expect(contarTentativasContraBot(convoUmaTentativa)).toBe(1);

    // Caso 3: Xavier fez o esclarecimento e bot repetiu bloqueio -> tentativas >= 1 (deve parar!)
    const convoLoop = [
      ...convoUmaTentativa,
      {
        direction: "outbound",
        body: "Entendi! Na verdade não é proposta de fornecimento. Consigo falar com alguém do comercial?",
      },
      { direction: "inbound", body: "Não temos interesse em parcerias ou fornecedores." },
    ];
    expect(contarTentativasContraBot(convoLoop)).toBe(2);

    // Caso 4: Humano respondeu -> zera o histórico de tentativas contra bot
    const convoHumanoRespondeu = [
      ...convoLoop,
      { direction: "inbound", body: "Oi Xavier, aqui é o Marcelo do comercial. Pode falar." },
    ];
    expect(contarTentativasContraBot(convoHumanoRespondeu)).toBe(0);
  });

  it("7. Proteção dos follow-ups existentes: respostas de Níveis 1, 2 e 3 retornam true em ehRespostaAutomatica", () => {
    // Garante que nenhuma resposta de bot ative "conversa interrompida" ou conte como humano nos guards
    const botMessages = [
      "No momento não estamos disponíveis.",
      "1 - Orçamentos\n2 - Financeiro",
      "Não aceitamos fornecedores.",
      "Para agilizar seu orçamento, qual o tipo de móvel?",
    ];

    for (const msg of botMessages) {
      expect(ehRespostaAutomatica(msg)).toBe(true);
    }
  });

  it("8. Contexto situacional em prospectingConversationContext: injeta anti-loop e diretrizes adaptativas", async () => {
    const mockDb = {
      query: vi.fn((sql: string) => {
        if (sql.includes("prospecting_candidates")) {
          return Promise.resolve({
            rows: [
              {
                config: {
                  agent_id: "210a010f-5837-458b-9a66-21fc9e5a65e3",
                  channel_session_id: "7b47b2c2-8b0a-4145-8890-d6c878bd96f7",
                  instruction: "Abordagem inicial",
                  qualification: "Critérios de qualificação",
                  pipeline_id: "2ddec45b-1cb6-45c7-a8eb-5ac6a23e5873",
                  stage_id: "b6adf17c-8b0a-4145-8890-d6c878bd96f7",
                  qualified_stage_id: "c7bdf17c-8b0a-4145-8890-d6c878bd96f8",
                  daily_limit: 10,
                  interval_minutes: 15,
                  legal_basis_ref: "legitimo_interesse",
                  funnel_entry: "on_start",
                },
              },
            ],
          });
        }
        if (sql.includes("messages")) {
          // Simula bot repetindo após tentativa de Xavier
          return Promise.resolve({
            rows: [
              { direction: "inbound", body: "Não temos interesse em fornecedores." },
              {
                direction: "outbound",
                body: "Entendi! Na verdade não é proposta de fornecimento. Consigo falar com alguém do comercial?",
              },
              { direction: "inbound", body: "1 - Orçamentos\n2 - Financeiro" },
              { direction: "outbound", body: "Olá! Sou Xavier, da Fluxalvo..." },
            ],
          });
        }
        return Promise.resolve({ rows: [] });
      }),
    };

    const ctx = await prospectingConversationContext(mockDb as unknown as Queryable, "org-uuid", "conv-uuid");
    expect(ctx).toContain("[ORIENTAÇÃO SITUACIONAL ANTI-LOOP]");
    expect(ctx).toContain("NÃO insista, NÃO envie novas mensagens e NÃO fique em loop com o bot");
  });

  it("9. Caso Imagine Planejados: Nível 1 não encerra prematuramente e instrui registro de solicitação", async () => {
    const mockDb = {
      query: vi.fn((sql: string) => {
        if (sql.includes("prospecting_candidates")) {
          return Promise.resolve({
            rows: [
              {
                config: {
                  agent_id: "210a010f-5837-458b-9a66-21fc9e5a65e3",
                  channel_session_id: "7b47b2c2-8b0a-4145-8890-d6c878bd96f7",
                  instruction: "Abordagem inicial",
                  qualification: "Critérios de qualificação",
                  pipeline_id: "2ddec45b-1cb6-45c7-a8eb-5ac6a23e5873",
                  stage_id: "b6adf17c-8b0a-4145-8890-d6c878bd96f7",
                  qualified_stage_id: "c7bdf17c-8b0a-4145-8890-d6c878bd96f8",
                  daily_limit: 10,
                  interval_minutes: 15,
                  legal_basis_ref: "legitimo_interesse",
                  funnel_entry: "on_start",
                },
              },
            ],
          });
        }
        if (sql.includes("messages")) {
          // Primeira resposta recebida: Dawan pedindo para deixar solicitação
          return Promise.resolve({
            rows: [
              {
                direction: "inbound",
                body: "Olá, seja bem vindo (a).\nAqui é o Dawan, do Imagine Planejados... Por favor, deixe sua solicitação que em breve responderei.",
              },
              {
                direction: "outbound",
                body: "Olá! Sou Xavier, da Fluxalvo... Posso falar com o responsável comercial?\n\nCaso prefira não receber novos contatos, basta me avisar.",
              },
            ],
          });
        }
        return Promise.resolve({ rows: [] });
      }),
    };

    const ctx = await prospectingConversationContext(mockDb as unknown as Queryable, "org-uuid", "conv-uuid");
    expect(ctx).toContain("[ORIENTAÇÃO SITUACIONAL - NÍVEL 1 (BOAS-VINDAS / AUSÊNCIA / ESPERA)]");
    expect(ctx).toContain("Isso NÃO é recusa comercial e NÃO encerra a prospecção");
    expect(ctx).toContain("NÃO encerre a conversa, NÃO qualifique ou desqualifique, NÃO considere rejeição");
  });
});
