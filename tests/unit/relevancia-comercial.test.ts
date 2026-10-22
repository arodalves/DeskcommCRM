/**
 * TESTES DA BARREIRA DE RELEVÂNCIA COMERCIAL
 *
 * Reproduz o caso real de referência (Antônio) e valida:
 * 1. Respostas comerciais legítimas continuam funcionando normalmente.
 * 2. Recusas e contatos acidentais encerram o atendimento com despedida única.
 * 3. Mensagens sociais posteriores (bom-dia, obrigado, imagens, figurinhas) não
 *    acionam o LLM nem geram respostas no WhatsApp.
 * 4. Imagens sem contexto comercial não geram visão multimodal paga.
 * 5. Nova intenção comercial explícita reabre o atendimento conforme as regras.
 * 6. Atendimentos de suporte e clientes ativos não são interrompidos.
 * 7. Despedida não é enviada repetidamente.
 */

import { describe, it, expect, vi } from "vitest";

import {
  ehMensagemSocial,
  ehRecusaOuSemInteresse,
  ehSolicitacaoComercialInequivoca,
  ehMensagemDeSuporteOuProblema,
  imagemTemContextoComercial,
} from "@/lib/agent-engine/relevancia/classificador";
import {
  avaliarRelevanciaDoTurno,
  type InsumosDeRelevancia,
} from "@/lib/agent-engine/relevancia/barreira";

describe("1. Classificador: Recusa comercial e contato acidental", () => {
  it("detecta contato acidental / engano", () => {
    expect(ehRecusaOuSemInteresse("entrei por engano")).toBe(true);
    expect(ehRecusaOuSemInteresse("foi engano, desculpe")).toBe(true);
    expect(ehRecusaOuSemInteresse("desculpe foi engano")).toBe(true);
    expect(ehRecusaOuSemInteresse("cliquei sem querer")).toBe(true);
    expect(ehRecusaOuSemInteresse("mensagem por engano")).toBe(true);
    expect(ehRecusaOuSemInteresse("número errado")).toBe(true);
    expect(ehRecusaOuSemInteresse("engano")).toBe(true);
  });

  it("detecta ausência expressa de interesse comercial", () => {
    expect(ehRecusaOuSemInteresse("não tenho interesse")).toBe(true);
    expect(ehRecusaOuSemInteresse("não tenho nenhum interesse")).toBe(true);
    expect(ehRecusaOuSemInteresse("não me interessa")).toBe(true);
    expect(ehRecusaOuSemInteresse("sem interesse")).toBe(true);
    expect(ehRecusaOuSemInteresse("não quero comprar")).toBe(true);
    expect(ehRecusaOuSemInteresse("não quero nada, obrigado")).toBe(true);
    expect(ehRecusaOuSemInteresse("agora não tenho interesse")).toBe(true);
    expect(ehRecusaOuSemInteresse("favor não insistir")).toBe(true);
  });

  it("NÃO confunde solicitação comercial legítima com recusa", () => {
    expect(ehRecusaOuSemInteresse("quanto custa o produto?")).toBe(false);
    expect(ehRecusaOuSemInteresse("quero comprar")).toBe(false);
    // Se o cliente diz que não quer um produto mas pergunta de outro, a intenção comercial prevalece
    expect(
      ehRecusaOuSemInteresse("não tenho interesse no plano anual, quanto custa o mensal?"),
    ).toBe(false);
  });
});

describe("2. Classificador: Mensagens puramente sociais", () => {
  it("identifica saudações isoladas sem solicitação comercial", () => {
    expect(ehMensagemSocial("bom dia")).toBe(true);
    expect(ehMensagemSocial("boa tarde, tudo bem?")).toBe(true);
    expect(ehMensagemSocial("olá")).toBe(true);
    expect(ehMensagemSocial("oi!")).toBe(true);
  });

  it("identifica agradecimentos e confirmações vazias", () => {
    expect(ehMensagemSocial("obrigado")).toBe(true);
    expect(ehMensagemSocial("muito obrigado!")).toBe(true);
    expect(ehMensagemSocial("valeu")).toBe(true);
    expect(ehMensagemSocial("ok obrigado")).toBe(true);
    expect(ehMensagemSocial("de nada")).toBe(true);
    expect(ehMensagemSocial("beleza")).toBe(true);
    expect(ehMensagemSocial("show")).toBe(true);
  });

  it("identifica despedidas e expressões religiosas", () => {
    expect(ehMensagemSocial("tchau")).toBe(true);
    expect(ehMensagemSocial("até mais")).toBe(true);
    expect(ehMensagemSocial("amém")).toBe(true);
    expect(ehMensagemSocial("fica com Deus")).toBe(true);
    expect(ehMensagemSocial("Deus te abençoe")).toBe(true);
  });

  it("identifica correntes", () => {
    expect(ehMensagemSocial("repasse essa mensagem para 10 contatos")).toBe(true);
    expect(ehMensagemSocial("não quebre a corrente de oração")).toBe(true);
  });

  it("identifica figurinhas e emojis isolados", () => {
    expect(ehMensagemSocial("👍")).toBe(true);
    expect(ehMensagemSocial("🙏 ☕")).toBe(true);
    expect(ehMensagemSocial("", { tipoMensagem: "sticker" })).toBe(true);
  });

  it("NÃO classifica mensagens com contexto comercial como puramente sociais", () => {
    expect(ehMensagemSocial("bom dia, qual o valor do curso?")).toBe(false);
    expect(ehMensagemSocial("olá, vocês vendem no atacado?")).toBe(false);
    expect(ehMensagemSocial("boa tarde, como funciona a entrega?")).toBe(false);
  });
});

describe("3. Classificador: Solicitações comerciais inequívocas", () => {
  it("reconhece perguntas de preço, catálogo e compra", () => {
    expect(ehSolicitacaoComercialInequivoca("quanto custa?")).toBe(true);
    expect(ehSolicitacaoComercialInequivoca("qual o valor?")).toBe(true);
    expect(ehSolicitacaoComercialInequivoca("vocês têm catálogo?")).toBe(true);
    expect(ehSolicitacaoComercialInequivoca("quero fazer um orçamento")).toBe(true);
    expect(ehSolicitacaoComercialInequivoca("mudei de ideia, quero comprar")).toBe(true);
    expect(ehSolicitacaoComercialInequivoca("ainda tem vaga?")).toBe(true);
    expect(ehSolicitacaoComercialInequivoca("aceita pix?")).toBe(true);
  });

  it("rejeita conversas sociais sem pergunta comercial", () => {
    expect(ehSolicitacaoComercialInequivoca("bom dia")).toBe(false);
    expect(ehSolicitacaoComercialInequivoca("obrigado")).toBe(false);
    expect(ehSolicitacaoComercialInequivoca("amém")).toBe(false);
  });
});

describe("4. Suporte e clientes ativos (Item 9)", () => {
  it("identifica relatos de suporte e pós-venda", () => {
    expect(ehMensagemDeSuporteOuProblema("não consigo acessar minha conta")).toBe(true);
    expect(ehMensagemDeSuporteOuProblema("meu pedido atrasou")).toBe(true);
    expect(ehMensagemDeSuporteOuProblema("o produto veio com defeito")).toBe(true);
    expect(ehMensagemDeSuporteOuProblema("preciso de suporte")).toBe(true);
  });
});

describe("5. Imagens e processamento multimodal (Item 8)", () => {
  it("rejeita imagens sociais sem contexto comercial para evitar custo multimodal", () => {
    // Imagem sem legenda ou com legenda social (ex: bom-dia)
    expect(imagemTemContextoComercial("")).toBe(false);
    expect(imagemTemContextoComercial("bom dia ☕")).toBe(false);
    expect(imagemTemContextoComercial("Ótima semana a todos!")).toBe(false);
  });

  it("aceita imagens acompanhadas de texto comercial ou suporte", () => {
    expect(imagemTemContextoComercial("quanto custa esse modelo da foto?")).toBe(true);
    expect(imagemTemContextoComercial("segue o comprovante de pagamento")).toBe(true);
    expect(imagemTemContextoComercial("olha o defeito que apareceu")).toBe(true);
  });

  it("aceita imagem sem texto se o atendente solicitou anexo no histórico recente", () => {
    const historico = [
      { direction: "outbound" as const, body: "Por favor, me envie a foto do produto ou comprovante" },
    ];
    expect(imagemTemContextoComercial("", historico)).toBe(true);
  });
});

describe("6. Jornada completa do caso Antônio (Avaliação da Barreira)", () => {
  it("Turno 1: Mensagem inicial comercial -> processar_comercial", () => {
    const decisao = avaliarRelevanciaDoTurno({
      mensagemAtual: "Olá, gostaria de saber mais sobre o treinamento de vendas",
      inboundsPendentes: ["Olá, gostaria de saber mais sobre o treinamento de vendas"],
      historicoMensagens: [],
    });

    expect(decisao.acao).toBe("processar_comercial");
    expect(decisao.permitirMultimodal).toBe(true);
  });

  it("Turno 2: Antônio informa que entrou por engano e não tem interesse -> encerrar_por_recusa com despedida única", () => {
    const decisao = avaliarRelevanciaDoTurno({
      mensagemAtual: "desculpe, entrei por engano, não tenho interesse",
      inboundsPendentes: ["desculpe, entrei por engano, não tenho interesse"],
      estadoRelevancia: null,
      historicoMensagens: [
        { direction: "inbound", body: "Olá" },
        { direction: "outbound", body: "Olá Antônio! Sou o Xavier..." },
      ],
    });

    expect(decisao.acao).toBe("encerrar_por_recusa");
    if (decisao.acao === "encerrar_por_recusa") {
      expect(decisao.deveEnviarDespedida).toBe(true);
      expect(decisao.permitirMultimodal).toBe(false);
    }
  });

  it("Turno 3: Antônio repete que não tem interesse após despedida enviada -> suprimir (sem despedida repetida)", () => {
    const decisao = avaliarRelevanciaDoTurno({
      mensagemAtual: "já disse que não quero nada",
      inboundsPendentes: ["já disse que não quero nada"],
      estadoRelevancia: {
        estado: "encerrado_sem_interesse",
        despedida_enviada: true,
      },
      conversaStatus: "closed",
      historicoMensagens: [
        { direction: "inbound", body: "entrei por engano" },
        { direction: "outbound", body: "Entendido! Agradecemos o retorno..." },
      ],
    });

    expect(decisao.acao).toBe("suprimir");
    if (decisao.acao === "suprimir") {
      expect(decisao.motivo).toBe("despedida_repetida");
      expect(decisao.permitirMultimodal).toBe(false);
    }
  });

  it("Turno 4: Antônio envia imagem de bom-dia no dia seguinte -> suprimir (zero LLM, zero visão, zero WhatsApp)", () => {
    const decisao = avaliarRelevanciaDoTurno({
      mensagemAtual: "bom dia!",
      inboundsPendentes: ["bom dia!"],
      tipoMensagem: "image",
      temMidia: true,
      estadoRelevancia: {
        estado: "encerrado_sem_interesse",
        despedida_enviada: true,
      },
      conversaStatus: "closed",
      historicoMensagens: [
        { direction: "inbound", body: "entrei por engano" },
        { direction: "outbound", body: "Entendido! Agradecemos o retorno..." },
      ],
    });

    expect(decisao.acao).toBe("suprimir");
    if (decisao.acao === "suprimir") {
      expect(decisao.motivo).toBe("social_apos_encerramento");
      expect(decisao.permitirMultimodal).toBe(false);
    }
  });

  it("Turno 5: Antônio envia figurinha ou obrigado -> suprimir", () => {
    const decisao = avaliarRelevanciaDoTurno({
      mensagemAtual: "obrigado",
      inboundsPendentes: ["obrigado"],
      estadoRelevancia: {
        estado: "encerrado_sem_interesse",
        despedida_enviada: true,
      },
      conversaStatus: "closed",
      historicoMensagens: [
        { direction: "inbound", body: "entrei por engano" },
        { direction: "outbound", body: "Entendido! Agradecemos o retorno..." },
      ],
    });

    expect(decisao.acao).toBe("suprimir");
  });

  it("Turno 6: Antônio reabre com solicitação comercial explícita -> reabrir_comercial", () => {
    const decisao = avaliarRelevanciaDoTurno({
      mensagemAtual: "Olá, pensando bem, quanto custa o treinamento de vocês?",
      inboundsPendentes: ["Olá, pensando bem, quanto custa o treinamento de vocês?"],
      estadoRelevancia: {
        estado: "encerrado_sem_interesse",
        despedida_enviada: true,
      },
      conversaStatus: "closed",
      historicoMensagens: [
        { direction: "inbound", body: "entrei por engano" },
        { direction: "outbound", body: "Entendido! Agradecemos o retorno..." },
      ],
    });

    expect(decisao.acao).toBe("reabrir_comercial");
    expect(decisao.permitirMultimodal).toBe(true);
  });

  it("Turno 7: Mensagem de suporte não é interrompida mesmo após encerramento", () => {
    const decisao = avaliarRelevanciaDoTurno({
      mensagemAtual: "Estou com um problema no meu acesso ao curso",
      inboundsPendentes: ["Estou com um problema no meu acesso ao curso"],
      estadoRelevancia: {
        estado: "encerrado_sem_interesse",
        despedida_enviada: true,
      },
      conversaStatus: "closed",
      historicoMensagens: [],
    });

    expect(decisao.acao).toBe("processar_comercial");
    expect(decisao.motivo).toBe("suporte_ou_cliente_ativo");
  });
});

describe("7. Testes específicos: Gael (Prospecção Ativa)", () => {
  it("Gael recebe resposta humana inicial 'bom dia' sem silenciar", () => {
    const decisao = avaliarRelevanciaDoTurno({
      mensagemAtual: "bom dia!",
      inboundsPendentes: ["bom dia!"],
      contexto: {
        papelAgente: "prospeccao",
        ehProspeccaoAtiva: true,
      },
      historicoMensagens: [
        {
          direction: "outbound",
          body: "Olá João! Sou o Gael da Fluxalvo, vi seu perfil comercial...",
        },
      ],
    });
    expect(decisao.acao).toBe("processar_comercial");
    expect(decisao.motivo).toBe("resposta_humana_prospeccao");
  });

  it("Gael recebe resposta de polidez 'tudo bem, e você?' sem silenciar", () => {
    const decisao = avaliarRelevanciaDoTurno({
      mensagemAtual: "tudo bem, e você?",
      inboundsPendentes: ["tudo bem, e você?"],
      contexto: {
        papelAgente: "prospeccao",
        ehProspeccaoAtiva: true,
      },
      historicoMensagens: [
        { direction: "outbound", body: "Olá João, tudo bem?" },
      ],
    });
    expect(decisao.acao).toBe("processar_comercial");
    expect(decisao.motivo).toBe("resposta_humana_prospeccao");
  });

  it("Gael recebe pergunta de identificação 'quem fala?' e 'do que se trata?'", () => {
    const decisao = avaliarRelevanciaDoTurno({
      mensagemAtual: "Olá, quem fala? Do que se trata?",
      inboundsPendentes: ["Olá, quem fala? Do que se trata?"],
      contexto: {
        papelAgente: "prospeccao",
        ehProspeccaoAtiva: true,
      },
      historicoMensagens: [
        { direction: "outbound", body: "Olá, boa tarde!" },
      ],
    });
    expect(decisao.acao).toBe("processar_comercial");
    expect(decisao.motivo).toBe("resposta_humana_prospeccao");
  });

  it("Gael encerra abordagem educadamente se houver recusa expressa na prospecção", () => {
    const decisao = avaliarRelevanciaDoTurno({
      mensagemAtual: "não tenho interesse, obrigado",
      inboundsPendentes: ["não tenho interesse, obrigado"],
      contexto: {
        papelAgente: "prospeccao",
        ehProspeccaoAtiva: true,
        temVinculoComercial: false,
      },
      historicoMensagens: [
        { direction: "outbound", body: "Olá, gostaria de apresentar nossa solução..." },
      ],
    });
    expect(decisao.acao).toBe("encerrar_por_recusa");
    expect(decisao.motivo).toBe("ausencia_de_interesse");
  });
});

describe("8. Testes específicos: Xavier Comercial (Atendimento Receptivo)", () => {
  it("Xavier Comercial não silencia cumprimento inicial de novo lead ('bom dia')", () => {
    const decisao = avaliarRelevanciaDoTurno({
      mensagemAtual: "Bom dia!",
      inboundsPendentes: ["Bom dia!"],
      contexto: {
        papelAgente: "comercial",
        ehInicioDeAtendimento: true,
      },
      historicoMensagens: [],
    });
    expect(decisao.acao).toBe("processar_comercial");
    expect(decisao.motivo).toBe("cumprimento_inicial_receptivo");
  });

  it("Xavier Comercial processa normalmente perguntas de preço e catálogo", () => {
    const decisao = avaliarRelevanciaDoTurno({
      mensagemAtual: "quanto custa a consultoria?",
      inboundsPendentes: ["quanto custa a consultoria?"],
      contexto: {
        papelAgente: "comercial",
      },
      historicoMensagens: [
        { direction: "inbound", body: "Bom dia" },
        { direction: "outbound", body: "Olá! Como posso ajudar?" },
      ],
    });
    expect(decisao.acao).toBe("processar_comercial");
    expect(decisao.motivo).toBe("solicitacao_comercial");
  });

  it("Xavier Comercial encerra atendimento se lead sem vínculo disser 'foi por engano'", () => {
    const decisao = avaliarRelevanciaDoTurno({
      mensagemAtual: "desculpe foi engano",
      inboundsPendentes: ["desculpe foi engano"],
      contexto: {
        papelAgente: "comercial",
        temVinculoComercial: false,
      },
      historicoMensagens: [
        { direction: "inbound", body: "Oi" },
        { direction: "outbound", body: "Olá! Como posso te ajudar?" },
      ],
    });
    expect(decisao.acao).toBe("encerrar_por_recusa");
  });
});

describe("9. Testes específicos: Xavier Suporte (Pós-venda e Casos)", () => {
  it("Xavier Suporte processa cumprimentos e pedidos de ajuda no suporte", () => {
    const decisao = avaliarRelevanciaDoTurno({
      mensagemAtual: "Bom dia, preciso de ajuda com o sistema",
      inboundsPendentes: ["Bom dia, preciso de ajuda com o sistema"],
      contexto: {
        papelAgente: "suporte",
      },
      possuiCasoAberto: true,
      historicoMensagens: [],
    });
    expect(decisao.acao).toBe("processar_comercial");
    expect(decisao.motivo).toBe("suporte_ou_cliente_ativo");
  });

  it("Xavier Suporte NUNCA encerra por recusa comercial nem move para perda", () => {
    const decisao = avaliarRelevanciaDoTurno({
      mensagemAtual: "não quero comprar nada novo, só quero arrumar meu acesso",
      inboundsPendentes: ["não quero comprar nada novo, só quero arrumar meu acesso"],
      contexto: {
        papelAgente: "suporte",
        temVinculoComercial: true,
      },
      possuiCasoAberto: true,
      historicoMensagens: [
        { direction: "outbound", body: "Olá, seu chamado #123 está aberto..." },
      ],
    });
    expect(decisao.acao).toBe("processar_comercial");
    expect(decisao.motivo).toBe("suporte_ou_cliente_ativo");
  });
});

describe("10. Proteção de Vínculo Comercial e Etapas Avançadas (Item 4)", () => {
  it("Cliente ativo (já comprou) recusando upsell NÃO tem atendimento fechado nem vai para lost", () => {
    const decisao = avaliarRelevanciaDoTurno({
      mensagemAtual: "não quero comprar esse curso extra",
      inboundsPendentes: ["não quero comprar esse curso extra"],
      contexto: {
        papelAgente: "comercial",
        temVinculoComercial: true,
        etapaFunil: "won",
      },
      historicoMensagens: [
        { direction: "outbound", body: "Temos uma oferta especial para nossos alunos..." },
      ],
    });
    expect(decisao.acao).toBe("processar_comercial");
    expect(decisao.motivo).toBe("cliente_ativo_em_atendimento");
  });

  it("Lead em etapa avançada de negociação/proposta NÃO é encerrado automaticamente por objeção de preço", () => {
    const decisao = avaliarRelevanciaDoTurno({
      mensagemAtual: "não tenho interesse nesse valor",
      inboundsPendentes: ["não tenho interesse nesse valor"],
      contexto: {
        papelAgente: "comercial",
        temVinculoComercial: false,
        etapaFunil: "negotiation",
      },
      historicoMensagens: [
        { direction: "outbound", body: "Segue nossa proposta comercial..." },
      ],
    });
    expect(decisao.acao).toBe("processar_comercial");
    expect(decisao.motivo).toBe("negociacao_em_andamento");
  });

  it("Atendimento com operador humano em handoff nunca é encerrado por IA", () => {
    const decisao = avaliarRelevanciaDoTurno({
      mensagemAtual: "não quero",
      inboundsPendentes: ["não quero"],
      leadEmHandoffHumano: true,
      historicoMensagens: [],
    });
    expect(decisao.acao).toBe("processar_comercial");
    expect(decisao.motivo).toBe("suporte_ou_cliente_ativo");
  });
});
