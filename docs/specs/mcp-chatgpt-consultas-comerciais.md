# Consultas comerciais no MCP ChatGPT existente

Implementação: `lib/mcp/chatgpt/prospecting-read.ts`, registrada por
`chatGptTools` e `createChatGptMcpServer`, no endpoint existente `/mcp`.
Destino: núcleo, ampliação do contrato de leitura existente. Nenhuma extensão,
novo conector, servidor, autenticação ou alteração dos agentes é necessária.

## Contrato

| Ferramenta                         | Entrada                                                                                                             | Resultado                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_prospecting_campaigns`       | `limit`, `cursor`, `status`, `order`                                                                                | Campanhas, segmento, localização, agente e conexão WhatsApp, status, contagens e datas                                                                                      |
| `list_campaign_conversations`      | Exatamente um de `campaign_id`/`campaign_name`; `limit`, `cursor`, `status`, `response`, `needs_follow_up`, `order` | Uma linha por empresa/candidato, vínculos, pipeline, última mensagem, entrega inicial, respostas, evidências e acompanhamento                                               |
| `get_lead_conversation`            | `lead_id`, `limit`, `cursor`                                                                                        | Todas as mensagens do contato do lead, em páginas cronológicas por `sent_at,id` (fallback `created_at`), com texto integral, autoria, status, mídia e registros disponíveis |
| `get_campaign_prospecting_summary` | Exatamente um de `campaign_id`/`campaign_name`                                                                      | Indicadores integrais, calculados no banco e independentes da página de resultados                                                                                          |

`limit`: padrão 25, mínimo 1, máximo 100. `order`: criação + ID, ascendente ou
descendente. Campanhas usam descendente por padrão; empresas usam ascendente.
Nome exato sem distinguir maiúsculas, incluindo **Móveis planejados — Betim**.
Nomes repetidos causam erro com orientação para usar ID; não escolhem outra campanha.
Respostas paginadas: `data` e `meta.{has_more,cursor,snapshot_at}`.

Cursor: base64url + HMAC-SHA256 com `INTERNAL_SECRET` já exigido pela infraestrutura.
Vinculado à organização, token, ator, papel, ferramenta e filtros. Expira em uma
hora. Alterar apenas o limite entre páginas é permitido. Não aceite cursor como
autorização: cada página refaz os filtros de organização e verifica os vínculos.
O watermark de criação evita incluir novas linhas nas páginas seguintes;
**não congela alterações de status nem mensagens antigas editadas entre chamadas**.
Cada chamada usa uma transação consistente `REPEATABLE READ READ ONLY`, com
`statement_timeout` de oito segundos. Não há transferência de mídia nem URL de
armazenamento exposta. Mensagens revogadas têm o texto ocultado.

## Evidência e interpretação

- **CONFIRMADO pelo registro:** status de envio/entrega, mensagens recebidas,
  etapa atual, trava humana, último handoff registrado, opt-out `ai_opt_out`.
  `is_blocked` é apresentado separadamente; bloqueio não é automaticamente opt-out.
- Qualificação confirmada significa **registro na etapa configurada** em
  `qualified_stage_id`; não é nova avaliação do conteúdo. Não qualificado exige
  etapa `is_lost`; demais situações não são declaradas desqualificadas.
- **INTERPRETADO:** padrões textuais conservadores indicam automação, possível
  autoria humana, interesse ou recusa. Nenhum deles grava estado ou qualifica
  lead. Evidências de interesse e recusa trazem até cinco IDs de mensagens;
  consulte o histórico para verificar o contexto integral e eventuais negações.
- O CRM atual não garante um produtor de `metadata.response_kind`. Só um registro
  explícito `human` conta como humano confirmado. Mensagens textuais sem sinal
  automático contam como `human_inferred_count`, mas permanecem `response=unknown`.
  Mídia sem texto também é desconhecida. As contagens por tipo podem se sobrepor
  quando um contato tem mensagens de mais de um tipo.
- Autoria outbound usa os campos existentes `sent_via`/`sent_by_user_id`:
  `ai` → IA, `user`/`external_device` ou usuário identificado → humano,
  `automation` → automação, demais origens → desconhecida. Inbound → cliente,
  sem presumir que esse cliente é humano.
- As consultas da campanha usam conversa e contato do candidato, mensagens a
  partir de `attempted_at` (ou criação), e revisão do atendimento quando
  registrada. A mensagem inicial vinculada por ID também entra. Não prova que a
  campanha causou a resposta. O histórico individual inclui todos os atendimentos
  do contato, inclusive outras campanhas, e declara esse escopo na resposta.
- Handoff e opt-out retornados junto ao histórico são o **último registro da
  conversa e o estado atual do contato**, não uma reconstrução temporal de todas
  as mudanças. Metadados `refusal`/`handoff` só aparecem quando já gravados.
- `needs_follow_up` é sugestão de revisão humana: interesse aparente, trava
  humana, última mensagem não automática sem resposta enviada posterior ou falha.
  Recusa aparente, opt-out, bloqueio e negócio perdido suprimem essa sugestão.
  Não agenda follow-up e não autoriza novo contato.

## Indicadores e denominadores

`companies_found`: `result_count` registrado na busca; `search_results_excluded`:
`skipped_count` da busca. As contagens `companies_registered/approached/pending/
excluded/failed` vêm dos candidatos presentes, respectivamente total, `sent`,
`new|queued|sending`, `skipped` e `failed`. Não some descartes da busca a candidatos
excluídos como se fossem empresas distintas. Retenção/exclusão pode fazer o total
presente diferir do total histórico registrado na busca.

No resumo, `companies_prospected` exige ao menos uma mensagem outbound com status
`sent|delivered|read`. `messages_sent` inclui entregues/lidas; `messages_delivered`
inclui lidas; falhas e pendentes são contadas separadamente. Respostas são inbound.
Contatos e leads são distintos por ID; empresas são distintas por candidato.

Taxa de resposta = empresas prospectadas com inbound / empresas prospectadas.
Taxa de qualificação = empresas prospectadas na etapa qualificada / empresas
prospectadas. Cada taxa inclui numerador, denominador e valor entre 0 e 1;
denominador zero retorna `null`. Contatos que responderam sem envio confirmado
aparecem no total de contatos, mas não no numerador dessas taxas.

## Segurança e operação

Role mínima `agent`, scope `mcp:read`; guardas e limites MCP existentes preservados.
Todas as tabelas e todos os JOINs usam organização confiável do contexto. IDs
externos nunca definem a organização. SQL parametrizado, ordenação por enum;
nenhuma interpolação de texto do usuário em SQL. SQL roda pelo pool existente
`getRequestPool` (mesma `SUPABASE_DB_URL` usada na prospecção).
Auditoria registra apenas `{read_only:true}` como argumentos, sem nome de campanha,
contato, texto ou cursor. Erros de banco são convertidos para mensagem genérica.
`readOnlyHint` é publicado no registro do SDK. Nenhuma ferramenta existente foi
retirada, nem recebeu permissões adicionais. Nenhuma migration é necessária.

## Validação reproduzível

```sh
pnpm vitest run lib/mcp/chatgpt/prospecting-read.test.ts tests/unit/chatgpt-mcp.test.ts tests/unit/oauth-mcp.test.ts
pnpm typecheck
pnpm lint
```

Para executar os casos SQL, defina `MCP_READ_TEST_DATABASE_URL` para PostgreSQL
**local descartável**. Os testes criam tabelas temporárias e usam um pool próprio,
sem dados da instalação. Sem essa variável, os casos SQL são explicitamente
ignorados; os testes de contrato, SDK e cursores continuam rodando. A validação
SQL testa isolamento manual sob acesso administrativo; não altera nem pretende
substituir a suíte de RLS/baseline do produto.

## Publicação após autorização

1. Aplicar a alteração no repositório que publica a instalação Fluxalvo e executar
   os checks exigidos pelo CI. Revisar o diff e publicar a imagem pelo fluxo já
   adotado pelo projeto. Não é necessário outro servidor nem alteração de OAuth.
2. **Somente após autorização do proprietário**, atualizar a aplicação da VPS
   com a imagem aprovada pelo procedimento existente. Não mudar worker, scheduler,
   agentes, campanhas nem follow-ups por causa desta alteração.
3. Verificar `initialize`, `tools/list` e `tools/call` no **mesmo `/mcp`**, com token
   válido: as quatro novas ferramentas e as anteriores devem estar presentes;
   conferir schemas e `readOnlyHint:true`. Token sem `mcp:read` deve ser recusado.
4. Nos detalhes do conector **Fluxalvo CRM v1.2** nas configurações de apps do
   ChatGPT, usar a atualização/refresh das ferramentas da conexão existente e
   revisar as permissões. Não criar nem recriar plugin ou autenticação.
5. Confirmar no ChatGPT a consulta por nome, abrir uma conversa pelo lead e
   conferir o resumo com os mesmos dados. A campanha citada é exemplo de entrada;
   esta implementação não consultou nem alterou sua campanha em produção.

A documentação oficial orienta atualizar os detalhes da conexão para buscar
ferramentas, descrições e instruções novas: [OpenAI — Add custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server).

## Living System Checklist

Entrada: tabelas de prospecção, CRM e mensagens existentes → `prospecting-read.ts`.
Saída: `chatGptTools` → `createChatGptMcpServer` → `/mcp` → ChatGPT.
Registro: `auditMcpToolCall`, com argumentos redigidos; resultado visível na
conversa ChatGPT. Porta: o conector Fluxalvo CRM v1.2 existente. Configuração:
mesmo OAuth/token, papel, escopo e pool. Continuidade: apresenta último handoff,
trava humana e evidências, sem executar transferência. Anti-morte e laço de
retorno automáticos: nenhum, por ser leitura; falhas viram erro MCP e orientam
nova consulta/revisão humana. O mapa está em
`docs/architecture/mcp-consultas-comerciais.architecture.json`.

## Precisão do cursor

A fronteira de paginação é serializada pelo PostgreSQL com seis casas de
microssegundos em UTC. Não passa por `Date` do JavaScript, que arredondaria para
milissegundos e poderia repetir registros na ordem ascendente ou pular registros
na descendente. O teste de regressão cobre campanhas, candidatos e histórico.
