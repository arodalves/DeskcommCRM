/**
 * AS TRÊS TABELAS DO SERVIDOR OAUTH 2.1 MCP SÃO SERVER-SIDE ONLY — E ISSO SE MEDE (migration 0615).
 *
 * ## O que se guarda aqui
 *
 * `oauth_clients` guarda o registro de clientes OAuth (DCR RFC 7591 e
 * pré-registrados, incluindo `client_secret` quando aplicável);
 * `oauth_authorization_codes` guarda o `code_hash` PKCE S256 temporário
 * vinculado a `user_id` e `organization_id`; e `oauth_refresh_tokens` guarda o
 * `token_hash` de longa duração vinculado a `api_tokens(id)`, `user_id` e
 * `organization_id`.
 *
 * Nenhum componente de browser lê ou escreve nessas três tabelas pelo
 * PostgREST: toda operação ocorre exclusivamente nas rotas OAuth do servidor
 * (`/oauth/register`, `/oauth/authorize`, `/oauth/token`) usando o admin
 * client (`service_role`).
 *
 * ## Por que não entram em `TABLES` do `rls-isolation.test.ts`
 *
 * Mesmo desenho de `credencial-de-anuncios-e-server-side.test.ts` e
 * `credencial-de-mapas-e-server-side.test.ts`: RLS ligada, zero policies e
 * `revoke all ... from public, anon, authenticated`. Como `authenticated` não
 * tem privilégio nenhum na tabela, `countAs` em `rls-isolation.test.ts`
 * falharia com `permission denied` em vez de devolver `0` linhas, e a
 * "correção" errada seria abrir policy no PostgREST para tabelas de credencial.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const TABELAS_OAUTH = [
  "oauth_clients",
  "oauth_authorization_codes",
  "oauth_refresh_tokens",
] as const;

const TABELAS_OAUTH_TENANT = ["oauth_authorization_codes", "oauth_refresh_tokens"] as const;

type TabelaOauth = (typeof TABELAS_OAUTH)[number];

const INSERT_PROBE: Record<TabelaOauth, string> = {
  oauth_clients:
    "insert into public.oauth_clients (client_id, client_name, redirect_uris) " +
    "values ('probe-client', 'Probe', array['https://chatgpt.com/connector_platform_oauth_redirect'])",
  oauth_authorization_codes:
    "insert into public.oauth_authorization_codes " +
    "(code_hash, client_id, user_id, organization_id, redirect_uri, code_challenge, expires_at) " +
    "values ('probe-hash', 'probe-client', gen_random_uuid(), gen_random_uuid(), " +
    "'https://chatgpt.com/connector_platform_oauth_redirect', 'probe-challenge', now() + interval '5 minutes')",
  oauth_refresh_tokens:
    "insert into public.oauth_refresh_tokens " +
    "(token_hash, api_token_id, client_id, user_id, organization_id, expires_at) " +
    "values ('probe-rt-hash', gen_random_uuid(), 'probe-client', gen_random_uuid(), " +
    "gen_random_uuid(), now() + interval '30 days')",
};

function erroSob(papel: string, comando: string): string | null {
  try {
    sql(`set role ${papel};\n${comando};\nreset role;`);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

function esperaBarrado(papel: string, comando: string): void {
  const erro = erroSob(papel, comando);
  expect(
    erro,
    `\`${papel}\` executou "${comando}" SEM erro — a tabela está exposta`,
  ).not.toBeNull();
  expect(erro).toContain("permission denied");
}

function privilegiosDe(papel: string, tabela: string): string {
  return sql(`
    select coalesce(string_agg(distinct privilege_type, ',' order by privilege_type), 'NENHUM')
      from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name = '${tabela}'
       and grantee = '${papel}';
  `).trim();
}

describe("a lista do `rls-isolation` e as tabelas OAuth não se sobrepõem", () => {
  it.each(TABELAS_OAUTH)(
    "`%s` NÃO está em `TABLES` do rls-isolation — e não pode entrar",
    (tabela) => {
      const fonte = readFileSync(join(__dirname, "rls-isolation.test.ts"), "utf8");
      const lista = /export const TABLES = \[([\s\S]*?)\] as const;/.exec(fonte);
      expect(
        lista,
        "não achei `export const TABLES` no rls-isolation — a sonda cegou",
      ).not.toBeNull();

      const naLista = (lista?.[1] ?? "")
        .split("\n")
        .map((l) => /^\s*"([a-z_]+)",/.exec(l)?.[1])
        .filter((v): v is string => Boolean(v));
      expect(naLista.length, "extraí zero nomes da lista — a sonda cegou").toBeGreaterThan(5);

      expect(
        naLista.includes(tabela),
        `\`${tabela}\` entrou em TABLES do rls-isolation. Ela é deny-all (RLS ligada, ` +
          "zero policies, grants revogados): lá o caso vai falhar com `permission denied`, " +
          "e criar policy para consertá-lo expõe credenciais OAuth pelo PostgREST. A prova dela é ESTE arquivo.",
      ).toBe(false);
    },
  );
});

describe.each(TABELAS_OAUTH)("o PostgREST não serve `%s` (migration 0615)", (tabela) => {
  it("a tabela EXISTE no baseline — controle positivo da sonda", () => {
    const existe = sql(`
      select count(*) from information_schema.tables
       where table_schema = 'public' and table_name = '${tabela}';
    `).trim();
    expect(existe, `\`${tabela}\` não está no baseline — o kit self-host não a cria`).toBe("1");
  });

  it("`anon`, `authenticated` e `PUBLIC` não têm privilégio NENHUM", () => {
    expect(privilegiosDe("anon", tabela)).toBe("NENHUM");
    expect(privilegiosDe("authenticated", tabela)).toBe("NENHUM");
    expect(privilegiosDe("PUBLIC", tabela)).toBe("NENHUM");
  });

  it("`service_role` tem exclusivamente SELECT, INSERT, UPDATE e DELETE — sem permissões extras", () => {
    expect(privilegiosDe("service_role", tabela)).toBe("DELETE,INSERT,SELECT,UPDATE");
  });

  it("`anon` é BARRADO ao ler e ao escrever — permission denied, não zero linhas", () => {
    esperaBarrado("anon", `select id from public.${tabela} limit 1`);
    esperaBarrado("anon", INSERT_PROBE[tabela]);
  });

  it("`authenticated` é BARRADO ao ler e ao escrever — permission denied, não zero linhas", () => {
    esperaBarrado("authenticated", `select id from public.${tabela} limit 1`);
    esperaBarrado("authenticated", INSERT_PROBE[tabela]);
  });

  it("`service_role` consegue consultar a tabela normalmente (controle positivo comportamental)", () => {
    const out = sql(`
      begin;
      set local role service_role;
      select count(*) >= 0 from public.${tabela};
      rollback;
    `);
    expect(out).toContain("t");
  });

  it("a RLS está LIGADA e não há policy nenhuma (deny-all em duas camadas)", () => {
    const ligada = sql(`
      select relrowsecurity from pg_class where oid = 'public.${tabela}'::regclass;
    `).trim();
    expect(ligada, "RLS desligada: o revoke vira a única defesa").toBe("t");

    const quantas = sql(`
      select count(*) from pg_policies
       where schemaname = 'public' and tablename = '${tabela}';
    `).trim();
    expect(quantas, "alguém criou policy: a tabela passa a ser SERVIDA pelo PostgREST").toBe("0");
  });
});

describe.each(TABELAS_OAUTH_TENANT)(
  "`%s` tem isolamento estrutural por organização e usuário em cascata",
  (tabela) => {
    it("`organization_id` é NOT NULL com FK ON DELETE CASCADE para `public.organizations`", () => {
      const nullable = sql(`
        select is_nullable from information_schema.columns
         where table_schema = 'public' and table_name = '${tabela}'
           and column_name = 'organization_id';
      `).trim();
      expect(nullable, `\`${tabela}\` precisa de organization_id NOT NULL`).toBe("NO");

      const cascataOrg = sql(`
        select confdeltype from pg_constraint
         where conrelid = 'public.${tabela}'::regclass
           and contype = 'f'
           and confrelid = 'public.organizations'::regclass;
      `).trim();
      expect(
        cascataOrg,
        `FK de organization_id em \`${tabela}\` precisa ser ON DELETE CASCADE`,
      ).toBe("c");
    });

    it("`user_id` é NOT NULL com FK ON DELETE CASCADE para `auth.users`", () => {
      const nullable = sql(`
        select is_nullable from information_schema.columns
         where table_schema = 'public' and table_name = '${tabela}'
           and column_name = 'user_id';
      `).trim();
      expect(nullable, `\`${tabela}\` precisa de user_id NOT NULL`).toBe("NO");

      const cascataUser = sql(`
        select confdeltype from pg_constraint
         where conrelid = 'public.${tabela}'::regclass
           and contype = 'f'
           and confrelid = 'auth.users'::regclass;
      `).trim();
      expect(cascataUser, `FK de user_id em \`${tabela}\` precisa ser ON DELETE CASCADE`).toBe("c");
    });
  },
);
