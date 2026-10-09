/**
 * Camada de persistência para OAuth 2.1 no DeskcommCRM.
 *
 * Utiliza o cliente de administração (service_role) para operações seguras
 * em `oauth_clients`, `oauth_authorization_codes`, `oauth_refresh_tokens` e `api_tokens`.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { buildOauthAccessToken, randomCode, randomToken, sha256Hex } from "./crypto";
import type {
  OauthAuthorizationCode,
  OauthClient,
  OauthRefreshToken,
} from "./types";

const TRUSTED_CHATGPT_REDIRECT_PREFIXES = [
  "https://chatgpt.com/",
  "https://chat.openai.com/",
];

/**
 * Busca cliente registrado por client_id.
 * Inclui fallback para clientes conhecidos do ChatGPT / CIMD.
 */
export async function findClient(clientId: string): Promise<OauthClient | null> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("oauth_clients")
    .select("*")
    .eq("client_id", clientId)
    .maybeSingle();

  if (!error && data) {
    return {
      id: data.id,
      client_id: data.client_id,
      client_secret: data.client_secret,
      client_name: data.client_name,
      redirect_uris: data.redirect_uris ?? [],
      grant_types: data.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: data.response_types ?? ["code"],
      token_endpoint_auth_method: data.token_endpoint_auth_method ?? "none",
      created_at: data.created_at,
    };
  }

  // Fallback seguro para ChatGPT caso client_id seja a URL do ChatGPT ou "chatgpt"
  const isChatGptClient =
    clientId === "chatgpt" ||
    clientId.startsWith("https://chatgpt.com") ||
    clientId.startsWith("https://chat.openai.com");

  if (isChatGptClient) {
    return {
      id: "chatgpt-default",
      client_id: clientId,
      client_secret: null,
      client_name: "ChatGPT",
      redirect_uris: [
        "https://chatgpt.com/api/v1/auth/mcp/callback",
        "https://chat.openai.com/api/v1/auth/mcp/callback",
        "https://chatgpt.com/oauth/callback",
      ],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      created_at: new Date().toISOString(),
    };
  }

  return null;
}

/**
 * Valida se um redirect_uri pertence ao cliente registrado por correspondência exata.
 */
export function isRedirectUriAllowed(
  client: OauthClient,
  redirectUri: string,
): boolean {
  return client.redirect_uris.includes(redirectUri);
}

/**
 * Registra dinamicamente um cliente OAuth (RFC 7591 Dynamic Client Registration).
 */
export async function registerClient(params: {
  client_name?: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
}): Promise<OauthClient> {
  const supabase = createAdminClient();
  const clientId = randomToken("dsk_client", 16);
  const isConfidential = params.token_endpoint_auth_method === "client_secret_post" ||
    params.token_endpoint_auth_method === "client_secret_basic";
  const clientSecret = isConfidential ? randomToken("dsk_sec", 32) : null;
  const clientName = params.client_name?.trim() || "ChatGPT";

  const newClient = {
    client_id: clientId,
    client_secret: clientSecret,
    client_name: clientName,
    redirect_uris: params.redirect_uris,
    grant_types: params.grant_types ?? ["authorization_code", "refresh_token"],
    response_types: params.response_types ?? ["code"],
    token_endpoint_auth_method: params.token_endpoint_auth_method ?? "none",
  };

  const { data, error } = await supabase
    .from("oauth_clients")
    .insert(newClient)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Falha ao registrar cliente OAuth: ${error?.message || "erro desconhecido"}`);
  }

  return {
    id: data.id,
    client_id: data.client_id,
    client_secret: data.client_secret,
    client_name: data.client_name,
    redirect_uris: data.redirect_uris,
    grant_types: data.grant_types,
    response_types: data.response_types,
    token_endpoint_auth_method: data.token_endpoint_auth_method,
    created_at: data.created_at,
  };
}

/**
 * Cria código de autorização temporário (5 minutos de validade) com PKCE S256.
 */
export async function createAuthorizationCode(params: {
  client_id: string;
  user_id: string;
  organization_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scopes: string[];
  resource?: string | null;
}): Promise<string> {
  const supabase = createAdminClient();
  const rawCode = randomCode(32);
  const codeHash = sha256Hex(rawCode);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const { error } = await supabase.from("oauth_authorization_codes").insert({
    code_hash: codeHash,
    client_id: params.client_id,
    user_id: params.user_id,
    organization_id: params.organization_id,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
    code_challenge_method: params.code_challenge_method,
    scopes: params.scopes,
    resource: params.resource ?? null,
    expires_at: expiresAt,
  });

  if (error) {
    throw new Error(`Falha ao gerar código de autorização: ${error.message}`);
  }

  return rawCode;
}

/**
 * Busca e consome o código de autorização (uso único).
 */
export async function findAndConsumeAuthorizationCode(
  rawCode: string,
  clientId: string,
  redirectUri: string,
): Promise<OauthAuthorizationCode | null> {
  const supabase = createAdminClient();
  const codeHash = sha256Hex(rawCode);

  const { data, error } = await supabase
    .from("oauth_authorization_codes")
    .select("*")
    .eq("code_hash", codeHash)
    .maybeSingle();

  if (error || !data) return null;

  // Código já utilizado?
  if (data.used_at !== null) return null;

  // Código expirado?
  if (new Date(data.expires_at) < new Date()) return null;

  // Validação de client_id e redirect_uri correspondentes
  if (data.client_id !== clientId || data.redirect_uri !== redirectUri) {
    return null;
  }

  // Marca como utilizado imediatamente (single-use)
  await supabase
    .from("oauth_authorization_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("id", data.id);

  return {
    id: data.id,
    code_hash: data.code_hash,
    client_id: data.client_id,
    user_id: data.user_id,
    organization_id: data.organization_id,
    redirect_uri: data.redirect_uri,
    code_challenge: data.code_challenge,
    code_challenge_method: data.code_challenge_method,
    scopes: data.scopes ?? ["mcp:read"],
    resource: data.resource,
    expires_at: data.expires_at,
    used_at: new Date().toISOString(),
  };
}

/**
 * Cria par de tokens (Access Token de 1h + Refresh Token de 30d).
 */
export async function createTokens(params: {
  client_id: string;
  user_id: string;
  organization_id: string;
  scopes: string[];
  client_name?: string;
  resource?: string | null;
}): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const supabase = createAdminClient();

  const tokenScopes = [...params.scopes];
  if (params.resource) {
    const canonicalRes = params.resource.replace(/\/+$/, "");
    if (!tokenScopes.some((s) => s.startsWith("resource:"))) {
      tokenScopes.push(`resource:${canonicalRes}`);
    }
  }

  const { token: accessToken, prefix: tokenPrefix } = buildOauthAccessToken();
  const accessTokenHash = sha256Hex(accessToken);
  const hashLiteral = `\\x${accessTokenHash}`;
  const accessExpiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

  // 1. Grava o access token na tabela padrão api_tokens com prefixo único
  const { data: apiTokenRow, error: apiTokenError } = await supabase
    .from("api_tokens")
    .insert({
      name: `OAuth: ${params.client_name || params.client_id.slice(0, 16)}`,
      prefix: tokenPrefix,
      token_hash: hashLiteral,
      scopes: tokenScopes,
      organization_id: params.organization_id,
      created_by: params.user_id,
      expires_at: accessExpiresAt,
    })
    .select("id")
    .single();

  if (apiTokenError || !apiTokenRow) {
    throw new Error(`Falha ao emitir token de acesso: ${apiTokenError?.message || "erro de banco"}`);
  }

  // 2. Grava o refresh token na tabela oauth_refresh_tokens
  const refreshToken = randomToken("dsk_ort", 32);
  const refreshTokenHash = sha256Hex(refreshToken);
  const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

  const { error: refreshError } = await supabase
    .from("oauth_refresh_tokens")
    .insert({
      token_hash: refreshTokenHash,
      api_token_id: apiTokenRow.id,
      client_id: params.client_id,
      user_id: params.user_id,
      organization_id: params.organization_id,
      scopes: tokenScopes,
      expires_at: refreshExpiresAt,
      revoked_at: null,
    });

  if (refreshError) {
    throw new Error(`Falha ao emitir refresh token: ${refreshError.message}`);
  }

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3600,
  };
}

/**
 * Valida e rotaciona o Refresh Token.
 */
export async function findAndRotateRefreshToken(
  rawRefreshToken: string,
  clientId: string,
): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scopes: string[];
} | null> {
  const supabase = createAdminClient();
  const tokenHash = sha256Hex(rawRefreshToken);

  const { data, error } = await supabase
    .from("oauth_refresh_tokens")
    .select("*")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error || !data) return null;

  if (data.revoked_at) return null;
  if (new Date(data.expires_at) < new Date()) return null;
  if (data.client_id !== clientId) return null;

  // Verifica se o usuário ainda pertence à organização
  const { data: member } = await supabase
    .from("user_organizations")
    .select("role")
    .eq("user_id", data.user_id)
    .eq("organization_id", data.organization_id)
    .maybeSingle();

  if (!member) {
    // Revoga o token pois o usuário não é mais membro
    await supabase
      .from("oauth_refresh_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", data.id);
    return null;
  }

  // 1. Emite novo par PRIMEIRO (garante que se falhar, o token atual não é invalidado)
  const client = await findClient(data.client_id);
  const newTokens = await createTokens({
    client_id: data.client_id,
    user_id: data.user_id,
    organization_id: data.organization_id,
    scopes: data.scopes ?? ["mcp:read"],
    client_name: client?.client_name,
  });

  // 2. ROTAÇÃO: revoga o refresh token anterior e seu access token vinculado
  const now = new Date().toISOString();
  await supabase
    .from("oauth_refresh_tokens")
    .update({ revoked_at: now })
    .eq("id", data.id);

  if (data.api_token_id) {
    await supabase
      .from("api_tokens")
      .update({ revoked_at: now })
      .eq("id", data.api_token_id);
  }

  return {
    ...newTokens,
    scopes: data.scopes ?? ["mcp:read"],
  };
}

/**
 * Revoga um token (RFC 7009).
 */
export async function revokeToken(
  token: string,
  hint?: string,
): Promise<boolean> {
  const supabase = createAdminClient();
  const hash = sha256Hex(token);
  const now = new Date().toISOString();

  if (hint === "access_token" || token.startsWith("dsk_oat_")) {
    const hashLiteral = `\\x${hash}`;
    const { data: at } = await supabase
      .from("api_tokens")
      .select("id")
      .eq("token_hash", hashLiteral)
      .maybeSingle();

    if (at) {
      await supabase.from("api_tokens").update({ revoked_at: now }).eq("id", at.id);
      await supabase.from("oauth_refresh_tokens").update({ revoked_at: now }).eq("api_token_id", at.id);
      return true;
    }
  }

  if (hint === "refresh_token" || token.startsWith("dsk_ort_")) {
    const { data: rt } = await supabase
      .from("oauth_refresh_tokens")
      .select("id, api_token_id")
      .eq("token_hash", hash)
      .maybeSingle();

    if (rt) {
      await supabase.from("oauth_refresh_tokens").update({ revoked_at: now }).eq("id", rt.id);
      if (rt.api_token_id) {
        await supabase.from("api_tokens").update({ revoked_at: now }).eq("id", rt.api_token_id);
      }
      return true;
    }
  }

  // Fallback: tenta ambas as tabelas
  const hashLiteral = `\\x${hash}`;
  await supabase.from("api_tokens").update({ revoked_at: now }).eq("token_hash", hashLiteral);
  await supabase.from("oauth_refresh_tokens").update({ revoked_at: now }).eq("token_hash", hash);

  return true;
}
