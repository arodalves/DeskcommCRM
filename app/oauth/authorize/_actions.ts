"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { loadAuthUser } from "@/lib/auth/server";
import {
  resolveOriginFromHeaders,
  type HeaderReader,
} from "@/lib/mcp/oauth/origin";
import {
  createAuthorizationCode,
  findClient,
  isRedirectUriAllowed,
} from "@/lib/mcp/oauth/store";

export async function submitConsentAction(formData: FormData): Promise<void> {
  const authUser = await loadAuthUser();
  if (!authUser) {
    const returnParams = new URLSearchParams();
    const clientId = formData.get("client_id") as string;
    const redirectUri = formData.get("redirect_uri") as string;
    const state = formData.get("state") as string;
    const codeChallenge = formData.get("code_challenge") as string;
    const codeChallengeMethod = (formData.get("code_challenge_method") as string) || "S256";
    const rawScope = (formData.get("scope") as string) || "mcp:read";
    const rawResource = (formData.get("resource") as string)?.trim() || null;

    if (clientId) returnParams.set("client_id", clientId);
    if (redirectUri) returnParams.set("redirect_uri", redirectUri);
    returnParams.set("response_type", "code");
    if (rawScope) returnParams.set("scope", rawScope);
    if (state) returnParams.set("state", state);
    if (codeChallenge) returnParams.set("code_challenge", codeChallenge);
    if (codeChallengeMethod) returnParams.set("code_challenge_method", codeChallengeMethod);
    if (rawResource) returnParams.set("resource", rawResource);

    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${returnParams.toString()}`)}`);
  }

  const clientId = formData.get("client_id") as string;
  const redirectUri = formData.get("redirect_uri") as string;
  const state = formData.get("state") as string;
  const codeChallenge = formData.get("code_challenge") as string;
  const codeChallengeMethod = (formData.get("code_challenge_method") as string) || "S256";
  const organizationId = formData.get("organization_id") as string;
  const rawScope = (formData.get("scope") as string) || "mcp:read";
  const rawResource = (formData.get("resource") as string)?.trim() || null;
  const decision = formData.get("decision") as string;

  // 1. Validação obrigatória de client_id e redirect_uri ANTES de qualquer redirect (OAuth 2.1 §4.1.2.1)
  if (!clientId || !redirectUri) {
    throw new Error("client_id ou redirect_uri ausente.");
  }

  const client = await findClient(clientId);
  if (!client || !isRedirectUriAllowed(client, redirectUri)) {
    throw new Error("Cliente ou redirect_uri não autorizado.");
  }

  let reqHeaders: HeaderReader | null = null;
  try {
    reqHeaders = await headers();
  } catch {
    reqHeaders = null;
  }
  const origin = resolveOriginFromHeaders(reqHeaders);
  const canonicalResource = `${origin}/mcp`;
  const normalizedRawResource = rawResource ? rawResource.replace(/\/+$/, "") : null;

  if (normalizedRawResource && normalizedRawResource !== canonicalResource) {
    const errorUrl = new URL(redirectUri);
    errorUrl.searchParams.set("error", "invalid_target");
    errorUrl.searchParams.set("error_description", "Recurso não suportado por este servidor MCP.");
    errorUrl.searchParams.set("iss", origin);
    if (state) errorUrl.searchParams.set("state", state);
    redirect(errorUrl.toString());
  }

  const targetResource = canonicalResource;

  // Se o usuário recusou a autorização
  if (decision !== "allow") {
    const errorUrl = new URL(redirectUri);
    errorUrl.searchParams.set("error", "access_denied");
    errorUrl.searchParams.set("error_description", "Consentimento recusado pelo usuário.");
    errorUrl.searchParams.set("iss", origin);
    if (state) errorUrl.searchParams.set("state", state);
    redirect(errorUrl.toString());
  }

  if (!codeChallenge || codeChallengeMethod !== "S256") {
    const errorUrl = new URL(redirectUri);
    errorUrl.searchParams.set("error", "invalid_request");
    errorUrl.searchParams.set("error_description", "PKCE S256 (code_challenge) é obrigatório.");
    errorUrl.searchParams.set("iss", origin);
    if (state) errorUrl.searchParams.set("state", state);
    redirect(errorUrl.toString());
  }

  // Validação da organização selecionada: usuário DEVE ser membro ativo
  const userOrg = authUser.organizations.find(
    (m) => m.organization_id === organizationId,
  );

  const targetOrgId = userOrg?.organization_id || authUser.organizations[0]?.organization_id;
  if (!targetOrgId) {
    throw new Error("O usuário não possui nenhuma organização vinculada.");
  }

  // Filtragem estrita dos escopos permitidos (mcp:read por padrão)
  const allowedScopes = ["mcp:read", "mcp:write"];
  const requestedScopes = rawScope.split(/[\s,]+/).filter((s) => allowedScopes.includes(s));
  const scopes = requestedScopes.length > 0 ? requestedScopes : ["mcp:read"];

  const code = await createAuthorizationCode({
    client_id: clientId,
    user_id: authUser.id,
    organization_id: targetOrgId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    scopes,
    resource: targetResource,
  });

  const successUrl = new URL(redirectUri);
  successUrl.searchParams.set("code", code);
  successUrl.searchParams.set("iss", origin);
  if (state) successUrl.searchParams.set("state", state);

  redirect(successUrl.toString());
}
