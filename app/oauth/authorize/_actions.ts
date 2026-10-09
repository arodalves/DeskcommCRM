"use server";

import { redirect } from "next/navigation";
import { loadAuthUser } from "@/lib/auth/server";
import {
  createAuthorizationCode,
  findClient,
  isRedirectUriAllowed,
} from "@/lib/mcp/oauth/store";

export async function submitConsentAction(formData: FormData): Promise<void> {
  const authUser = await loadAuthUser();
  if (!authUser) {
    redirect("/login");
  }

  const clientId = formData.get("client_id") as string;
  const redirectUri = formData.get("redirect_uri") as string;
  const state = formData.get("state") as string;
  const codeChallenge = formData.get("code_challenge") as string;
  const codeChallengeMethod = (formData.get("code_challenge_method") as string) || "S256";
  const organizationId = formData.get("organization_id") as string;
  const rawScope = (formData.get("scope") as string) || "mcp:read";
  const rawResource = (formData.get("resource") as string)?.trim() || null;
  const canonicalResource = "https://crm.fluxalvo.com/mcp";
  const targetResource = rawResource || canonicalResource;

  if (rawResource && !rawResource.endsWith("/mcp")) {
    const errorUrl = new URL(redirectUri);
    errorUrl.searchParams.set("error", "invalid_target");
    errorUrl.searchParams.set("error_description", "Recurso não suportado por este servidor MCP.");
    if (state) errorUrl.searchParams.set("state", state);
    redirect(errorUrl.toString());
  }

  const decision = formData.get("decision") as string;

  if (!redirectUri) {
    throw new Error("redirect_uri ausente.");
  }

  // Se o usuário recusou a autorização
  if (decision !== "allow") {
    const errorUrl = new URL(redirectUri);
    errorUrl.searchParams.set("error", "access_denied");
    errorUrl.searchParams.set("error_description", "Consentimento recusado pelo usuário.");
    if (state) errorUrl.searchParams.set("state", state);
    redirect(errorUrl.toString());
  }

  if (!clientId || !codeChallenge) {
    const errorUrl = new URL(redirectUri);
    errorUrl.searchParams.set("error", "invalid_request");
    errorUrl.searchParams.set("error_description", "client_id ou code_challenge ausente.");
    if (state) errorUrl.searchParams.set("state", state);
    redirect(errorUrl.toString());
  }

  const client = await findClient(clientId);
  if (!client || !isRedirectUriAllowed(client, redirectUri)) {
    const errorUrl = new URL(redirectUri);
    errorUrl.searchParams.set("error", "invalid_client");
    errorUrl.searchParams.set("error_description", "Cliente ou redirect_uri não autorizado.");
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
  if (state) successUrl.searchParams.set("state", state);

  redirect(successUrl.toString());
}
