import { redirect } from "next/navigation";
import { loadAuthUser } from "@/lib/auth/server";
import { findClient, isRedirectUriAllowed } from "@/lib/mcp/oauth/store";
import { submitConsentAction } from "./_actions";

export const dynamic = "force-dynamic";

interface AuthorizePageProps {
  searchParams: Promise<{
    client_id?: string;
    redirect_uri?: string;
    response_type?: string;
    scope?: string;
    state?: string;
    code_challenge?: string;
    code_challenge_method?: string;
    resource?: string;
  }>;
}

export default async function AuthorizePage({ searchParams }: AuthorizePageProps) {
  const params = await searchParams;
  const {
    client_id,
    redirect_uri,
    response_type,
    scope = "mcp:read",
    state,
    code_challenge,
    code_challenge_method = "S256",
    resource,
  } = params;

  // 1. Validação básica de parâmetros obrigatórios do protocolo
  if (!client_id || !redirect_uri) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
        <div className="w-full max-w-md rounded-xl border border-red-200 bg-white p-6 shadow-sm">
          <h1 className="text-xl font-bold text-red-600">Requisição OAuth Inválida</h1>
          <p className="mt-2 text-sm text-slate-600">
            Os parâmetros obrigatórios <code>client_id</code> ou <code>redirect_uri</code> não foram fornecidos.
          </p>
        </div>
      </div>
    );
  }

  // 2. Validação do cliente e da URI de retorno
  const client = await findClient(client_id);
  if (!client || !isRedirectUriAllowed(client, redirect_uri)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
        <div className="w-full max-w-md rounded-xl border border-red-200 bg-white p-6 shadow-sm">
          <h1 className="text-xl font-bold text-red-600">Cliente Não Autorizado</h1>
          <p className="mt-2 text-sm text-slate-600">
            A aplicação solicitante ({client_id}) não está registrada ou a URL de redirecionamento não é permitida.
          </p>
        </div>
      </div>
    );
  }

  // 3. Validação do tipo de resposta e PKCE (mandatório em OAuth 2.1)
  if (response_type !== "code" || !code_challenge) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
        <div className="w-full max-w-md rounded-xl border border-red-200 bg-white p-6 shadow-sm">
          <h1 className="text-xl font-bold text-red-600">Parâmetros Incompletos</h1>
          <p className="mt-2 text-sm text-slate-600">
            OAuth 2.1 exige <code>response_type=code</code> e uso obrigatório de PKCE S256 (<code>code_challenge</code>).
          </p>
        </div>
      </div>
    );
  }

  // 4. Verificação de autenticação do usuário
  const authUser = await loadAuthUser();
  if (!authUser) {
    const returnParams = new URLSearchParams();
    if (client_id) returnParams.set("client_id", client_id);
    if (redirect_uri) returnParams.set("redirect_uri", redirect_uri);
    if (response_type) returnParams.set("response_type", response_type);
    if (scope) returnParams.set("scope", scope);
    if (state) returnParams.set("state", state);
    if (code_challenge) returnParams.set("code_challenge", code_challenge);
    if (code_challenge_method) returnParams.set("code_challenge_method", code_challenge_method);
    if (resource) returnParams.set("resource", resource);

    redirect(`/login?return_to=${encodeURIComponent(`/oauth/authorize?${returnParams.toString()}`)}`);
  }

  if (!authUser.organizations || authUser.organizations.length === 0) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
        <div className="w-full max-w-md rounded-xl border border-amber-200 bg-white p-6 shadow-sm">
          <h1 className="text-xl font-bold text-amber-700">Sem Organização Vinculada</h1>
          <p className="mt-2 text-sm text-slate-600">
            Sua conta de usuário ({authUser.email}) não possui nenhuma organização vinculada no CRM para autorizar conexões externas.
          </p>
        </div>
      </div>
    );
  }

  const requestedScopes = scope.split(/[\s,]+/);
  const wantsWrite = requestedScopes.includes("mcp:write");
  const clientDisplayName = client.client_name || "ChatGPT";

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4 font-sans text-slate-900">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-8 shadow-lg">
        {/* Cabeçalho */}
        <div className="border-b border-slate-100 pb-5 text-center">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-600 text-xl font-bold text-white shadow-sm">
            CRM
          </div>
          <h1 className="mt-4 text-2xl font-bold text-slate-900">
            Autorizar Conexão MCP
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            A aplicação <strong className="text-slate-800">{clientDisplayName}</strong> solicita acesso ao seu CRM.
          </p>
        </div>

        {/* Informações da Conta */}
        <div className="my-6 rounded-xl border border-slate-100 bg-slate-50 p-4 text-sm">
          <div className="flex justify-between py-1">
            <span className="text-slate-500">Usuário autenticado:</span>
            <span className="font-medium text-slate-800">{authUser.email}</span>
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-slate-500">Organização:</span>
            <span className="font-semibold text-emerald-700">
              {authUser.organizations[0]?.organization_name || "Organização Principal"}
            </span>
          </div>
        </div>

        {/* Permissões Requisitadas */}
        <div className="mb-6 space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Permissões Solicitadas
          </h2>

          <div className="flex items-start gap-3 rounded-lg border border-slate-100 p-3 bg-white">
            <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700">
              ✓
            </div>
            <div>
              <p className="text-sm font-medium text-slate-800">
                Acesso de Leitura (mcp:read)
              </p>
              <p className="text-xs text-slate-500">
                Permite consultar leads, contatos, pipelines, etapas do funil e status de automação.
              </p>
            </div>
          </div>

          {wantsWrite && (
            <div className="flex items-start gap-3 rounded-lg border border-slate-100 p-3 bg-white">
              <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-700">
                ✓
              </div>
              <div>
                <p className="text-sm font-medium text-slate-800">
                  Acesso de Escrita (mcp:write)
                </p>
                <p className="text-xs text-slate-500">
                  Permite cadastrar ou atualizar contatos e leads conforme suas permissões de usuário.
                </p>
              </div>
            </div>
          )}

          {/* Garantias de Segurança */}
          <div className="rounded-lg border border-emerald-100 bg-emerald-50/50 p-3 text-xs text-emerald-900">
            <p className="font-semibold text-emerald-800">Garantias de Segurança:</p>
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-emerald-700">
              <li>O agente de automação Xavier e fluxos de atendimento continuam protegidos.</li>
              <li>A conexão atua com o seu perfil de permissões sem escalonamento.</li>
              <li>Você pode revogar este acesso a qualquer momento nas configurações.</li>
            </ul>
          </div>
        </div>

        {/* Formulário de Consentimento */}
        <form action={submitConsentAction} className="space-y-3">
          <input type="hidden" name="client_id" value={client_id} />
          <input type="hidden" name="redirect_uri" value={redirect_uri} />
          <input type="hidden" name="state" value={state || ""} />
          <input type="hidden" name="code_challenge" value={code_challenge} />
          <input type="hidden" name="code_challenge_method" value={code_challenge_method} />
          <input type="hidden" name="scope" value={scope} />
          <input type="hidden" name="resource" value={resource || ""} />

          {/* Seletor de organização caso o usuário pertença a múltiplas */}
          {authUser.organizations.length > 1 ? (
            <div className="mb-4">
              <label className="mb-1 block text-xs font-medium text-slate-600">
                Selecione a Organização para conectar:
              </label>
              <select
                name="organization_id"
                className="w-full rounded-lg border border-slate-300 bg-white p-2.5 text-sm text-slate-800 focus:border-emerald-500 focus:outline-none"
              >
                {authUser.organizations.map((m) => (
                  <option key={m.organization_id} value={m.organization_id}>
                    {m.organization_name} ({m.role})
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <input
              type="hidden"
              name="organization_id"
              value={authUser.organizations[0]?.organization_id || ""}
            />
          )}


          <div className="flex gap-3">
            <button
              type="submit"
              name="decision"
              value="deny"
              className="flex-1 rounded-xl border border-slate-200 bg-white py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              name="decision"
              value="allow"
              className="flex-1 rounded-xl bg-emerald-600 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2"
            >
              Autorizar Acesso
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
