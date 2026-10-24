# Prospecção: encerramento, evidência e retomada

Destino: núcleo. As regras só alcançam candidatos aceitos e vinculados à campanha,
organização, agente e conexão de origem. Atendimento sem esse vínculo segue o
runtime existente. Nenhuma tabela, dependência ou serviço pago foi adicionado.

`prospecting.initial_outbound_accepted` é emitido na mesma transação que registra
`provider_accepted_at`. A inscrição começa no gatilho do grafo publicado; a primeira
espera de dias úteis conta desse timestamp (ou do outbound aceito na conversa
interrompida). Os nós e intervalos existentes continuam sendo a fonte de verdade.

`eventoDeProspeccaoElegivel` revalida o estado atual antes da inscrição. A guarda de
envio revalida contato, conversa, oportunidade, agente, conexão e campanha.
Saudação, ausência e texto vazio não provam interação humana ou interesse.
Conversa interrompida exige sinal comercial positivo, saída aceita e ausência de
resposta posterior. Uma recusa impede as duas modalidades. Inscrição anterior
para o mesmo outbound impede reentrada por replay, inclusive após encerramento.
O índice existente de inscrição ativa por contato impede concorrência dos fluxos.

Recusa inequívoca de prospecção marca o candidato, cancela suas inscrições e os
crons da mesma conversa, fecha essa conversa e usa `encerraDemanda` para mover o
negócio no funil da campanha. A timeline recebe motivo e evidência; falha no
encerramento abre revisão na Central. Mensagem ambígua abre revisão sem mover o
card. CRM ou site existente são contexto, não recusa. O marcador impede que
mensagens posteriores reativem automaticamente a abordagem recusada.

ACK WAHA sem mensagem correlacionada solicita replay transitório pelo mecanismo
existente. Correlação exige organização, conexão e direção outbound, com IDs
composto e canônico. ACK só avança; timestamps existentes são preservados.
`message.any` com ACK de entrega/leitura já nasce nesse estado. A confirmação de
envio tardia não rebaixa ACK. O caminho de confirmação da Meta Cloud permanece
igual. `delivered_at` representa a observação do ACK, sem inventar o horário real
de entrega no dispositivo.

O MCP mantém as 16 ferramentas. `pipeline_qualified` informa a etapa;
`qualified_confirmed` exige também resposta humana registrada, sinal textual de
interesse e ausência de recusa. Autoria inferida exige indício positivo e continua
distinta da confirmação. Texto automático é interpretação, nunca prova humana.

Sistema vivo: inbound e evento de aceite alimentam classificação/guardas; estas
alimentam encerramento, inscrições e Inbox. Timeline do negócio e Central exibem
evidência e falhas; os marcadores e o estado terminal alimentam o próximo turno e
o bloqueio antes do envio. A configuração continua nos editores existentes de
agente e follow-up, sem fluxo paralelo ou nova porta de navegação.

O complemento comercial do Gael deve entrar por nova versão em rascunho do editor
existente, preservando todos os outros campos. O arquivo integral proposto e os
identificadores esperados ficam na entrega operacional. Nenhuma configuração de
produção é alterada pela edição deste código.
