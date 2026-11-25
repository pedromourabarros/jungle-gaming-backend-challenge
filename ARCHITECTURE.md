# Arquitetura e decisões técnicas

## 1. Objetivo e limite da garantia

A unidade financeira do serviço é a wallet. PostgreSQL decide se uma operação pode ser aplicada e confirma, na mesma transação, o resultado, a mudança de saldo, o ledger, a inbox quando houver entrada SQS e os eventos da outbox. A fila transporta comandos e eventos; a proteção contra duplicação e saldo negativo permanece no banco.

O efeito financeiro é aplicado uma vez por identidade aceita. A entrega de mensagens e eventos continua sendo **at-least-once**. Uma resposta ou um ACK pode se perder depois do commit: a retomada consulta o resultado persistido, sem repetir o débito ou crédito.

O estado materializado obedece a:

```text
saldo da wallet = soma dos créditos do ledger − soma dos débitos do ledger
```

O crédito inicial positivo participa dessa soma por meio de uma transação interna `OPENING`. Uma abertura com saldo zero não fabrica movimento financeiro.

A evidência de execução, o ambiente e as limitações da validação estão em [VALIDATION.md](VALIDATION.md). Os procedimentos estão em [TESTING.md](TESTING.md), e a correspondência com o enunciado em [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

## 2. Organização do código

| Camada | Responsabilidade | Implementação principal |
|---|---|---|
| Domínio | Money, Wallet, WagerTransaction, ledger, estados de inbox/outbox e eventos tipados | `src/domain/` |
| Aplicação | Mesmo processamento financeiro para HTTP, SQS e referências pendentes; consultas | `src/application/financial-service.ts`, `query-service.ts`, `contracts.ts` |
| Persistência | EntityManager por operação, transações, lock da wallet e migration | `src/infrastructure/database.ts`, `migration.ts`, `schema.ts` |
| HTTP | Contratos, códigos de resposta, identidade extensível, health e métricas | `src/http/`, `src/main.ts` |
| Mensageria | SQS, ACK, retries, DLQ, leases e agendamento de workers | `src/messaging/` |
| Observabilidade | Logs JSON com campos permitidos e métricas por processo | `src/observability/` |

As classes de domínio têm construção controlada por factories. `rehydrate` recompõe o estado persistido sem repetir uma transição de negócio. O domínio não importa NestJS nem tipos monetários do ORM. Objetos de valor e eventos usam cópias defensivas; datas expostas não permitem alterar o estado interno por referência.

A aplicação usa o agregado Wallet, a máquina de estados WagerTransaction e factories de inbox/outbox no caminho financeiro real. As tabelas de inbox, outbox e ledger são manipuladas por SQL explícito dentro do contexto transacional do MikroORM. Os workers fazem claims e atualizações condicionais no banco para controlar concorrência entre processos; um objeto de domínio em memória não substitui essa coordenação.

## 3. Dinheiro exato e persistência

`Money` armazena **centavos em `bigint`**. O contrato externo recebe e devolve `{ "amount": "25.00", "currency": "BRL" }`. Não há conversão de valores monetários para `number`, `float` ou `double`.

A escolha de `bigint` reduz o problema à aritmética inteira: soma, subtração e inversão são exatas na escala fixa de duas casas exigida pelo desafio. Não há regra implícita de arredondamento: uma entrada como `"1.005"` é rejeitada. O parser também rejeita números JSON, notação científica, NaN, Infinity, strings vazias, espaços, sinais positivos, negativos externos, zeros à esquerda fora da forma canônica e escala diferente de duas casas.

O modelo suporta BRL, USD, EUR e GBP. Essas são as moedas aceitas pelo contrato e pelo schema. Aritmética e comparação de ordem exigem moedas iguais; igualdade de valores de moedas diferentes retorna `false`. Resultados internos podem ser negativos, como a diferença apresentada pela reconciliação; isso não autoriza saldo negativo de wallet.

A persistência usa `numeric(28,2)` e uma coluna de moeda. O maior valor admitido é `99999999999999999999999999.99`. O limite é validado no domínio antes de persistir uma operação; overflow não é arredondado. O mapeamento de saldo no `WalletSchema` usa string, mantendo a representação exata quando o driver devolve NUMERIC. A reidratação cria `Money` a partir dessa string.

`number` continua adequado para versões, limites de paginação, contadores, durações e portas, que não representam dinheiro.

### Wallet e versão

- Abertura positiva: saldo inicial, `version = 1`, `OPENING` processada, um lançamento CREDIT de zero até o saldo inicial e os dois eventos correspondentes.
- Abertura em zero: `version = 1`, sem OPENING, sem ledger e sem evento de mudança de saldo.
- Primeiro movimento de uma wallet aberta em zero: lançamento com `walletVersion = 2`.
- Cada movimento financeiro positivo incrementa a versão uma vez.
- LOSS, rejeições, falhas e replays não alteram saldo nem versão.

## 4. Transação, Identity Map e concorrência

Foi escolhido **MikroORM 6**, com `EntityManager.fork()` por unidade de trabalho e `EntityManager.transactional()`. Isso evita compartilhar o Identity Map entre solicitações concorrentes. O registro de wallet é carregado com `LockMode.PESSIMISTIC_WRITE` e `refresh: true`; a leitura relevante corresponde a `SELECT ... FOR UPDATE`.

O fluxo de uma submissão nova é:

1. Validar o contrato e calcular a identidade canônica do payload.
2. Abrir a transação SQL e, para SQS, reservar/bloquear a inbox.
3. Consultar uma operação existente pela key ou identidade externa. Um replay terminal pode retornar sem bloquear a wallet.
4. Bloquear somente a wallet solicitada.
5. Reconsultar a identidade da operação depois de adquirir o lock.
6. Validar referências, moeda, player, saldo e exclusividade de reversão.
7. Persistir o resultado; atualizar a wallet e inserir o ledger quando houver movimento; inserir os eventos; finalizar a inbox.
8. Confirmar o commit. Só depois o adaptador HTTP responde ou o consumidor pode fazer ACK.

A ordem de locks na entrada SQS é **inbox → wallet**. O worker de referências não adquire inbox: usa **wallet → transação pendente**, revalidando status e vencimento depois dos locks. Não há caminho financeiro que primeiro bloqueie uma transação pendente e depois sua wallet.

Wallets distintas podem progredir em paralelo. A mesma wallet é serializada durante a decisão e a escrita; duas BET de 80.00 contra saldo de 100.00 não conseguem aprovar usando a mesma leitura de saldo. A segunda encontra 20.00 e é rejeitada. Uma colisão intencional da mesma identidade entre wallets diferentes também encontra as constraints de unicidade.

A proteção final não depende de a mensagem ter vindo de FIFO, de haver somente uma instância nem de uma tabela em memória. O isolamento padrão do PostgreSQL é acompanhado do lock explícito e das constraints. O lock é mantido até o commit.

Conflitos SQL `23505`, `40001`, `40P01` e `55P03` podem reexecutar a unidade de trabalho, com no máximo dois retries e pequeno backoff com jitter. Cada tentativa recria o estado de domínio a partir dos dados aceitos; não reutiliza um agregado mutado por uma tentativa revertida. O ID interno pretendido permanece estável. Falhas transitórias que chegam ao adaptador HTTP são expostas como 503 com `retryable: true` e `Retry-After`.

Há limites de lock e statement configuráveis, com padrões de 2 e 10 segundos. A correção é preservada quando uma solicitação termina em timeout; ela pode ser reenviada com a mesma key.

## 5. Invariantes no PostgreSQL

As migrations versionadas estão em `src/infrastructure/migration.ts`. A primeira cria o schema financeiro, com SQL em `schema.ts`; a segunda adiciona o índice `ledger_transaction_lookup`, utilizado pelas consultas de integridade por transação para evitar varrer todo o ledger. O comando `down` desfaz as duas versões, removendo o índice, as tabelas e as funções; o roundtrip é testado em banco separado.

| Invariante | Defesa no schema |
|---|---|
| Uma wallet por player/moeda | `UNIQUE (player_id, currency)` |
| Idempotência e identidade externa | Key global única; `UNIQUE (provider_id, external_transaction_id)` |
| Saldo e snapshots não negativos | CHECKs de não negatividade e exclusão explícita de NUMERIC NaN |
| Um movimento por transação/wallet | `UNIQUE (wallet_id, transaction_id)` |
| Ordem financeira da wallet | `UNIQUE (wallet_id, wallet_version)` e continuidade validada pelo trigger do ledger |
| Aritmética do lançamento | CHECK de `balance_before ± amount = balance_after` |
| Ledger corresponde ao fato financeiro | Trigger valida wallet, player, moeda, valor, status, direção, versão e saldo materializado |
| Mudança de saldo exige ledger | Constraint trigger diferido `wallet_movement`, validado no commit |
| Resultado financeiro exige eventos | Constraint trigger diferido `transaction_result`, validado no commit |
| Reversão processada única por tipo | Índice parcial em `(reference_transaction_id, kind)` para REFUND/ROLLBACK PROCESSED |
| OPENING única e interna | Índice parcial por wallet e identificação interna verificada |
| Auditoria imutável | Triggers impedem UPDATE/DELETE do ledger e TRUNCATE das tabelas de auditoria protegidas |
| Resultado terminal e payload aceito imutáveis | Trigger de transação rejeita mudanças; inbox processada e conteúdo de evento também são protegidos |
| Evento corresponde à transação | Trigger de inserção e CHECKs do envelope da outbox; WalletBalanceChanged confere o lançamento |

As verificações diferidas resolvem a dependência entre as escritas: durante a transação, a aplicação pode inserir o resultado, atualizar a wallet, inserir o ledger e criar a outbox; no commit, o conjunto completo precisa estar consistente. Uma atualização isolada de saldo não passa apenas por satisfazer `balance >= 0`.

O ledger conserva saldo anterior, saldo posterior, direção e versão. Seu trigger confere continuidade com o lançamento anterior da mesma wallet. A primeira entrada é um OPENING na versão 1 ou o primeiro movimento na versão 2 de uma wallet aberta em zero.

### Credenciais e privilégios

O Compose separa `jungle_owner`, usado para migrations, de `jungle_app`, usado pelas instâncias da aplicação. O runtime não é superuser e não recebe CREATE no schema público, DELETE ou TRUNCATE. Para ledger e auditoria de falhas, recebe somente SELECT/INSERT. As demais tabelas operacionais recebem os UPDATEs necessários, acompanhados dos triggers de proteção.

Essas garantias se aplicam ao caminho da aplicação e ao seu papel de banco. O administrador responsável por migrations continua capaz de administrar o schema; não se pretende tornar PostgreSQL imune ao próprio DBA. Nunca se usa `schema:update` como substituto de migrations.

## 6. Idempotência e replay

### Identidades persistidas

A key HTTP vem exclusivamente do header `Idempotency-Key`; uma cópia no body é recusada para evitar um contrato ambíguo. No SQS, vem de `data.idempotencyKey`. Recomenda-se `{providerId}:{externalTransactionId}`. A key é única globalmente no serviço, de modo que o prefixo do provedor também evita colisões acidentais entre integrações.

A identidade externa permanece única em `(providerId, externalTransactionId)`. Reutilizá-la com outra key é `EXTERNAL_ID_KEY_CONFLICT`/409, mesmo quando o restante do payload é idêntico. Reutilizar a key com outros dados é `IDEMPOTENCY_CONFLICT`/409.

### Hash canônico

Depois da validação e normalização de UUIDs, o hash considera somente:

`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId`, quando presente.

O algoritmo ordena recursivamente as chaves dos objetos, preserva a ordem dos arrays, omite propriedades `undefined`, serializa em JSON e calcula SHA-256 sobre os bytes UTF-8. O resultado é armazenado em hexadecimal. Os valores MoneyProps já estão na forma decimal canônica.

Header/key, correlationId, messageId, occurredAt e demais metadados de transporte não entram no hash de negócio. O contrato é estrito: campos de transporte enviados dentro do payload de negócio não são silenciosamente adicionados ao hash.

A inbox tem chave primária `(consumer_name, message_id)`, usando o **messageId do envelope**, não o ID atribuído pelo SQS. Seu hash é SHA-256 do JSON canônico de `{ payloadHash, idempotencyKey }`. Assim, a mesma identidade de mensagem não pode ser reutilizada para trocar nem o comando nem sua key, enquanto uma reentrega com outro ID do broker continua sendo reconhecida.

### Resposta preservada

Cada resultado guarda saldo e moeda observados na decisão. Repetir uma BET já processada devolve esse snapshot, mesmo depois de outros créditos, débitos ou reinícios, acrescentando `idempotentReplay: true`. Resultados REJECTED e FAILED também são terminais. Uma key rejeitada não passa a ser aprovada quando o saldo muda.

PENDING_REFERENCE é um estado intermediário: uma consulta ou replay posterior pode retornar seu estado atualizado depois que o worker resolver a dependência. Ao chegar a um estado terminal, o resultado torna-se imutável.

## 7. Regras, referências e interpretações explícitas

| Kind | Efeito | Referência |
|---|---|---|
| OPENING | Crédito inicial interno | Proibida; não é aceito por HTTP/SQS |
| BET | Débito positivo | Não aceita referência |
| WIN | Crédito positivo | Opcional; quando informada, deve resolver para uma BET processada |
| LOSS | Nenhum | Opcional; quando informada, deve resolver para uma BET processada |
| REFUND | Crédito igual à BET | Obrigatória; somente BET processada |
| ROLLBACK | Efeito inverso, com o mesmo valor | Obrigatória; BET, WIN ou REFUND processada |

**LOSS aceita qualquer valor não negativo como informação do resultado**, incluindo 0.00. Esse valor não gera ledger, não muda a versão e não altera saldo. As operações com efeito financeiro exigem valor estritamente positivo.

Uma referência é localizada por provedor e ID externo. Deve pertencer ao mesmo player, wallet, moeda e rodada, além do mesmo provedor. `gameId` é persistido e integra o hash, mas não é uma condição adicional de compatibilidade de referência: o enunciado não a exige. WIN e LOSS referenciadas podem ter valor informativo/pagamento diferente do valor da BET; REFUND e ROLLBACK exigem igualdade exata, pois reversão parcial está fora do escopo.

**A exclusividade de reversão é por tipo, conforme a redação literal do desafio.** A mesma BET pode receber um REFUND e um ROLLBACK, uma vez cada, e ambos produzem crédito. Exemplo: saldo inicial 100.00, BET 20.00, REFUND 20.00 e ROLLBACK da BET 20.00 resultam em 120.00. Isso é uma decisão explícita de aderência ao enunciado, não uma regra implícita de estorno total único. Para exclusividade entre os dois tipos, seria necessário mudar a regra e o índice. O teste financeiro cobre a interpretação adotada.

Um ROLLBACK de REFUND ou WIN debita; um ROLLBACK de BET credita. Referências a ROLLBACK não são aceitas. Somente reversões PROCESSED ocupam a exclusividade: uma tentativa rejeitada não impede uma nova operação válida com outra identidade. A identidade rejeitada original continua terminal.

### Estados

| Estado atual | Transições permitidas |
|---|---|
| PENDING | PROCESSED, PENDING_REFERENCE, REJECTED, FAILED |
| PENDING_REFERENCE | PENDING_REFERENCE, PROCESSED, REJECTED, FAILED |
| PROCESSED, REJECTED, FAILED | Nenhuma mudança de resultado |

A tentativa de transicionar um estado terminal lança erro de domínio; o schema também impede alterar esse resultado. Ausência de saldo para BET usa `INSUFFICIENT_FUNDS`; reversão que debitaria além do saldo usa `REVERSAL_INSUFFICIENT_FUNDS`.

### Referências fora de ordem

Uma referência ausente ou ainda PENDING/PENDING_REFERENCE mantém a dependente como PENDING_REFERENCE. Uma referência terminal incompatível é rejeitada. Isso permite cadeias fora de ordem, como ROLLBACK de REFUND antes da chegada da BET original.

O worker consulta registros vencidos e, dentro do lock da wallet, revalida seu status e agenda. Os padrões são:

| Configuração | Padrão |
|---|---:|
| `REFERENCE_RETRY_BASE_MS` | 500 ms |
| `REFERENCE_RETRY_MAX_MS` | 30.000 ms |
| `REFERENCE_MAX_ATTEMPTS` | 20 |
| `REFERENCE_TTL_MS` | 86.400.000 ms / 24 horas |

A sequência de esperas começa em 0,5; 1; 2; 4; 8; 16; 30 segundos e mantém o teto. `pending_attempts` registra os reagendamentos, incluindo a primeira ausência. Após vinte reagendamentos, uma nova verificação ainda sem referência processável rejeita com `REFERENCE_NOT_FOUND`. Sem interrupções, isso ocorre em aproximadamente **7 minutos e 32 segundos**, acrescidos da latência dos workers; o TTL de 24 horas é um limite adicional, não a espera normal.

O worker primeiro procura a referência. Os limites são aplicados quando ela ainda não está processável. Se, na retomada, já existir uma referência PROCESSED válida, a operação pode ser aplicada mesmo depois do prazo nominal. Essa precedência é deliberada e está refletida no código. Não há correção ou retry automático de uma operação já REJECTED.

Só a primeira entrada em PENDING_REFERENCE emite seu evento. Os reagendamentos atualizam contador/data sem gerar uma sequência ilimitada de eventos iguais. A resolução ou rejeição cria o evento terminal correspondente.

### Taxonomia de decisões de negócio

| Código | Significado |
|---|---|
| `INSUFFICIENT_FUNDS` | BET não pode ser debitada |
| `REVERSAL_INSUFFICIENT_FUNDS` | Reversão de crédito produziria saldo negativo |
| `PLAYER_MISMATCH` | Wallet pertence a outro player |
| `CURRENCY_MISMATCH` | Moeda da operação/referência não é compatível |
| `REFERENCE_MISMATCH` | Identidade, wallet, player ou rodada divergente |
| `REFERENCE_INVALID_KIND` | Tipo da referência não permitido |
| `REFERENCE_NOT_PROCESSED` | Referência terminal sem resultado aplicado |
| `REFERENCE_AMOUNT_MISMATCH` | Tentativa de reversão parcial ou com outro valor |
| `REFERENCE_ALREADY_REVERSED` | Já existe reversão PROCESSED do mesmo tipo |
| `REFERENCE_NOT_FOUND` | Dependência não ficou processável antes da política de esgotamento |
| `BALANCE_LIMIT_EXCEEDED` | Resultado ultrapassaria a capacidade exata adotada |

Essas rejeições preservam transação, failureCode, snapshot e evento, sem ledger. Payload malformado, OPENING externo, referência obrigatória omitida ou autorreferência são erros de contrato; wallet inexistente é 404, pois não se cria uma wallet fictícia para registrar a operação.

## 8. SQS, ACK, DLQ e falhas auditáveis

O consumidor usa o mesmo `FinancialService.submit` do HTTP. A inbox, o efeito financeiro e os eventos participam do mesmo commit. Nenhum ACK é emitido porque uma operação apenas começou ou porque uma publicação foi planejada.

| Situação | Comportamento |
|---|---|
| PROCESSED ou REJECTED persistido | ACK após commit |
| PENDING_REFERENCE persistido | ACK; responsabilidade de retomada fica no worker SQL |
| Redelivery reconhecida pela inbox/key | Replay do resultado e ACK |
| Payload/envelope inválido ou identidade conflitante | Transferência para DLQ antes do ACK |
| Falha transitória | Sem ACK; backoff por visibilidade |
| Limite de processamento atingido com comando identificável | Tenta registrar FAILED/auditoria, transfere à DLQ e só então faz ACK |
| Falha no commit de auditoria ou no envio à DLQ | Mantém a mensagem sem ACK; o redrive do broker é a proteção adicional |

A fila principal é `wager-transactions.fifo`; a DLQ é `wager-transactions-dlq.fifo`; eventos usam `wager-events.fifo`. `MessageGroupId` por wallet é uma otimização recomendada. Consistência não depende de deduplicação FIFO.

O limite padrão de recebimentos é cinco. O backoff transitório usa segundos exponenciais, limitado a 30 segundos. O consumidor mantém heartbeat de visibilidade durante o processamento, no intervalo de um terço do timeout configurado. Antes de aplicar a visibilidade de retry, liberar uma entrega ou fazer ACK, interrompe e aguarda o heartbeat para impedir que uma renovação atrasada desfaça a decisão final.

FAILED é terminal e não produz movimento. `recordFailed` preserva resultados já terminais, registra a identidade da falha e, quando há wallet/comando válido, mantém transação, inbox e evento de falha atômicos. Uma falha permanente não sobrescreve uma transação PROCESSED. Mensagens malformadas conservam o body original na DLQ, sem inventar uma transação financeira válida.

Se PostgreSQL permanecer indisponível até o redrive do broker, não é possível prometer uma nova linha de auditoria nesse banco durante a indisponibilidade. A mensagem permanece recuperável pela DLQ; a retomada deve reutilizar suas identidades originais. A aplicação não ACKa uma tentativa cuja gravação necessária falhou.

### Encerramento

SIGTERM interrompe long polling/agendamentos e deixa os trabalhos ativos concluírem durante a janela configurada. No prazo limite, o runtime para heartbeats, devolve visibilidade de mensagens e libera leases que possui. Uma entrega marcada como liberada não recebe depois um ACK tardio pelo mesmo fluxo. O banco é fechado ao fim do encerramento; qualquer transação incompleta reverte. Em SIGKILL, a recuperação depende da visibilidade/lease finitos e das identidades persistidas.

## 9. Transactional outbox e recuperação

Cada evento tem classe concreta com `eventType` e `version = 1`, além de eventId, aggregateId da wallet, correlationId, causationId, occurredAt e data serializável. Money é convertido para MoneyProps no payload. As subclasses são WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionPendingReference, WalletBalanceChanged e o evento adicional WagerTransactionFailed.

O publisher reclama linhas vencidas em uma transação curta usando `FOR UPDATE SKIP LOCKED`, grava token UUID de proprietário, lease finito e contador de tentativas e confirma esse claim. A chamada ao SQS acontece **fora** dessa transação: uma rede lenta não segura o lock financeiro da wallet.

O lease padrão é 60 segundos, renovado durante envio. Para marcar sucesso, o publisher precisa apresentar o token atual e ainda possuir lease válido. Um processo antigo não pode marcar uma linha reclamada por outro. Depois de uma falha, agenda retry persistente; o publisher usa backoff de 1 segundo até 300 segundos, sem limite que descarte um evento confirmado.

| Ponto da falha | Recuperação |
|---|---|
| Antes do commit financeiro | Não existe efeito nem evento confirmado |
| Depois do commit financeiro, antes de publicar | Outra instância encontra a outbox |
| Depois do claim, antes do envio | Lease expira e outra instância reclama |
| Depois de SQS aceitar, antes de marcar publicação | A mesma identidade de evento pode ser publicada novamente |
| Depois da marcação | A linha deixa de ser candidata; o payload continua auditável |

Não existe transação distribuída PostgreSQL–SQS nem promessa de entrega exactly-once. A deduplicação FIFO reduz reenvios visíveis durante sua janela, mas o consumidor de eventos deve deduplicar **persistentemente por eventId**. Para projeções de saldo, `walletVersion` de WalletBalanceChanged permite detectar ordem e lacunas.

Publishers concorrentes não garantem que a ordem de chegada dos eventos reproduza a ordem financeira no banco. FIFO ordena envios aceitos por grupo; não coordena dois publishers que iniciaram envios em ordens diferentes. A versão do envelope identifica a versão do contrato e não substitui `walletVersion`.

A outbox permanece no banco depois da publicação. Não há rotina automática de expurgo ou arquivamento nesta entrega. Leases e retries são mecanismos de recuperação; alertas de lag e análise operacional continuam necessários para uma falha persistente de publicação.

## 10. Consultas e reconciliação

A reconciliação calcula saldo armazenado, soma assinada do ledger, diferença e quantidade de entradas em **uma consulta SQL**. O snapshot único do statement evita comparar saldo de um instante com ledger de outro. Uma diferença não é corrigida silenciosamente: é devolvida ao chamador, registrada em log e contabilizada em `reconciliation_mismatches_total`.

A paginação do ledger usa a sequência financeira `wallet_version`, e não timestamps sujeitos a empates. O primeiro acesso fixa um teto na versão corrente da wallet. O cursor carrega versão de formato, wallet, última versão entregue e esse teto; é codificado em base64url e autenticado com HMAC-SHA256. Novas entradas ficam para uma nova paginação, sem fazer itens antigos desaparecerem ou se repetirem entre páginas.

Todas as instâncias precisam compartilhar `CURSOR_SECRET`; troca desse segredo invalida cursores antigos. O cursor é opaco como contrato, mas não é um mecanismo de criptografia de dados.

## 11. Autenticação e observabilidade

### Decisão de autenticação

Autenticação não foi implementada, conforme a opção expressa do enunciado. `ProviderIdentityGuard` delega a `ProviderIdentityPort`; o adapter atual `UnauthenticatedChallengeIdentity` aceita as chamadas. Não há tabela de usuários, senha artesanal ou API key apresentada como substituto de IdP. Os health checks são abertos explicitamente.

A evolução prevista é um adapter OIDC que valide assinatura via JWKS, issuer, audience e expiração de tokens de um IdP externo, como Keycloak ou Zitadel, e associe claims autorizadas ao providerId. A autorização de operações administrativas de wallet também precisaria ser definida nessa integração. Esse desenho está proposto; não é uma funcionalidade pronta nesta versão. O canal SQS é tratado como interno, mantendo validações de provedor, player, wallet, moeda e referências no domínio.

### Logs e métricas

Os logs são linhas JSON com timestamp, nível, evento e uma allowlist de identificadores/códigos. correlationId, messageId, transactionId, walletId e providerId são incluídos quando existem no contexto. SQL, erros brutos, receipt handles e payloads financeiros completos não são registrados.

`/metrics` fornece texto no formato Prometheus com transações por status/kind, duplicatas, retries, DLQ, conflitos SQL/locks, latência de processamento, lag e pendências da outbox e divergências de reconciliação. Contadores e histogramas pertencem ao processo e reiniciam com ele; não são o armazenamento de auditoria nem a garantia de idempotência. Lag e quantidade pendente são consultados do PostgreSQL pelos publishers. Ao coletar várias instâncias, não se deve somar gauges que representam a mesma outbox global.

`/health/live` verifica se o processo responde. `/health/ready` verifica PostgreSQL e as filas SQS necessárias, devolvendo 503 quando alguma dependência não está acessível.

## 12. Trade-offs e limites conhecidos

- O lock por wallet simplifica uma garantia forte e testável; uma wallet muito disputada tem vazão limitada pela serialização de suas próprias operações. Wallets independentes continuam concorrentes.
- Ledger com saldo anterior/posterior é auditável, mas não é contabilidade de partidas dobradas. O desafio trata isso como diferencial opcional.
- Não há câmbio, frações de centavo, juros, pagamentos externos, saldo reservado, reversão parcial nem validação de encerramento global de uma rodada.
- Múltiplos WIN ou LOSS com identidades diferentes podem registrar resultados da mesma BET; a unicidade adicional exigida é a de reversões por tipo, não uma única liquidação da rodada.
- Referências pendentes são procuradas periodicamente. Não existe sinalização instantânea de dependentes quando a referência chega; o backoff controla o custo das consultas.
- Não há consumidor de projeções de eventos de terceiros implementado. O contrato fornece eventId e walletVersion para a deduplicação e ordenação que esse consumidor precisará manter.
- Os testes usam infraestrutura real, falhas injetadas e processos separados, mas uma suíte finita não demonstra ausência de qualquer defeito possível. O relatório de validação distingue precisamente execução nativa de execução em containers.
- Docker Compose e workflow de CI fazem parte da entrega. Sua inclusão não equivale a afirmar que esse ambiente foi executado onde o runtime de containers estava bloqueado.
