import { env } from "@/lib/env";

export interface HeaderReader {
  get(name: string): string | null;
}

export interface ResolveOriginOptions {
  /**
   * Origem pública configurada da instalação (padrão: env.NEXT_PUBLIC_APP_URL).
   */
  configuredOrigin?: string;
  /**
   * Lista explícita de hosts confiáveis aceitos via proxy reverso
   * (além do host da própria origem pública configurada).
   */
  trustedHosts?: readonly string[];
  /**
   * Ambiente de execução (padrão: env.NODE_ENV).
   */
  nodeEnv?: "development" | "test" | "production";
}

const DEFAULT_LOCAL_ORIGIN = "http://localhost:3000";

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

function parseCanonicalOrigin(raw: string | undefined): URL {
  if (raw && typeof raw === "string") {
    try {
      const parsed = new URL(raw.trim());
      if (
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        parsed.username === "" &&
        parsed.password === "" &&
        !parsed.hostname.toLowerCase().endsWith(".invalid")
      ) {
        return parsed;
      }
    } catch {
      // Fallback para origem local segura se o valor configurado for inválido
    }
  }
  return new URL(DEFAULT_LOCAL_ORIGIN);
}

function firstHeaderToken(value: string | null | undefined): string | null {
  if (!value) return null;
  const token = value.split(",")[0]?.trim() ?? "";
  return token.length > 0 ? token : null;
}

/**
 * Valida sintaxe estrita de autoridade host[:port] (RFC 3986),
 * recusando caminhos, fragmentos, credenciais (@), espaços ou caracteres de controle.
 */
function isValidHostAuthority(rawHost: string): boolean {
  if (rawHost.length === 0 || rawHost.length > 255) return false;
  if (/[\s/\\?#@%\u0000-\u001f\u007f]/.test(rawHost)) return false;
  return /^[a-zA-Z0-9.-]+(?::\d{1,5})?$|^\[[a-fA-F0-9:]+\](?::\d{1,5})?$/.test(
    rawHost,
  );
}

/**
 * Resolve a origem canônica do servidor a partir de headers (Request ou next/headers).
 *
 * Política de segurança:
 * 1. A origem pública configurada (`NEXT_PUBLIC_APP_URL`) é a fonte primária de verdade.
 * 2. Cabeçalhos `X-Forwarded-Host` / `Host` só são aceitos dentro de uma política explícita
 *    de confiança:
 *    - Quando coincidem com o host da origem pública configurada ou constam em `trustedHosts`;
 *    - Em desenvolvimento/teste local (quando a origem configurada é loopback e `NODE_ENV !== "production"`),
 *      quando o próprio cabeçalho também aponta para um endereço de loopback (`localhost`, `127.0.0.1`, `[::1]`).
 * 3. Cabeçalhos com hosts externos arbitrários, binds internos de container (`0.0.0.0:3000`,
 *    `internal-host`) ou tentativas de downgrade de protocolo (`X-Forwarded-Proto: http`
 *    sobre origem canônica `https:`) são neutralizados em favor da origem canônica configurada.
 */
export function resolveOriginFromHeaders(
  hdrs?: HeaderReader | null,
  requestUrl?: string,
  options?: ResolveOriginOptions,
): string {
  const canonicalUrl = parseCanonicalOrigin(
    options?.configuredOrigin ?? env.NEXT_PUBLIC_APP_URL,
  );
  const canonicalIsLoopback = isLoopbackHostname(canonicalUrl.hostname);
  const nodeEnv = options?.nodeEnv ?? env.NODE_ENV;

  if (!hdrs) {
    return canonicalUrl.origin;
  }

  const rawForwardedHost = firstHeaderToken(hdrs.get("x-forwarded-host"));
  const rawHost = rawForwardedHost ?? firstHeaderToken(hdrs.get("host"));
  if (!rawHost || !isValidHostAuthority(rawHost)) {
    return canonicalUrl.origin;
  }

  const rawForwardedProto = firstHeaderToken(
    hdrs.get("x-forwarded-proto"),
  )?.toLowerCase();
  if (
    rawForwardedProto &&
    rawForwardedProto !== "https" &&
    rawForwardedProto !== "http"
  ) {
    return canonicalUrl.origin;
  }

  const inferredProto =
    rawForwardedProto ??
    (requestUrl !== undefined
      ? requestUrl.startsWith("https://")
        ? "https"
        : "http"
      : canonicalUrl.protocol === "https:"
        ? "https"
        : "http");

  let candidateUrl: URL;
  try {
    candidateUrl = new URL(`${inferredProto}://${rawHost}`);
  } catch {
    return canonicalUrl.origin;
  }

  if (
    candidateUrl.username !== "" ||
    candidateUrl.password !== "" ||
    candidateUrl.pathname !== "/"
  ) {
    return canonicalUrl.origin;
  }

  const candidateHost = candidateUrl.host.toLowerCase();
  const candidateHostname = candidateUrl.hostname.toLowerCase();
  const canonicalHost = canonicalUrl.host.toLowerCase();
  const canonicalHostname = canonicalUrl.hostname.toLowerCase();

  const trustedHostSet = new Set<string>([canonicalHost]);
  if (canonicalUrl.port === "") {
    trustedHostSet.add(canonicalHostname);
  }
  if (options?.trustedHosts) {
    for (const th of options.trustedHosts) {
      const cleaned = th.trim().toLowerCase();
      if (cleaned) trustedHostSet.add(cleaned);
    }
  }

  const matchesTrustedPolicy =
    trustedHostSet.has(candidateHost) ||
    (candidateUrl.port === "" && trustedHostSet.has(candidateHostname));

  if (matchesTrustedPolicy) {
    // Impede downgrade de HTTPS para HTTP quando a origem canônica é HTTPS
    // ou quando em produção fora de loopback
    const mustUseHttps =
      canonicalUrl.protocol === "https:" ||
      (nodeEnv === "production" && !isLoopbackHostname(candidateHostname));
    const effectiveProto = mustUseHttps
      ? "https:"
      : candidateUrl.protocol;
    return `${effectiveProto}//${candidateUrl.host}`;
  }

  // Exceção estrita de desenvolvimento local: origem configurada é loopback e
  // a requisição local chegou por outro endereço/porta de loopback
  if (
    nodeEnv !== "production" &&
    canonicalIsLoopback &&
    isLoopbackHostname(candidateHostname)
  ) {
    return candidateUrl.origin;
  }

  return canonicalUrl.origin;
}

/**
 * Resolve a origem canônica do servidor para a requisição atual.
 */
export function resolveOrigin(
  req?: Request,
  options?: ResolveOriginOptions,
): string {
  return resolveOriginFromHeaders(req?.headers, req?.url, options);
}
