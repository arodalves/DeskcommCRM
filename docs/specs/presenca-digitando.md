# Presença do agente no canal

Destino: núcleo. Presença integra o contrato de transporte usado pela operação comum,
sem depender de extensão.

`ChannelAdapter.signalTyping` recebe organização, sessão, destinatário e, opcionalmente,
`inboundMessageId` (ID externo). O adapter declara `typingRequiresInboundMessage` quando
precisa dessa referência. `lib/messaging/presenca.ts` consulta somente nesses canais a
última mensagem inbound com ID externo não vazio, ordenando por `sent_at DESC NULLS LAST`,
`created_at DESC` e `id DESC`, nessa ordem, com filtros de organização e conversa.
Não cria estado persistente.

O adapter Meta Cloud usa `resolveMetaCreds` (sessão primeiro, ambiente como fallback)
e `graphBaseUrl`, fazendo POST em `/{phone_number_id}/messages` com
`messaging_product: whatsapp`, `status: read`, `message_id` e
`typing_indicator: { type: text }`. Isso também marca a mensagem como lida.
Contrato externo: [coleção oficial da Meta](https://www.postman.com/meta/whatsapp-business-platform/request/lhf0duq/send-typing-indicator-and-read-receipt).
Sem ID ou credencial não chama a API. A chamada tem timeout de cinco segundos;
erros HTTP, erros Graph no corpo e erros de rede sobem ao chamador.

WAHA continua chamando `setPresence(sessionRef, recipient, "typing")`, sem consulta
extra a mensagens. Adapters sem `signalTyping` continuam sem sinalização.

## Living System Checklist

1. Entrada: `inbound-turn.ts` → adapter do engine → `sinalizarDigitando`.
2. Saída: adapter de canal → transporte → indicador no WhatsApp do destinatário.
3. Registro: falhas geram o warn sanitizado existente de `acenderDigitando` ou
   `esperarComoHumano`, em `lib/agent-engine/agent/atraso-humano.ts`.
   Presença efêmera não acrescenta evento nem auditoria por sinalização.
4. Tela: o indicador aparece na conversa do destinatário no WhatsApp.
5. Porta: conversa já aberta nesse canal; não há nova tela no CRM.
6. Anti-morte: falha do indicador não impede o turno nem o envio; timeout limita espera.
7. Configuração: credenciais existentes em Conexões; nenhuma variável ou opção nova.
8. Continuidade: não altera handoff nem autoridade IA/humano; usa os pontos existentes do turno.
9. Retorno: falha degrada imediatamente para resposta sem indicador; não há retry
   persistente, pois repetir presença antiga não resolve a demanda.
10. Mapa: extensão do caminho existente documentada em `docs/architecture/presenca-digitando.architecture.json`.

Prova automatizada: `tests/unit/messaging-presenca-digitando.test.ts`,
`tests/unit/channel-adapter-meta.test.ts` e testes existentes de atraso humano e WAHA.
Esses testes não substituem a observação do indicador num aparelho com uma conta real.
