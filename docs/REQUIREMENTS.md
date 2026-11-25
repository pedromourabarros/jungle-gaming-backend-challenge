# Matriz de requisitos e evidências

Esta matriz relaciona o enunciado, a implementação e os testes presentes no repositório. Os resultados efetivamente obtidos ficam em [VALIDATION.md](../VALIDATION.md); a coluna de testes identifica onde verificar cada comportamento, sem presumir a execução de um ambiente que não tenha sido registrado.

## Stack, domínio e persistência

| Requisito | Implementação | Teste ou evidência |
|---|---|---|
| Bun 1.x, TypeScript estrito, NestJS | `package.json`, `bun.lock`, `tsconfig.json`, `src/main.ts` | `bun run typecheck`; APIs iniciadas por Bun na suíte de processos |
| PostgreSQL e MikroORM | `src/infrastructure/database.ts` | Integração financeira e migrations reais |
| SQS via LocalStack | `src/messaging/sqs-gateway.ts`, `compose.yaml` | `test/integration/messaging.test.ts` |
| Docker Compose | `compose.yaml`, `Dockerfile`, `infra/` | Comando do perfil `test` e `.github/workflows/ci.yml`; execução em containers separada da evidência nativa |
| Migrations versionadas e reversíveis | `migration.ts`, `schema.ts`, `scripts/migrate.ts` | `test/integration/migrations.test.ts`: up, down e up em banco isolado |
| Money sem number/float/double | `src/domain/money.ts`: centavos bigint, strings no contrato, NUMERIC no banco | `test/unit/money.test.ts`; teste financeiro de overflow |
| Escala de duas casas e rejeição de entradas inválidas | `Money.from`, `src/application/contracts.ts` | `money.test.ts`, `contracts.test.ts`, casos HTTP inválidos |
| Modelo com múltiplas moedas e conflito de moeda | BRL, USD, EUR, GBP no domínio e schema | Unitários de Money/Wallet; rejeição auditada de moeda na integração |
| Construtores controlados e rehydrate | `src/domain/` | Unitários de reidratação e preservação de estados terminais |
| Wallet única por player/moeda | UNIQUE de `wallets` | Integração: unicidade e wallet independente em outra moeda |
| Saldo não negativo no banco | CHECKs com exclusão de NaN; triggers de movimento | Integração: tentativa de saldo negativo/NaN e atualização sem ledger |
| Versão só muda com saldo | Wallet + `guard_wallet_update` | Abertura positiva, abertura zero, primeiro crédito na versão 2 e LOSS |
| Ledger auditável e imutável | `wallet-ledger-entry.ts`; constraints e triggers SQL | Unitários; tentativas SQL de UPDATE/DELETE/TRUNCATE/adulteração |
| Um lançamento por transação/wallet | UNIQUE composto e verificação do resultado | Integração: duplicação de ledger e races |
| Saldo/ledger/outbox consistentes no commit | `wallet_movement`, `transaction_result` e `verify_outbox_insert` | Rollback antes do commit; tentativas de resultado sem seus fatos correspondentes |
| Runtime com privilégios restritos | `infra/postgres-init.sql`, grants da migration | Teste real com `APP_DATABASE_URL` usando `jungle_app` |

## Regras financeiras, estados e identidade

| Requisito | Implementação | Teste ou evidência |
|---|---|---|
| BET debita e rejeita saldo insuficiente | `Wallet.debit`, `FinancialService.evaluate` | BET/WIN/LOSS; insuficiência; cenário 80.00/100.00 |
| WIN credita | `Wallet.credit` e direção de WagerTransaction | Unitários e integração financeira |
| LOSS não movimenta saldo | `affectsBalance` e validação de LOSS informativo não negativo | Unitários; integração compara versão/ledger antes e depois |
| OPENING somente interna | Factory `opening`, DTO sem OPENING e constraints internas | Abertura positiva/zero; parser SQS rejeita OPENING |
| REFUND da BET integral e uma vez por tipo | Referência validada e índice parcial de reversão | Integração: reversões por tipo, valor parcial e repetição |
| ROLLBACK de BET/WIN/REFUND com efeito inverso | `validateReference`, `ledgerDirectionFor` | Unitários das direções; integração de ROLLBACK de REFUND |
| Referência com provedor/player/wallet/moeda/rodada compatíveis | Busca por provedor/ID externo e domínio | Integração: referências divergentes e escopo de provedor |
| Reversão que debitaria demais usa código distinto | `REVERSAL_INSUFFICIENT_FUNDS` | Unitário de Wallet; integração de reversão rejeitada e posterior operação válida |
| Estados terminais imutáveis | Métodos de WagerTransaction e `guard_transaction_update` | Unitários de transição; tentativa SQL de mutação |
| Rejeição auditável e sem ledger | Persistência de failureCode, snapshot e evento | Insuficiência, owner/moeda, referência inválida, overflow |
| FAILED auditável | `FinancialService.recordFailed`, `failed_messages`, evento de falha | Integração financeira; retry esgotado antes de DLQ |
| Key obrigatória e header como fonte HTTP | Controller + `parseSubmission` | Unitários de contrato; HTTP 400 sem header/body ambíguo |
| Hash canônico de negócio | `businessPayload`, `canonicalJson`, `canonicalHash` | Ordenação de chaves, UUID normalizado, key fora do hash |
| Mesma key com payload diferente é conflito | `findExisting`/`assertReplay`, índice único | Integração de key divergente inclusive entre wallets |
| Mesma identidade externa com outra key é conflito | UNIQUE provider/external e `EXTERNAL_ID_KEY_CONFLICT` | Integração de key alternativa |
| Replay retorna saldo histórico | `observed_balance`/`observed_currency` persistidos | Replay depois de novos movimentos e nova conexão/processo |
| Referências fora de ordem persistidas | Estado PENDING_REFERENCE e `next_attempt_at` | WIN/LOSS/REFUND/ROLLBACK referenciados antes da BET; reinício de aplicação |
| Worker com backoff/limite/TTL | `retryPendingBatch`, configuração e worker agendado | Integração de vencimento, incremento do contador e esgotamento |
| Evento ao esgotar referência | `REFERENCE_NOT_FOUND` + WagerTransactionRejected | Teste financeiro de referência esgotada |

## HTTP e consultas

| Requisito | Implementação | Teste ou evidência |
|---|---|---|
| POST /wallets | `WalletsController` e `createWallet` | Integração HTTP; abertura atômica com OPENING |
| GET /wallets/:id | `QueryService.wallet` | Integração HTTP |
| Ledger com cursor estável e opaco | Teto de versão, ordem por `wallet_version`, cursor HMAC | Inserções concorrentes durante paginação; adulteração e uso em outra wallet |
| Consulta por ID interno | `QueryService.transaction` | Integração HTTP |
| Consulta por provider/ID externo | `providerTransaction` | Integração HTTP e escopo de provedor |
| POST /wagering/transactions | Mesmo `FinancialService.submit` da fila | Contratos HTTP e suítes financeira/de processos |
| Diferenciar inválido/conflito/rejeitado/pendente/transitório | 400 / 409 / 422 / 202 / 503 e códigos estáveis | Integração HTTP, inclusive lock timeout real seguido de retry |
| Reconciliação não corrige divergência silenciosamente | Uma consulta SQL; flag, diferença, log e métrica | Reconciliação depois dos cenários financeiros e de concorrência |
| Liveness e readiness separados | `OperationsController` | HTTP health; readiness usada para iniciar processos de teste |
| Autenticação opcional e ponto de extensão | `ProviderIdentityPort`, guard e adapter no-op | Decisão em [ARCHITECTURE.md](../ARCHITECTURE.md); health explicitamente aberto |

## SQS, outbox, concorrência e recuperação

| Requisito | Implementação | Teste ou evidência |
|---|---|---|
| Mesmo caso de uso para HTTP e SQS | `SqsConsumer` chama `FinancialService.submit` | Integração de mensagem real |
| Inbox por consumerName/messageId | PK composta; ID do envelope; hash incluindo key | Redelivery real e conflito da mesma identidade de mensagem |
| ACK somente após commit | Retorno da unidade de trabalho antes de DeleteMessage | Unitário de ordem; SIGKILL pós-commit/pré-ACK |
| Erro de negócio terminal recebe ACK | Resultado persistido REJECTED | Unitário do consumidor e integração financeira |
| Transitório faz retry com backoff | Visibilidade, heartbeat e contador de recebimentos | Unitários de transporte; retries reais e rollback de efeitos |
| Permanente/limite leva à DLQ | SendMessage na DLQ antes de DeleteMessage | Malformada, conflito e falha esgotada; DLQ indisponível mantém a origem |
| Shutdown drena ou libera visibilidade | `MessagingRuntime.stop`, `releaseInFlight`, heartbeat interrompido | Encerramento dos subprocessos na suíte de processos; heartbeat exercitado em `consumer.test.ts` |
| Publicação somente de eventos confirmados | Outbox inserida na transação; publisher posterior | Atomicidade e retomada depois de falha |
| Publishers concorrentes | SKIP LOCKED, lease UUID e atualização condicional | Dois publishers de integração e dois processos Nest independentes |
| Publisher antigo não confirma claim perdido | Fencing por token e validade temporal | Integração de substituição de lease |
| Crash após envio não perde identidade | Payload/eventId imutáveis; lease expirável | SIGKILL pós-Send/pré-mark e publicação retomada |
| Eventos tipados e versionados | Classes concretas em `src/domain/events.ts` | Unitários de envelope e comparação com payload efetivamente entregue |
| 50 duplicatas simultâneas | Constraints, rechecagem após lock e replay persistido | `test/concurrency/processes.test.ts`, distribuição entre três APIs |
| Duas BET 80.00 contra 100.00 | Lock exclusivo por wallet | Uma processada, uma rejeitada, saldo 20.00 e um débito |
| Wallets diferentes em paralelo | Ausência de lock global financeiro | Lock real em A observado no PostgreSQL enquanto B conclui |
| Pelo menos três processos | Helper inicia executáveis Bun e confirma PIDs distintos | Cenário de cinquenta requisições HTTP |
| Restart preserva consistência | Estado financeiro, inbox e outbox persistidos | Crash pré-commit; referência pendente após restart; replay após segundo restart |
| Invariante final de saldo/ledger | Reconciliação SQL e assertions por wallet | Hooks `afterEach` das suítes financeiras/de processos e cenários de mensageria |

## Observabilidade, entrega e limites

| Requisito | Implementação | Evidência/limite |
|---|---|---|
| Logs JSON sem payload financeiro completo | `src/observability/logger.ts`, allowlist | Caminhos de HTTP, transação, consumer e publisher |
| IDs para rastrear operações | correlationId, messageId, transactionId, walletId, providerId | Contexto preservado na submissão e no evento; campos ausentes são omitidos |
| Métricas de status/duplicatas/retry/DLQ/locks/lag/latência | `src/observability/metrics.ts` e pontos de instrumentação | `/metrics`; contadores por processo, outbox consultada no banco |
| README e decisões técnicas | `README.md`, `ARCHITECTURE.md`, `TESTING.md` | Instruções, interpretações e trade-offs explícitos |
| Integração em containers | Compose + workflow de CI | Preparados para execução; execução nativa real é reportada separadamente |
| Teste de carga opcional | Script exposto por `bun run test:load` | Interpretar somente junto do relatório efetivamente produzido |
| Partidas dobradas / OpenTelemetry / dashboard | Não implementados | Diferenciais opcionais, fora do escopo desta entrega |

### Interpretações que afetam o resultado financeiro

A documentação de arquitetura é parte do contrato da solução:

- Reversões são únicas **por tipo**: REFUND e ROLLBACK podem ambos reverter a mesma BET, uma vez cada.
- LOSS aceita valor informativo não negativo e sempre tem efeito financeiro zero.
- WIN e LOSS podem omitir referência; se a informam, aguardam uma BET processada compatível.
- `gameId` integra o payload/hash, mas não acrescenta uma condição de igualdade à referência além das exigidas pelo enunciado.
- Ao retomar uma dependência, uma referência já processada válida tem precedência sobre o prazo nominal; esgotamento rejeita a dependência ainda não processável.
- A entrega dos eventos pode ser duplicada e fora da ordem financeira. O consumidor de eventos deve persistir deduplicação por eventId e usar walletVersion quando construir uma projeção de saldo.
