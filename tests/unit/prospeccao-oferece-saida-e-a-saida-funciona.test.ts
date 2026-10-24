import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { comSaida, palavraDeSaida, rodapeDeSaida } from "@/lib/prospecting/rodape-de-saida";
import { ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";

/**
 * A PRIMEIRA MENSAGEM FRIA TEM DE OFERECER UMA SAÍDA — E A SAÍDA TEM DE FUNCIONAR.
 *
 * ## Por que os dois lados, e por que nenhum basta sozinho
 *
 * Só a ida ("a mensagem contém a palavra PARAR") ficaria verde com um rodapé
 * que dissesse "é só me avisar" — simpático, e inútil: a regra de opt-out deste
 * produto é ISOLADA, só reconhece a palavra sozinha ou verbo com objeto de
 * comunicação. A pessoa pediria para sair e continuaria recebendo, que é pior
 * que não ter prometido nada.
 *
 * Só a volta ("PARAR bloqueia") já passava ANTES deste conserto — o detector
 * sempre funcionou. O que faltava era alguém CONTAR à pessoa que ela podia
 * responder isso.
 *
 * ## O que está realmente em jogo
 *
 * Sem saída oferecida, a saída que a pessoa usa é "Denunciar spam". Essa é
 * invisível ao sistema: não gera inbound, `is_blocked` nunca é gravado, o
 * candidato fica `sent` — e o número queimado é o do cliente que instalou o
 * produto, não o nosso.
 */

const RAIZ = path.resolve(__dirname, "../..");

describe("a abordagem fria oferece uma saída", () => {
  it("o rodapé sai em toda mensagem de abordagem, colado ao texto do modelo", () => {
    const corpo = comSaida("Oi! Vi a padaria de vocês no mapa.", "pt-BR");
    expect(corpo).toContain("Oi! Vi a padaria de vocês no mapa.");
    expect(corpo).toContain("Caso prefira não receber novos contatos, basta me avisar.");
  });

  it("não duplica quando o texto já termina com o rodapé", () => {
    // O prompt também fala em transparência; se um dia alguém puser a frase lá,
    // a mensagem não pode sair com ela duas vezes — parece defeito e é a
    // primeira impressão da empresa.
    const uma = comSaida("Bom dia.", "pt-BR");
    expect(comSaida(uma, "pt-BR")).toBe(uma);
  });

  it("segue o idioma da instalação — e não inventa idioma que não existe", () => {
    expect(rodapeDeSaida("es-AR")).toContain("BAJA");
    expect(rodapeDeSaida("en-US")).toContain("STOP");
    // Idioma desconhecido cai no padrão do produto, COM rodapé. Ficar sem é o
    // defeito que este módulo conserta.
    expect(rodapeDeSaida("de-DE")).toContain("Caso prefira não receber novos contatos, basta me avisar.");
    expect(rodapeDeSaida(null)).toContain("Caso prefira não receber novos contatos, basta me avisar.");
  });
});

describe("e a saída oferecida realmente funciona (a volta)", () => {
  it("responder a palavra do rodapé é reconhecido como pedido de saída", () => {
    for (const locale of ["pt-BR", "es-AR", "en-US"]) {
      const palavra = palavraDeSaida(locale);
      expect(
        ehPedidoDeOptOut(palavra),
        `o rodapé de ${locale} promete responder "${palavra}", e o detector tem de reconhecer isso`,
      ).toBe(true);
      // Como a pessoa realmente digita: minúscula, com pontuação, com espaço.
      expect(ehPedidoDeOptOut(palavra.toLowerCase())).toBe(true);
      expect(ehPedidoDeOptOut(` ${palavra.toLowerCase()}.`)).toBe(true);
    }
  });

  it("continua reconhecendo recusas como PARAR, pare, não me contate e equivalentes", () => {
    expect(ehPedidoDeOptOut("PARAR")).toBe(true);
    expect(ehPedidoDeOptOut("pare")).toBe(true);
    expect(ehPedidoDeOptOut("não me contate mais")).toBe(true);
    expect(ehPedidoDeOptOut("nao entre em contato")).toBe(true);
    expect(ehPedidoDeOptOut("não quero receber mais mensagens")).toBe(true);
  });

  it("a promessa é verificada contra o detector em tempo de execução, não por convenção", () => {
    // `palavraDeSaida` consulta `PALAVRAS_DE_OPT_OUT`. Se alguém remover a
    // palavra do detector, isto LANÇA em vez de mandar promessa falsa.
    const fonte = fs.readFileSync(
      path.join(RAIZ, "lib/prospecting/rodape-de-saida.ts"),
      "utf8",
    );
    expect(fonte).toContain("PALAVRAS_DE_OPT_OUT");
    expect(fonte).toMatch(/throw new Error/);
  });
});

describe("o caminho de envio usa o rodapé — e não o texto cru do modelo", () => {
  it("o worker manda `comSaida(...)`, não `generated.texto`", () => {
    // Sem esta asserção, o módulo poderia estar perfeito e desligado: o defeito
    // original era exatamente um caminho de envio que mandava o texto cru.
    const worker = fs.readFileSync(path.join(RAIZ, "lib/prospecting/worker.ts"), "utf8");
    expect(worker).toMatch(/body:\s*primeiraAbordagem\(/);
    expect(
      worker.includes("body: generated.texto"),
      "o envio voltou a mandar o texto do modelo sem a saída",
    ).toBe(false);
  });
});
