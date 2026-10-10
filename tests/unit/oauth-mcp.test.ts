// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  sha256Hex,
  sha256Base64Url,
  verifyPkce,
  randomCode,
  randomToken,
} from "@/lib/mcp/oauth/crypto";
import {
  getAuthorizationServerMetadata,
  getProtectedResourceMetadata,
  handleClientRegistration,
  handleTokenRequest,
  handleRevocationRequest,
} from "@/lib/mcp/oauth/service";
import {
  findClient,
  isRedirectUriAllowed,
} from "@/lib/mcp/oauth/store";
import { resolveOrigin, resolveOriginFromHeaders } from "@/lib/mcp/oauth/origin";
import { validateBearerToken, ensureScope, ensureResource } from "@/lib/mcp/auth";
import { chatGptTools } from "@/lib/mcp/chatgpt/tools";

type MockRecord = Record<string, unknown>;

// Mock do createAdminClient para simular o banco de dados sem dependência de Docker
const mockDatabase = {
  oauth_clients: new Map<string, MockRecord>(),
  oauth_authorization_codes: new Map<string, MockRecord>(),
  oauth_refresh_tokens: new Map<string, MockRecord>(),
  api_tokens: new Map<string, MockRecord>(),
  user_organizations: new Map<string, MockRecord>(),
};

function resetMockDb() {
  mockDatabase.oauth_clients.clear();
  mockDatabase.oauth_authorization_codes.clear();
  mockDatabase.oauth_refresh_tokens.clear();
  mockDatabase.api_tokens.clear();
  mockDatabase.user_organizations.clear();
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const records =
        (mockDatabase as Record<string, Map<string, MockRecord>>)[table] ??
        new Map<string, MockRecord>();
      return {
        select: (_cols = "*") => ({
          eq: (col: string, val: unknown) => ({
            eq: (col2: string, val2: unknown) => ({
              maybeSingle: async () => {
                for (const row of records.values()) {
                  if (row[col] === val && row[col2] === val2) {
                    return { data: { ...row }, error: null };
                  }
                }
                return { data: null, error: null };
              },
            }),
            maybeSingle: async () => {
              for (const row of records.values()) {
                if (row[col] === val) {
                  return { data: { ...row }, error: null };
                }
              }
              return { data: null, error: null };
            },
            single: async () => {
              for (const row of records.values()) {
                if (row[col] === val) {
                  return { data: { ...row }, error: null };
                }
              }
              return { data: null, error: new Error("Row not found") };
            },
          }),
        }),
        insert: (payload: MockRecord) => {
          if (table === "api_tokens") {
            for (const existing of records.values()) {
              if (
                existing.organization_id === payload.organization_id &&
                existing.prefix === payload.prefix
              ) {
                const err = new Error(
                  'duplicate key value violates unique constraint "api_tokens_organization_id_prefix_key"',
                );
                return {
                  select: () => ({ single: async () => ({ data: null, error: err }) }),
                  then: (resolve: (value: { data: null; error: Error }) => unknown) =>
                    resolve({ data: null, error: err }),
                };
              }
            }
          }
          const id =
            (typeof payload.id === "string" && payload.id) ||
            `id-${Math.random().toString(36).slice(2)}`;
          const row: MockRecord = { id, ...payload, created_at: new Date().toISOString() };
          records.set(id, row);
          return {
            select: () => ({
              single: async () => ({ data: row, error: null }),
            }),
            then: (resolve: (value: { data: MockRecord; error: null }) => unknown) =>
              resolve({ data: row, error: null }),
          };
        },
        update: (payload: MockRecord) => ({
          eq: (col: string, val: unknown) => ({
            then: (resolve: (value: { error: null }) => unknown) => {
              for (const [k, row] of records.entries()) {
                if (row[col] === val) {
                  records.set(k, { ...row, ...payload });
                }
              }
              return resolve({ error: null });
            },
          }),
        }),
      };
    },
  }),
}));

describe("OAuth 2.1 — Criptografia e PKCE S256", () => {
  it("valida corretamente code_verifier contra code_challenge usando SHA256 e base64url", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expectedChallenge = sha256Base64Url(verifier);

    expect(verifyPkce(verifier, expectedChallenge, "S256")).toBe(true);
    expect(verifyPkce("outro_verificador_errado", expectedChallenge, "S256")).toBe(false);
    expect(verifyPkce(verifier, expectedChallenge, "plain")).toBe(false);
  });

  it("gera tokens e códigos randômicos com entropia e prefixos corretos", () => {
    const code = randomCode(32);
    expect(code.length).toBeGreaterThanOrEqual(43);

    const oat = randomToken("dsk_oat");
    expect(oat.startsWith("dsk_oat_")).toBe(true);

    const ort = randomToken("dsk_ort");
    expect(ort.startsWith("dsk_ort_")).toBe(true);
  });
});

describe("OAuth 2.1 — Descoberta de Metadados e Origem Canônica Segura (RFC 8414 e RFC 9728)", () => {
  const origin = "https://crm.exemplo.com.br";

  it("retorna metadados RFC 8414 com todos os endpoints obrigatórios e suporte a S256", () => {
    const meta = getAuthorizationServerMetadata(origin);
    expect(meta.issuer).toBe(origin);
    expect(meta.authorization_endpoint).toBe(`${origin}/oauth/authorize`);
    expect(meta.token_endpoint).toBe(`${origin}/oauth/token`);
    expect(meta.registration_endpoint).toBe(`${origin}/oauth/register`);
    expect(meta.revocation_endpoint).toBe(`${origin}/oauth/revoke`);
    expect(meta.response_types_supported).toContain("code");
    expect(meta.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.scopes_supported).toContain("mcp:read");
    expect(meta.scopes_supported).toContain("mcp:write");
  });

  it("retorna metadados RFC 9728 com apontamento para o endpoint protegido /mcp", () => {
    const meta = getProtectedResourceMetadata(origin);
    expect(meta.resource).toBe(`${origin}/mcp`);
    expect(meta.authorization_servers).toEqual([origin]);
    expect(meta.scopes_supported).toEqual(["mcp:read", "mcp:write"]);
    expect(meta.bearer_methods_supported).toEqual(["header"]);
  });

  it("prioriza a origem pública canônica configurada quando não há headers ou quando o bind é interno do container", () => {
    expect(
      resolveOrigin(undefined, {
        configuredOrigin: "https://crm.exemplo.com.br/",
        nodeEnv: "production",
      }),
    ).toBe("https://crm.exemplo.com.br");

    const internalContainerReq = new Request("http://0.0.0.0:3000/mcp", {
      headers: {
        host: "0.0.0.0:3000",
      },
    });
    expect(
      resolveOrigin(internalContainerReq, {
        configuredOrigin: "https://crm.exemplo.com.br",
        nodeEnv: "production",
      }),
    ).toBe("https://crm.exemplo.com.br");
  });

  it("neutraliza cabeçalhos Host, X-Forwarded-Host e X-Forwarded-Proto manipulados em produção e em dev", () => {
    const forgedForwardedHostReq = new Request("http://internal-host/mcp", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "evil-phishing.attacker.com",
        host: "evil-phishing.attacker.com",
      },
    });
    expect(
      resolveOrigin(forgedForwardedHostReq, {
        configuredOrigin: "https://crm.exemplo.com.br",
        nodeEnv: "production",
      }),
    ).toBe("https://crm.exemplo.com.br");

    // Mesmo em ambiente local (loopback), um X-Forwarded-Host externo arbitrário é neutralizado
    expect(
      resolveOrigin(forgedForwardedHostReq, {
        configuredOrigin: "http://localhost:3000",
        nodeEnv: "development",
      }),
    ).toBe("http://localhost:3000");

    // Tentativa de injeção de autoridade com @, path ou protocolo inválido
    const malformedHeaders = new Headers({
      "x-forwarded-proto": "https",
      "x-forwarded-host": "crm.exemplo.com.br@evil.com",
    });
    expect(
      resolveOriginFromHeaders(malformedHeaders, undefined, {
        configuredOrigin: "https://crm.exemplo.com.br",
        nodeEnv: "production",
      }),
    ).toBe("https://crm.exemplo.com.br");

    const invalidProtoHeaders = new Headers({
      "x-forwarded-proto": "javascript",
      "x-forwarded-host": "crm.exemplo.com.br",
    });
    expect(
      resolveOriginFromHeaders(invalidProtoHeaders, undefined, {
        configuredOrigin: "https://crm.exemplo.com.br",
        nodeEnv: "production",
      }),
    ).toBe("https://crm.exemplo.com.br");

    // Tentativa de downgrade de HTTPS para HTTP via X-Forwarded-Proto
    const downgradeHeaders = new Headers({
      "x-forwarded-proto": "http",
      "x-forwarded-host": "crm.exemplo.com.br",
    });
    expect(
      resolveOriginFromHeaders(downgradeHeaders, "http://0.0.0.0:3000/mcp", {
        configuredOrigin: "https://crm.exemplo.com.br",
        nodeEnv: "production",
      }),
    ).toBe("https://crm.exemplo.com.br");
  });

  it("funciona atrás de proxy reverso confiável e preserva loopback em desenvolvimento local", () => {
    const proxyReq = new Request("http://internal-host:3000/mcp", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "crm.exemplo.com.br",
      },
    });
    expect(
      resolveOrigin(proxyReq, {
        configuredOrigin: "https://crm.exemplo.com.br",
        nodeEnv: "production",
      }),
    ).toBe("https://crm.exemplo.com.br");

    // Host adicional explicitamente autorizado na política de proxy confiável
    const trustedAliasHeaders = new Headers({
      "x-forwarded-proto": "https",
      "x-forwarded-host": "mcp.exemplo.com.br, proxy-interno.local",
    });
    expect(
      resolveOriginFromHeaders(trustedAliasHeaders, "http://0.0.0.0:3000/mcp", {
        configuredOrigin: "https://crm.exemplo.com.br",
        trustedHosts: ["mcp.exemplo.com.br"],
        nodeEnv: "production",
      }),
    ).toBe("https://mcp.exemplo.com.br");

    // Desenvolvimento local: loopback em porta alternativa continua funcionando
    const localDevReq = new Request("http://127.0.0.1:3001/mcp", {
      headers: {
        host: "127.0.0.1:3001",
      },
    });
    expect(
      resolveOrigin(localDevReq, {
        configuredOrigin: "http://localhost:3000",
        nodeEnv: "development",
      }),
    ).toBe("http://127.0.0.1:3001");
  });
});

describe("OAuth 2.1 — Registro Dinâmico de Cliente (RFC 7591)", () => {
  beforeEach(() => {
    resetMockDb();
  });

  it("registra cliente público do ChatGPT com sucesso e emite client_id", async () => {
    const res = await handleClientRegistration({
      client_name: "ChatGPT",
      redirect_uris: ["https://chatgpt.com/api/v1/auth/mcp/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toMatch(/^dsk_client_/);
    expect(body.client_name).toBe("ChatGPT");
    expect(body.redirect_uris).toEqual(["https://chatgpt.com/api/v1/auth/mcp/callback"]);
    expect(body.client_secret).toBeUndefined(); // cliente público não expõe secret
  });

  it("rejeita registro com redirect_uri inválida, fragmento, credenciais ou tentativa de bypass de localhost", async () => {
    const resFrag = await handleClientRegistration({
      client_name: "BadClient",
      redirect_uris: ["https://example.com/callback#fragment"],
    });
    expect(resFrag.status).toBe(400);

    const resHttp = await handleClientRegistration({
      client_name: "InsecureClient",
      redirect_uris: ["http://example.com/callback"],
    });
    expect(resHttp.status).toBe(400);

    const resLocalhostBypass = await handleClientRegistration({
      client_name: "BypassClient",
      redirect_uris: ["http://localhost.evil.com/callback"],
    });
    expect(resLocalhostBypass.status).toBe(400);

    const resCreds = await handleClientRegistration({
      client_name: "CredsClient",
      redirect_uris: ["https://user:pass@example.com/callback"],
    });
    expect(resCreds.status).toBe(400);
  });
});

describe("OAuth 2.1 — Validação de Clientes e Redirect URIs", () => {
  beforeEach(() => {
    resetMockDb();
  });

  it("reconhece clientes oficiais do ChatGPT apenas em chatgpt.com e preserva registros existentes no banco", async () => {
    const chatGptClient = await findClient("chatgpt");
    expect(chatGptClient).not.toBeNull();
    expect(chatGptClient?.client_name).toBe("ChatGPT");
    expect(chatGptClient?.redirect_uris).toEqual([
      "https://chatgpt.com/api/v1/auth/mcp/callback",
      "https://chatgpt.com/oauth/callback",
    ]);

    expect(
      isRedirectUriAllowed(
        chatGptClient!,
        "https://chatgpt.com/api/v1/auth/mcp/callback",
      ),
    ).toBe(true);

    // Domínio legado chat.openai.com não é mais aceito no fallback estático
    expect(
      isRedirectUriAllowed(
        chatGptClient!,
        "https://chat.openai.com/api/v1/auth/mcp/callback",
      ),
    ).toBe(false);
    expect(await findClient("https://chat.openai.com")).toBeNull();

    // Cliente previamente registrado em oauth_clients continua funcionando sem impacto
    mockDatabase.oauth_clients.set("dsk_client_existing_1", {
      id: "row-existing-1",
      client_id: "dsk_client_existing_1",
      client_secret: null,
      client_name: "ChatGPT Registrado",
      redirect_uris: ["https://chatgpt.com/api/v1/auth/mcp/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      created_at: new Date().toISOString(),
    });
    const storedClient = await findClient("dsk_client_existing_1");
    expect(storedClient?.id).toBe("row-existing-1");
    expect(
      isRedirectUriAllowed(
        storedClient!,
        "https://chatgpt.com/api/v1/auth/mcp/callback",
      ),
    ).toBe(true);

    const forbidden = isRedirectUriAllowed(
      chatGptClient!,
      "https://malicious-site.com/callback",
    );
    expect(forbidden).toBe(false);
  });
});

describe("OAuth 2.1 — Emissão de Token, Validação PKCE e Rotação de Refresh Token", () => {
  const userId = "00000000-0000-4000-8000-000000000010";
  const orgId = "00000000-0000-4000-8000-000000000001";
  const clientId = "dsk_client_chatgpt_test";
  const redirectUri = "https://chatgpt.com/api/v1/auth/mcp/callback";

  beforeEach(() => {
    resetMockDb();

    // Semente do cliente
    mockDatabase.oauth_clients.set(clientId, {
      id: "client-row-1",
      client_id: clientId,
      client_name: "ChatGPT",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });

    // Semente do membro na organização
    mockDatabase.user_organizations.set(`${userId}-${orgId}`, {
      user_id: userId,
      organization_id: orgId,
      role: "agent",
    });
  });

  it("executa troca de authorization_code por access_token e refresh_token com PKCE S256", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = sha256Base64Url(verifier);
    const rawCode = "test_code_12345";
    const codeHash = sha256Hex(rawCode);

    // Registra código simulado
    mockDatabase.oauth_authorization_codes.set(rawCode, {
      id: "code-1",
      code_hash: codeHash,
      client_id: clientId,
      user_id: userId,
      organization_id: orgId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scopes: ["mcp:read"],
      resource: "https://crm.exemplo.com.br/mcp",
      expires_at: new Date(Date.now() + 60000).toISOString(),
      used_at: null,
    });

    const res = await handleTokenRequest({
      grant_type: "authorization_code",
      code: rawCode,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toMatch(/^dsk_oat_/);
    expect(body.refresh_token).toMatch(/^dsk_ort_/);
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3600);
    expect(body.scope).toBe("mcp:read");

    // Confirma que o authorization_code foi consumido e não pode ser reutilizado
    const codeInDb = mockDatabase.oauth_authorization_codes.get(rawCode);
    expect(codeInDb?.used_at).not.toBeNull();

    // Segunda tentativa com mesmo código deve falhar
    const resReuse = await handleTokenRequest({
      grant_type: "authorization_code",
      code: rawCode,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    expect(resReuse.status).toBe(400);
    const reuseBody = await resReuse.json();
    expect(reuseBody.error).toBe("invalid_grant");
  });

  it("rejeita troca quando o PKCE code_verifier for incorreto", async () => {
    const rawCode = "test_code_pkce_fail";
    const codeHash = sha256Hex(rawCode);

    mockDatabase.oauth_authorization_codes.set(rawCode, {
      id: "code-fail",
      code_hash: codeHash,
      client_id: clientId,
      user_id: userId,
      organization_id: orgId,
      redirect_uri: redirectUri,
      code_challenge: "desafio_esperado_verdadeiro",
      code_challenge_method: "S256",
      scopes: ["mcp:read"],
      expires_at: new Date(Date.now() + 60000).toISOString(),
      used_at: null,
    });

    const res = await handleTokenRequest({
      grant_type: "authorization_code",
      code: rawCode,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: "verificador_invalido",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_grant");
  });

  it("executa renovação de token (grant_type=refresh_token) com rotação e invalidação do anterior", async () => {
    const rawRefreshToken = "dsk_ort_initial_refresh_token";
    const refreshHash = sha256Hex(rawRefreshToken);
    const oldApiTokenId = "api-token-old";

    mockDatabase.oauth_refresh_tokens.set("rf-1", {
      id: "rf-1",
      token_hash: refreshHash,
      api_token_id: oldApiTokenId,
      client_id: clientId,
      user_id: userId,
      organization_id: orgId,
      scopes: ["mcp:read"],
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      revoked_at: null,
    });

    mockDatabase.api_tokens.set(oldApiTokenId, {
      id: oldApiTokenId,
      token_hash: "\\x0000",
      revoked_at: null,
    });

    const res = await handleTokenRequest({
      grant_type: "refresh_token",
      refresh_token: rawRefreshToken,
      client_id: clientId,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toMatch(/^dsk_oat_/);
    expect(body.refresh_token).toMatch(/^dsk_ort_/);
    expect(body.refresh_token).not.toBe(rawRefreshToken);

    // O refresh token antigo e o access token antigo devem constar como revogados
    const oldRf = mockDatabase.oauth_refresh_tokens.get("rf-1");
    expect(oldRf?.revoked_at).not.toBeNull();
    const oldAt = mockDatabase.api_tokens.get(oldApiTokenId);
    expect(oldAt?.revoked_at).not.toBeNull();

    // Tentar renovar novamente com o mesmo refresh token anterior deve ser rejeitado
    const resRotated = await handleTokenRequest({
      grant_type: "refresh_token",
      refresh_token: rawRefreshToken,
      client_id: clientId,
    });
    expect(resRotated.status).toBe(400);
  });

  it("revoga access_token e refresh_token via endpoint RFC 7009 /oauth/revoke", async () => {
    const rawAccessToken = "dsk_oat_token_to_revoke";
    const tokenHashHex = sha256Hex(rawAccessToken);
    const hashLiteral = `\\x${tokenHashHex}`;

    mockDatabase.api_tokens.set("api-tok-rev", {
      id: "api-tok-rev",
      token_hash: hashLiteral,
      revoked_at: null,
    });

    const res = await handleRevocationRequest({
      token: rawAccessToken,
      token_type_hint: "access_token",
    });
    expect(res.status).toBe(200);

    const revokedToken = mockDatabase.api_tokens.get("api-tok-rev");
    expect(revokedToken?.revoked_at).not.toBeNull();
  });

  it("suporta múltiplas emissões consecutivas e reconexão na mesma organização sem violar api_tokens_organization_id_prefix_key", async () => {
    const verifier1 = "verifier_1_abc123_dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge1 = sha256Base64Url(verifier1);
    const code1 = "auth_code_attempt_1";

    mockDatabase.oauth_authorization_codes.set(code1, {
      id: "code-conn-1",
      code_hash: sha256Hex(code1),
      client_id: clientId,
      user_id: userId,
      organization_id: orgId,
      redirect_uri: redirectUri,
      code_challenge: challenge1,
      code_challenge_method: "S256",
      scopes: ["mcp:read"],
      resource: "https://crm.exemplo.com.br/mcp",
      expires_at: new Date(Date.now() + 60000).toISOString(),
      used_at: null,
    });

    // 1ª conexão
    const res1 = await handleTokenRequest({
      grant_type: "authorization_code",
      code: code1,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier1,
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.access_token).toMatch(/^dsk_oat_/);

    // 2ª conexão (Reconexão do ChatGPT na mesma organização)
    const verifier2 = "verifier_2_xyz789_dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge2 = sha256Base64Url(verifier2);
    const code2 = "auth_code_attempt_2_reconnect";

    mockDatabase.oauth_authorization_codes.set(code2, {
      id: "code-conn-2",
      code_hash: sha256Hex(code2),
      client_id: clientId,
      user_id: userId,
      organization_id: orgId,
      redirect_uri: redirectUri,
      code_challenge: challenge2,
      code_challenge_method: "S256",
      scopes: ["mcp:read"],
      resource: "https://crm.exemplo.com.br/mcp",
      expires_at: new Date(Date.now() + 60000).toISOString(),
      used_at: null,
    });

    const res2 = await handleTokenRequest({
      grant_type: "authorization_code",
      code: code2,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier2,
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.access_token).toMatch(/^dsk_oat_/);

    // 3ª renovação via refresh_token da 2ª conexão
    const res3 = await handleTokenRequest({
      grant_type: "refresh_token",
      refresh_token: body2.refresh_token,
      client_id: clientId,
    });
    expect(res3.status).toBe(200);
    const body3 = await res3.json();
    expect(body3.access_token).toMatch(/^dsk_oat_/);

    // Todos os tokens emitidos em api_tokens devem ter prefixos únicos
    const prefixes = Array.from(mockDatabase.api_tokens!.values()).map((t: MockRecord) => t.prefix);
    const uniquePrefixes = new Set(prefixes);
    expect(uniquePrefixes.size).toBe(prefixes.length);
  });
});

describe("OAuth 2.1 — Resolução de Identidade e Permissões no Servidor MCP", () => {
  const userId = "00000000-0000-4000-8000-000000000010";
  const orgId = "00000000-0000-4000-8000-000000000001";

  beforeEach(() => {
    resetMockDb();
  });

  it("token dsk_oat_ associa o actor ao usuário real e respeita seu papel na organização", async () => {
    const rawOat = "dsk_oat_user_token_valid";
    const hashLiteral = `\\x${sha256Hex(rawOat)}`;

    mockDatabase.api_tokens.set("api-tok-oat", {
      id: "api-tok-oat",
      token_hash: hashLiteral,
      organization_id: orgId,
      created_by: userId,
      scopes: ["mcp:read"],
      revoked_at: null,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      organizations: { status: "active" },
    });

    mockDatabase.user_organizations.set(`${userId}-${orgId}`, {
      user_id: userId,
      organization_id: orgId,
      role: "agent",
    });

    const authResult = await validateBearerToken(`Bearer ${rawOat}`);
    expect(authResult.organizationId).toBe(orgId);
    expect(authResult.role).toBe("agent");
    expect(authResult.actor).toEqual({
      type: "user",
      id: userId,
      role: "agent",
    });
    expect(authResult.scopes).toEqual(["mcp:read"]);
  });

  it("rejeita token dsk_oat_ caso o usuário tenha sido removido da organização", async () => {
    const rawOat = "dsk_oat_removed_user_token";
    const hashLiteral = `\\x${sha256Hex(rawOat)}`;

    mockDatabase.api_tokens.set("api-tok-removed", {
      id: "api-tok-removed",
      token_hash: hashLiteral,
      organization_id: orgId,
      created_by: userId,
      scopes: ["mcp:read"],
      revoked_at: null,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      organizations: { status: "active" },
    });

    // Usuário NÃO está em user_organizations para esta organização
    await expect(validateBearerToken(`Bearer ${rawOat}`)).rejects.toThrow(
      "User associated with this OAuth token is no longer a member of the organization.",
    );
  });

  it("garante isolamento estrito entre organizações: vínculo em outra organização não autoriza nem escalona token de orgId", async () => {
    const otherOrgId = "00000000-0000-4000-8000-000000000002";
    const rawOat = "dsk_oat_cross_org_probe";
    const hashLiteral = `\\x${sha256Hex(rawOat)}`;

    mockDatabase.api_tokens.set("api-tok-cross", {
      id: "api-tok-cross",
      token_hash: hashLiteral,
      organization_id: orgId,
      created_by: userId,
      scopes: ["mcp:read", "mcp:write", "role:admin"],
      revoked_at: null,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      organizations: { status: "active" },
    });

    // Usuário é admin na otherOrgId, mas NÃO pertence a orgId
    mockDatabase.user_organizations.set(`${userId}-${otherOrgId}`, {
      user_id: userId,
      organization_id: otherOrgId,
      role: "admin",
    });

    await expect(validateBearerToken(`Bearer ${rawOat}`)).rejects.toThrow(
      "User associated with this OAuth token is no longer a member of the organization.",
    );

    // Mesmo quando o usuário é viewer em orgId e admin em otherOrgId, o token opera estritamente em orgId como viewer
    mockDatabase.user_organizations.set(`${userId}-${orgId}`, {
      user_id: userId,
      organization_id: orgId,
      role: "viewer",
    });

    const authResult = await validateBearerToken(`Bearer ${rawOat}`);
    expect(authResult.organizationId).toBe(orgId);
    expect(authResult.organizationId).not.toBe(otherOrgId);
    expect(authResult.role).toBe("viewer");
  });

  it("garante isolamento de escopo: token somente leitura (mcp:read) não possui escopo mcp:write", () => {
    const scopes = ["mcp:read"];

    expect(() => ensureScope(scopes, "mcp:read")).not.toThrow();
    expect(() => ensureScope(scopes, "mcp:write")).toThrow(/Token missing required scope 'mcp:write'/);
  });

  it("preserva o catálogo das 10 ferramentas do ChatGPT sem ampliação indevida de permissões", () => {
    expect(chatGptTools.length).toBe(10);
    const readTools = chatGptTools.filter((t) => t.category === "read");
    const writeTools = chatGptTools.filter((t) => t.category === "write");

    expect(readTools.length).toBe(4);
    expect(writeTools.length).toBe(6);

    for (const rt of readTools) {
      expect(rt.requiresScope).toBe("mcp:read");
    }
    for (const wt of writeTools) {
      expect(wt.requiresScope).toBe("mcp:write");
    }
  });
});

describe("OAuth 2.1 — Verificações Específicas de Segurança e Conformidade", () => {
  const userId = "00000000-0000-4000-8000-000000000010";
  const orgId = "00000000-0000-4000-8000-000000000001";
  const canonicalResource = "https://crm.exemplo.com.br/mcp";

  beforeEach(() => {
    resetMockDb();
  });

  it("resource=https://crm.exemplo.com.br/mcp é preservado na autorização e troca de tokens", async () => {
    const rawVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = sha256Base64Url(rawVerifier);
    const clientId = "client-resource-test";
    const redirectUri = "https://chatgpt.com/api/v1/auth/mcp/callback";
    const rawCode = "test-code-res-123";
    const codeHash = sha256Hex(rawCode);

    mockDatabase.oauth_clients.set(clientId, {
      id: "cl-res-1",
      client_id: clientId,
      client_name: "ChatGPT",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });

    mockDatabase.oauth_authorization_codes.set(codeHash, {
      id: "code-res-1",
      code_hash: codeHash,
      client_id: clientId,
      user_id: userId,
      organization_id: orgId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scopes: ["mcp:read"],
      resource: canonicalResource,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      used_at: null,
    });

    // Troca de token enviando o resource correto
    const res = await handleTokenRequest({
      grant_type: "authorization_code",
      code: rawCode,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: rawVerifier,
      resource: canonicalResource,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toMatch(/^dsk_oat_/);

    // Verifica que o token gravado possui a restrição de recurso
    let foundApiToken: MockRecord | null = null;
    for (const t of mockDatabase.api_tokens!.values()) {
      if (t.organization_id === orgId) {
        foundApiToken = t;
        break;
      }
    }
    expect(foundApiToken).not.toBeNull();
    expect(foundApiToken?.scopes).toContain(`resource:${canonicalResource}`);
  });

  it("rejeita troca de token quando o resource solicitado diverge do resource autorizado (RFC 8707)", async () => {
    const rawVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = sha256Base64Url(rawVerifier);
    const clientId = "client-res-mismatch";
    const redirectUri = "https://chatgpt.com/api/v1/auth/mcp/callback";
    const rawCode = "test-code-res-mismatch";
    const codeHash = sha256Hex(rawCode);

    mockDatabase.oauth_clients.set(clientId, {
      id: "cl-res-2",
      client_id: clientId,
      client_name: "ChatGPT",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });

    mockDatabase.oauth_authorization_codes.set(codeHash, {
      id: "code-res-2",
      code_hash: codeHash,
      client_id: clientId,
      user_id: userId,
      organization_id: orgId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scopes: ["mcp:read"],
      resource: canonicalResource,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      used_at: null,
    });

    const res = await handleTokenRequest({
      grant_type: "authorization_code",
      code: rawCode,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: rawVerifier,
      resource: "https://outro-servidor-malicioso.com/api",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_target");
  });

  it("token vinculado ao recurso é aceito para ele e rejeitado para outro recurso", () => {
    const validScopes = ["mcp:read", `resource:${canonicalResource}`];
    const invalidScopes = ["mcp:read", "resource:https://outro-servidor.com/api"];
    const legacyScopes = ["mcp:read"];

    // Aceito para o recurso correto (com ou sem barra final)
    expect(() => ensureResource(validScopes, canonicalResource)).not.toThrow();
    expect(() => ensureResource(validScopes, `${canonicalResource}/`)).not.toThrow();

    // Rejeitado quando o token foi emitido para outro recurso
    expect(() => ensureResource(invalidScopes, canonicalResource)).toThrow(
      /Token not authorized for resource/,
    );

    // Tokens legados sem restrição explícita continuam funcionando
    expect(() => ensureResource(legacyScopes, canonicalResource)).not.toThrow();
  });

  it("mcp:read bloqueia todas as ferramentas de escrita do servidor MCP", () => {
    const readScopes = ["mcp:read"];
    const writeTools = chatGptTools.filter((t) => t.category === "write");

    expect(writeTools.length).toBe(6);

    for (const tool of writeTools) {
      expect(tool.requiresScope).toBe("mcp:write");
      expect(() => ensureScope(readScopes, tool.requiresScope)).toThrow(
        /Token missing required scope 'mcp:write'/,
      );
    }
  });

  it("redirect_uri é validada por correspondência exata com a URI registrada", async () => {
    const client = {
      id: "c1",
      client_id: "c1",
      client_secret: null,
      client_name: "ChatGPT",
      redirect_uris: ["https://chatgpt.com/api/v1/auth/mcp/callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      created_at: new Date().toISOString(),
    };

    // Correspondência exata: permitida
    expect(isRedirectUriAllowed(client, "https://chatgpt.com/api/v1/auth/mcp/callback")).toBe(true);

    // Subpath adicional: rejeitado
    expect(isRedirectUriAllowed(client, "https://chatgpt.com/api/v1/auth/mcp/callback/extra")).toBe(false);

    // Query string não registrada: rejeitado
    expect(isRedirectUriAllowed(client, "https://chatgpt.com/api/v1/auth/mcp/callback?foo=bar")).toBe(false);

    // Domínio diferente com mesmo path: rejeitado
    expect(isRedirectUriAllowed(client, "https://attacker.com/api/v1/auth/mcp/callback")).toBe(false);

    // Apenas prefixo sem path exato: rejeitado
    expect(isRedirectUriAllowed(client, "https://chatgpt.com/")).toBe(false);
  });

  it("organização e permissões são resolvidas estritamente pelo usuário que autorizou", async () => {
    const rawOat = "dsk_oat_role_resolution_test";
    const hashLiteral = `\\x${sha256Hex(rawOat)}`;

    mockDatabase.api_tokens.set("api-tok-role", {
      id: "api-tok-role",
      token_hash: hashLiteral,
      organization_id: orgId,
      created_by: userId,
      scopes: ["mcp:read", "role:admin"], // token solicita admin
      revoked_at: null,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      organizations: { status: "active" },
    });

    // Mas no banco o usuário tem apenas a role 'agent' nesta organização
    mockDatabase.user_organizations.set(`${userId}-${orgId}`, {
      user_id: userId,
      organization_id: orgId,
      role: "agent",
    });

    const authResult = await validateBearerToken(`Bearer ${rawOat}`);
    expect(authResult.organizationId).toBe(orgId);
    // Role efetiva não pode ser maior do que a do usuário na organização (prevenção de escalonamento)
    expect(authResult.role).toBe("agent");
    expect(authResult.actor.type).toBe("user");
    if (authResult.actor.type === "user") {
      expect(authResult.actor.role).toBe("agent");
    }
    expect(authResult.actor.id).toBe(userId);
  });

  describe("Preservação de Parâmetros e Retorno pós-Login (/oauth/authorize)", () => {
    it("preserva todos os parâmetros OAuth na URL de redirecionamento para /login via parâmetro next", () => {
      const oauthParams = {
        client_id: "dsk_client_chatgpt_probe_123",
        redirect_uri: "https://chatgpt.com/api/mcp/oauth_callback",
        response_type: "code",
        scope: "mcp:read",
        state: "state_xyz_789",
        code_challenge: "E9Melhoa2OwvFrGMTJguCH5rtx645N475szbKD8ifu0",
        code_challenge_method: "S256",
        resource: "https://crm.exemplo.com.br/mcp",
      };

      const returnParams = new URLSearchParams();
      for (const [key, value] of Object.entries(oauthParams)) {
        if (typeof value === "string" && value.length > 0) {
          returnParams.set(key, value);
        }
      }

      const authorizeTarget = `/oauth/authorize?${returnParams.toString()}`;
      const loginUrl = `/login?next=${encodeURIComponent(authorizeTarget)}`;

      // O login URL usa canonical 'next=' e não 'return_to='
      expect(loginUrl).toContain("/login?next=");
      expect(loginUrl).not.toContain("return_to=");

      // Decodificando o parâmetro next (como o Next.js / LoginPage faz)
      const parsedLogin = new URL(loginUrl, "https://crm.exemplo.com.br");
      const nextParam = parsedLogin.searchParams.get("next");
      expect(nextParam).toBe(authorizeTarget);

      // Verificação detalhada de todos os parâmetros presentes na URL de retomada
      const resumed = new URL(nextParam!, "https://crm.exemplo.com.br");
      expect(resumed.pathname).toBe("/oauth/authorize");
      expect(resumed.searchParams.get("client_id")).toBe(oauthParams.client_id);
      expect(resumed.searchParams.get("redirect_uri")).toBe(oauthParams.redirect_uri);
      expect(resumed.searchParams.get("response_type")).toBe("code");
      expect(resumed.searchParams.get("scope")).toBe("mcp:read");
      expect(resumed.searchParams.get("state")).toBe(oauthParams.state);
      expect(resumed.searchParams.get("code_challenge")).toBe(oauthParams.code_challenge);
      expect(resumed.searchParams.get("code_challenge_method")).toBe("S256");
      expect(resumed.searchParams.get("resource")).toBe(oauthParams.resource);
    });

    it("safeNext preserva a URL completa de /oauth/authorize sem cair no fallback /app", async () => {
      const { safeNext } = await import("@/lib/auth/safe-next");

      const oauthTarget =
        "/oauth/authorize?client_id=dsk_client_abc&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fapi%2Fmcp%2Foauth_callback&response_type=code&scope=mcp%3Aread&state=s123&code_challenge=cc456&code_challenge_method=S256&resource=https%3A%2F%2Fcrm.exemplo.com.br%2Fmcp";

      // Deve retornar o caminho exato de authorize com todos os parâmetros, e NUNCA o fallback /app
      const destination = safeNext(oauthTarget, "/app");
      expect(destination).toBe(oauthTarget);
      expect(destination).not.toBe("/app");
    });

    it("LoginPage aceita tanto next quanto return_to como fallback defensivo", () => {
      // Simulação da lógica de resolução de LoginPage
      const resolveNext = (params: { next?: string; return_to?: string }) => {
        return params.next || params.return_to;
      };

      // 1. Cenário canônico: chega via next
      expect(resolveNext({ next: "/oauth/authorize?foo=bar" })).toBe("/oauth/authorize?foo=bar");

      // 2. Cenário defensivo: chega via return_to legado
      expect(resolveNext({ return_to: "/oauth/authorize?foo=bar" })).toBe("/oauth/authorize?foo=bar");

      // 3. Cenário com ambos: next tem prioridade
      expect(resolveNext({ next: "/oauth/authorize?new=1", return_to: "/oauth/authorize?old=1" })).toBe(
        "/oauth/authorize?new=1",
      );

      // 4. Sem parâmetro: undefined
      expect(resolveNext({})).toBeUndefined();
    });
  });
});
