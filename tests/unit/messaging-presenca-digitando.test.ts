/**
 * O "digitando…" atravessa o MESMO caminho de resolução do envio.
 *
 * O transporte (`getWahaClient`/fetch) e a credencial oficial são dublados. Tudo entre a conversa
 * e o adapter é código real: a leitura escopada por `organization_id`, o
 * `resolveSessionRef` (que sabe de que coluna sai o ref de cada provider) e o
 * `resolveRecipient` (que sabe virar contato em endereço). Dublar o meio faria o
 * teste ficar verde com uma segunda maneira, divergente, de descobrir por qual
 * número falar — que é exatamente o defeito que a doutrina de canal proíbe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/channels/meta/credentials", () => ({
  resolveMetaCreds: vi.fn(async () => ({ phoneNumberId: "123456", token: "teste" })),
  metaCredsFromEnv: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const setPresence = vi.fn(async () => undefined);
/** null = transporte não configurado (env ausente), como numa VPS sem WAHA. */
let clienteDoTransporte: { setPresence: typeof setPresence } | null = { setPresence };

vi.mock("@/lib/waha/client", async (original) => ({
  ...(await original<typeof import("@/lib/waha/client")>()),
  getWahaClient: () => clienteDoTransporte,
}));

import { sinalizarDigitando } from "@/lib/messaging/presenca";

interface LinhaDeConversa {
  is_group: boolean;
  group_chat_id: string | null;
  contacts: {
    phone_number: string | null;
    wa_identity: string | null;
    wa_lid: string | null;
  } | null;
  channel_sessions: {
    provider: string;
    waha_session_name: string | null;
    meta_phone_number_id: string | null;
    zernio_account_id: string | null;
    status: string;
  } | null;
}

let linha: LinhaDeConversa | null = null;
/** Todo par (coluna, valor) que a leitura filtrou — a prova do escopo de tenant. */
let filtros: Array<[string, unknown]> = [];
let filtrosMensagens: Array<[string, unknown]> = [];
let mensagem: { external_id: string } | null = { external_id: "wamid.recebida" };
let erroMensagem: { code: string } | null = null;
const consultas = vi.fn();
const ordenar = vi.fn();

function supabaseDeTeste(): never {
  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      filtros.push([col, val]);
      return chain;
    },
    maybeSingle: async () => ({ data: linha, error: null }),
  };
  const messages = {
    select: () => messages,
    eq: (col: string, val: unknown) => {
      filtrosMensagens.push([col, val]);
      return messages;
    },
    not: (col: string, op: string, val: unknown) => {
      filtrosMensagens.push([`${col} not ${op}`, val]);
      return messages;
    },
    neq: (col: string, val: unknown) => {
      filtrosMensagens.push([`${col} neq`, val]);
      return messages;
    },
    order: (col: string, options: unknown) => {
      ordenar(col, options);
      return messages;
    },
    limit: (n: number) => {
      expect(n).toBe(1);
      return messages;
    },
    maybeSingle: async () => ({ data: mensagem, error: erroMensagem }),
  };
  return {
    from: (table: string) => {
      consultas(table);
      return table === "messages" ? messages : chain;
    },
  } as never;
}

const CONVERSA_NORMAL: LinhaDeConversa = {
  is_group: false,
  group_chat_id: null,
  contacts: { phone_number: "+5527999998888", wa_identity: null, wa_lid: null },
  channel_sessions: {
    provider: "waha",
    waha_session_name: "sessao-do-sitio",
    meta_phone_number_id: null,
    zernio_account_id: null,
    status: "WORKING",
  },
};

beforeEach(() => {
  setPresence.mockClear();
  clienteDoTransporte = { setPresence };
  linha = structuredClone(CONVERSA_NORMAL);
  filtros = [];
  filtrosMensagens = [];
  mensagem = { external_id: "wamid.recebida" };
  erroMensagem = null;
  consultas.mockClear();
  ordenar.mockClear();
});

afterEach(() => vi.unstubAllGlobals());

describe("sinalizarDigitando", () => {
  it("acende 'digitando' no número da sessão e no endereço do contato", async () => {
    await sinalizarDigitando(supabaseDeTeste(), {
      organizationId: "org-1",
      conversationId: "conv-1",
    });

    expect(setPresence).toHaveBeenCalledTimes(1);
    expect(setPresence).toHaveBeenCalledWith("sessao-do-sitio", "5527999998888@c.us", "typing");
    expect(consultas.mock.calls).toEqual([["conversations"]]);
  });

  it("a leitura da conversa é escopada por organization_id", async () => {
    // Multi-tenancy (CLAUDE.md): quem usa service role filtra a organização à
    // mão, de fonte confiável. Sem esta linha, um id de conversa vazado
    // acenderia "digitando" no número de outro tenant.
    await sinalizarDigitando(supabaseDeTeste(), {
      organizationId: "org-1",
      conversationId: "conv-1",
    });
    expect(filtros).toContainEqual(["organization_id", "org-1"]);
    expect(filtros).toContainEqual(["id", "conv-1"]);
  });

  it("sessão que não está WORKING não recebe chamada de presença", async () => {
    linha!.channel_sessions!.status = "SCAN_QR_CODE";
    await sinalizarDigitando(supabaseDeTeste(), {
      organizationId: "org-1",
      conversationId: "conv-1",
    });
    expect(setPresence).not.toHaveBeenCalled();
  });

  it("conversa inexistente não chama o canal e não lança", async () => {
    linha = null;
    await expect(
      sinalizarDigitando(supabaseDeTeste(), { organizationId: "org-1", conversationId: "sumiu" }),
    ).resolves.toBeUndefined();
    expect(setPresence).not.toHaveBeenCalled();
  });

  it("contato sem endereço possível não vira chamada ao canal", async () => {
    linha!.contacts = { phone_number: null, wa_identity: null, wa_lid: null };
    await sinalizarDigitando(supabaseDeTeste(), {
      organizationId: "org-1",
      conversationId: "conv-1",
    });
    expect(setPresence).not.toHaveBeenCalled();
  });

  it("transporte não configurado (VPS sem o container) é no-op, não erro", async () => {
    clienteDoTransporte = null;
    await expect(
      sinalizarDigitando(supabaseDeTeste(), { organizationId: "org-1", conversationId: "conv-1" }),
    ).resolves.toBeUndefined();
  });

  it("canal que não sabe sinalizar presença é no-op", async () => {
    // O adapter do canal intermediado não implementa `signalTyping`. Quem chama
    // testa a presença do método — nunca pergunta QUAL provider é.
    linha!.channel_sessions = {
      provider: "zernio",
      waha_session_name: null,
      meta_phone_number_id: "123456",
      zernio_account_id: null,
      status: "WORKING",
    };
    await expect(
      sinalizarDigitando(supabaseDeTeste(), { organizationId: "org-1", conversationId: "conv-1" }),
    ).resolves.toBeUndefined();
    expect(setPresence).not.toHaveBeenCalled();
  });
});

describe("presença com referência de mensagem recebida", () => {
  const http = vi.fn();
  beforeEach(() => {
    linha!.channel_sessions!.provider = "meta_cloud";
    linha!.channel_sessions!.meta_phone_number_id = "123456";
    http.mockReset().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    vi.stubGlobal("fetch", http);
  });

  it("leva o ID recebido ao transporte e limita a busca à conversa e ao tenant", async () => {
    await sinalizarDigitando(supabaseDeTeste(), {
      organizationId: "org-1",
      conversationId: "conv-1",
    });
    expect(filtrosMensagens).toEqual([
      ["organization_id", "org-1"],
      ["conversation_id", "conv-1"],
      ["direction", "inbound"],
      ["external_id not is", null],
      ["external_id neq", ""],
    ]);
    expect(ordenar.mock.calls).toEqual([
      ["sent_at", { ascending: false, nullsFirst: false }],
      ["created_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
    expect(http).toHaveBeenCalledTimes(1);
    expect(JSON.parse(http.mock.calls[0]![1].body).message_id).toBe("wamid.recebida");
    expect(setPresence).not.toHaveBeenCalled();
  });

  it.each([null, { external_id: "" }, { external_id: "  " }])(
    "sem ID utilizável (%j) não chama o transporte",
    async (valor) => {
      mensagem = valor;
      await sinalizarDigitando(supabaseDeTeste(), {
        organizationId: "org-1",
        conversationId: "conv-1",
      });
      expect(http).not.toHaveBeenCalled();
    },
  );

  it("falha de consulta sobe ao chamador sem sinalizar outra mensagem", async () => {
    erroMensagem = { code: "XX000" };
    await expect(
      sinalizarDigitando(supabaseDeTeste(), { organizationId: "org-1", conversationId: "conv-1" }),
    ).rejects.toThrow("typing_message_lookup_failed");
    expect(http).not.toHaveBeenCalled();
  });
});
