/**
 * Serviço de regras de negócio e validação do fluxo OAuth 2.1 para MCP.
 */
import {
  findAndConsumeAuthorizationCode,
  findAndRotateRefreshToken,
  findClient,
  registerClient,
  revokeToken,
  createTokens,
} from "./store";
import { verifyPkce } from "./crypto";
import type {
  AuthorizationServerMetadata,
  ProtectedResourceMetadata,
  TokenResponse,
  OauthErrorResponse,
} from "./types";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
};

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
      ...CORS_HEADERS,
      ...headers,
    },
  });
}

export function errorResponse(
  error: OauthErrorResponse["error"],
  description?: string,
  status = 400,
): Response {
  return jsonResponse(
    {
      error,
      ...(description ? { error_description: description } : {}),
    },
    status,
  );
}

/**
 * RFC 8414: Authorization Server Metadata
 */
export function getAuthorizationServerMetadata(origin: string): AuthorizationServerMetadata {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: ["mcp:read", "mcp:write"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
  };
}

/**
 * RFC 9728: Protected Resource Metadata
 */
export function getProtectedResourceMetadata(origin: string): ProtectedResourceMetadata {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: ["mcp:read", "mcp:write"],
    bearer_methods_supported: ["header"],
    resource_documentation: origin,
  };
}

/**
 * RFC 7591: Dynamic Client Registration
 */
export async function handleClientRegistration(payload: unknown): Promise<Response> {
  if (!payload || typeof payload !== "object") {
    return errorResponse("invalid_request", "Corpo da requisição inválido.");
  }

  const p = payload as Record<string, unknown>;
  const redirectUris = p.redirect_uris;

  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return errorResponse("invalid_request", "redirect_uris é obrigatório e deve ser uma lista.");
  }

  for (const uri of redirectUris) {
    if (typeof uri !== "string") {
      return errorResponse("invalid_request", `URI inválida encontrada em redirect_uris: ${String(uri)}`);
    }
    if (uri.includes("#")) {
      return errorResponse("invalid_request", "redirect_uri não pode conter fragmento (#).");
    }
    let parsedUri: URL;
    try {
      parsedUri = new URL(uri);
    } catch {
      return errorResponse("invalid_request", `URI inválida encontrada em redirect_uris: ${uri}`);
    }
    if (parsedUri.username !== "" || parsedUri.password !== "") {
      return errorResponse("invalid_request", `URI inválida encontrada em redirect_uris: ${uri}`);
    }
    const hostname = parsedUri.hostname.toLowerCase();
    const isLoopback =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]";
    const isAllowedScheme =
      parsedUri.protocol === "https:" || (parsedUri.protocol === "http:" && isLoopback);
    if (!isAllowedScheme) {
      return errorResponse("invalid_request", `URI inválida encontrada em redirect_uris: ${uri}`);
    }
  }

  try {
    const client = await registerClient({
      client_name: typeof p.client_name === "string" ? p.client_name : undefined,
      redirect_uris: redirectUris as string[],
      grant_types: Array.isArray(p.grant_types) ? (p.grant_types as string[]) : undefined,
      response_types: Array.isArray(p.response_types) ? (p.response_types as string[]) : undefined,
      token_endpoint_auth_method:
        typeof p.token_endpoint_auth_method === "string" ? p.token_endpoint_auth_method : undefined,
    });

    return jsonResponse(
      {
        client_id: client.client_id,
        ...(client.client_secret ? { client_secret: client.client_secret } : {}),
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        grant_types: client.grant_types,
        response_types: client.response_types,
        token_endpoint_auth_method: client.token_endpoint_auth_method,
        client_id_issued_at: Math.floor(new Date(client.created_at).getTime() / 1000),
      },
      201,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Falha ao registrar cliente.";
    return errorResponse("server_error", msg, 500);
  }
}

/**
 * Endpoint de Token (RFC 6749 / OAuth 2.1 com PKCE)
 */
export async function handleTokenRequest(params: Record<string, string>): Promise<Response> {
  const grantType = params.grant_type;

  if (!grantType) {
    return errorResponse("invalid_request", "Parâmetro grant_type é obrigatório.");
  }

  // 1. Troca de authorization_code
  if (grantType === "authorization_code") {
    const code = params.code;
    const clientId = params.client_id;
    const redirectUri = params.redirect_uri;
    const codeVerifier = params.code_verifier;

    if (!code || !clientId || !redirectUri || !codeVerifier) {
      return errorResponse(
        "invalid_request",
        "Parâmetros code, client_id, redirect_uri e code_verifier são obrigatórios para authorization_code.",
      );
    }

    const authCode = await findAndConsumeAuthorizationCode(code, clientId, redirectUri);
    if (!authCode) {
      return errorResponse("invalid_grant", "Código de autorização inválido, expirado ou já utilizado.");
    }

    // Validação de PKCE S256
    const pkceValid = verifyPkce(codeVerifier, authCode.code_challenge, authCode.code_challenge_method);
    if (!pkceValid) {
      return errorResponse("invalid_grant", "Verificação PKCE S256 falhou.");
    }

    // Validação de resource (RFC 8707)
    if (params.resource && authCode.resource) {
      const normRequested = params.resource.replace(/\/+$/, "");
      const normAuthorized = authCode.resource.replace(/\/+$/, "");
      if (normRequested !== normAuthorized) {
        return errorResponse("invalid_target", "O recurso solicitado não corresponde ao recurso autorizado.");
      }
    }

    try {
      const client = await findClient(clientId);
      const tokens = await createTokens({
        client_id: clientId,
        user_id: authCode.user_id,
        organization_id: authCode.organization_id,
        scopes: authCode.scopes,
        client_name: client?.client_name,
        resource: authCode.resource,
      });

      const responseBody: TokenResponse = {
        access_token: tokens.access_token,
        token_type: "Bearer",
        expires_in: tokens.expires_in,
        refresh_token: tokens.refresh_token,
        scope: authCode.scopes.join(" "),
      };

      return jsonResponse(responseBody);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao emitir tokens.";
      return errorResponse("server_error", msg, 500);
    }
  }

  // 2. Renovação via refresh_token
  if (grantType === "refresh_token") {
    const refreshToken = params.refresh_token;
    const clientId = params.client_id;

    if (!refreshToken || !clientId) {
      return errorResponse("invalid_request", "Parâmetros refresh_token e client_id são obrigatórios.");
    }

    const rotated = await findAndRotateRefreshToken(refreshToken, clientId);
    if (!rotated) {
      return errorResponse("invalid_grant", "Refresh token inválido, expirado ou revogado.");
    }

    const responseBody: TokenResponse = {
      access_token: rotated.access_token,
      token_type: "Bearer",
      expires_in: rotated.expires_in,
      refresh_token: rotated.refresh_token,
      scope: rotated.scopes.join(" "),
    };

    return jsonResponse(responseBody);
  }

  return errorResponse("unsupported_grant_type", `Grant type '${grantType}' não suportado.`);
}

/**
 * Revogação de Tokens (RFC 7009)
 */
export async function handleRevocationRequest(params: Record<string, string>): Promise<Response> {
  const token = params.token;
  const hint = params.token_type_hint;

  if (!token) {
    return errorResponse("invalid_request", "Parâmetro token é obrigatório.");
  }

  await revokeToken(token, hint);
  return jsonResponse({}, 200);
}
