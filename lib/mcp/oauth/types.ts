/**
 * Tipos e contratos do Servidor de Autorização OAuth 2.1 para MCP.
 *
 * Em conformidade com RFC 8414 (Server Metadata), RFC 7591 (DCR),
 * RFC 9728 (Protected Resource Metadata), RFC 7009 (Revocation) e PKCE S256.
 */

export interface OauthClient {
  id: string;
  client_id: string;
  client_secret: string | null;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  created_at: string;
}

export interface OauthAuthorizationCode {
  id: string;
  code_hash: string;
  client_id: string;
  user_id: string;
  organization_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scopes: string[];
  resource: string | null;
  expires_at: string;
  used_at: string | null;
}

export interface OauthRefreshToken {
  id: string;
  token_hash: string;
  api_token_id: string;
  client_id: string;
  user_id: string;
  organization_id: string;
  scopes: string[];
  expires_at: string;
  revoked_at: string | null;
  rotated_to_id: string | null;
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported: string[];
  response_types_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
  authorization_response_iss_parameter_supported?: boolean;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_documentation?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface OauthErrorResponse {
  error:
    | "invalid_request"
    | "invalid_client"
    | "invalid_grant"
    | "unauthorized_client"
    | "unsupported_grant_type"
    | "invalid_scope"
    | "invalid_target"
    | "server_error";
  error_description?: string;
}
