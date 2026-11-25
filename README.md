# Jungle Gaming — Distributed Wagering Processor

Implementação do desafio de processamento financeiro distribuído com **Bun 1.3.3, TypeScript estrito, NestJS, MikroORM, PostgreSQL e SQS**. HTTP e fila executam o mesmo caso de uso. Saldo, ledger, transação, inbox e outbox são confirmados em uma única transação SQL.

As decisões de arquitetura, os cenários de teste e os resultados de execução estão documentados neste repositório. O relatório de validação distingue os comportamentos verificados das limitações do ambiente usado.

## Comece aqui

Com Docker Engine/Desktop e Docker Compose v2 disponíveis:

```bash
docker compose up --build -d
```

O Compose sobe PostgreSQL e LocalStack, cria as filas FIFO, executa as migrations e inicia a API com os workers. A aplicação fica em `http://localhost:3000`.

```bash
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
```

Para executar **três instâncias simultâneas**, compartilhando o banco e as filas:

```bash
docker compose --profile cluster up --build -d
```

As APIs ficam nas portas `3000`, `3001` e `3002`. Os três processos podem consumir mensagens, publicar a outbox e resolver referências pendentes.

**Escopo de autenticação:** a integração com IdP foi deixada explicitamente fora desta entrega, opção aceita na seção 2 do desafio. `ProviderIdentityPort` e `ProviderIdentityGuard` são os pontos de extensão para OIDC/JWKS. O Compose expõe as portas apenas no loopback do computador. Credenciais presentes nos exemplos são exclusivas de desenvolvimento local.

**Evidência de execução:** consulte [VALIDATION.md](VALIDATION.md). Os testes desta entrega foram executados com PostgreSQL e LocalStack reais, iniciados nativamente no ambiente de validação. O ambiente bloqueou os sockets necessários ao Docker; por isso a execução dos containers/Compose não é apresentada como verificada. A suíte e o workflow de CI incluídos permitem executar a validação em containers.

## Demonstração automática

Com Bun 1.3.3 e a API em execução:

```bash
bun install --frozen-lockfile
bun run demo
```

A demonstração cria uma wallet de `100.00 BRL`, envia duas BET de `80.00` em paralelo, confirma que somente uma foi processada, repete ambas as operações e reconcilia o saldo final de `20.00`. O script encerra com erro se qualquer invariante falhar.

## Testes

O comando abaixo constrói a imagem de testes e executa typecheck, testes de unidade, integração PostgreSQL/SQS e concorrência entre processos:

```bash
docker compose --profile test run --build --rm tests
```

Os bancos de teste são separados do banco `jungle` da aplicação. A suíte exige nomes terminados em `_test` e `ALLOW_INTEGRATION_TESTS=1`; não usa `TRUNCATE` para limpar histórico financeiro. O roundtrip de migrations utiliza exclusivamente `jungle_migration_test`.

Com as dependências acessíveis localmente:

```bash
cp .env.test.example .env.test
NODE_ENV=test bun run test
```

Comandos individuais:

| Comando | O que verifica |
|---|---|
| `bun run typecheck` | TypeScript estrito, incluindo scripts e testes |
| `bun run test:unit` | Domínio, hash/contratos e falhas de transporte isoladas |
| `bun run test:integration` | PostgreSQL e LocalStack reais, API, schema, migrations e janelas de falha |
| `bun run test:concurrency` | Três processos Nest/Bun, concorrência, reinícios e publishers independentes |
| `bun run build` | Bundle da aplicação para Bun, dependências externas |
| `bun run test:load` | Experimento HTTP com duplicatas, percentis e reconciliação |

Os testes de integração e concorrência **falham** se a infraestrutura não estiver disponível; não são silenciosamente substituídos por mocks nem marcados como aprovados sem executar. Detalhes em [TESTING.md](TESTING.md).

## Desenvolvimento local

```bash
cp .env.example .env
bun install --frozen-lockfile
docker compose up -d postgres localstack
bun run db:migrate
bun run queues:init
bun run start:dev
```

`DATABASE_URL` usa a role restrita `jungle_app`. `MIGRATION_DATABASE_URL` usa o proprietário do schema. A aplicação não executa migrations durante o atendimento de requisições.

```bash
bun run db:rollback
bun run db:migrate
```

`db:rollback` desfaz a migration financeira e remove suas tabelas: utilize somente no banco de desenvolvimento que deseja recriar. Em produção, a evolução deve ocorrer por novas migrations e política explícita de retenção/backup.

## API

Especificação completa: [docs/openapi.yaml](docs/openapi.yaml). Requisições prontas: [docs/requests.http](docs/requests.http).

| Método | Rota | Comportamento |
|---|---|---|
| POST | `/wallets` | Abre wallet; saldo positivo gera OPENING, ledger e eventos |
| GET | `/wallets/:walletId` | Saldo atual e versão |
| GET | `/wallets/:walletId/ledger` | Ledger com cursor opaco e limite de 1 a 200 |
| POST | `/wagering/transactions` | Processa ou registra pendência/rejeição de forma idempotente |
| GET | `/wagering/transactions/:transactionId` | Consulta a transação persistida |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pela identidade do provedor |
| POST | `/wallets/:walletId/reconciliation` | Compara saldo com a soma assinada do ledger |
| GET | `/health/live` | Liveness do processo |
| GET | `/health/ready` | Readiness de PostgreSQL e das três filas SQS |
| GET | `/metrics` | Métricas em formato Prometheus |

### Criar wallet

```bash
curl -X POST http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

Use o `id` retornado como `walletId` no próximo pedido:

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "bet-001",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "SUBSTITUA-PELO-ID-DA-WALLET",
  "roundId": "round-001",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

Envie para `POST /wagering/transactions` com `Idempotency-Key: provider-a:bet-001`. O header é obrigatório; uma cópia de `idempotencyKey` no corpo HTTP é rejeitada. Na fila, a chave pertence a `data.idempotencyKey`.

### Semântica dos resultados

| HTTP | Significado | Ação do integrador |
|---|---|---|
| 200 | Transação processada ou replay; consultas concluídas | Conservar o resultado |
| 201 | Wallet criada | Conservar o ID |
| 202 | Referência ainda pendente | Consultar a transação; o worker já está responsável pelo retry |
| 400 | Contrato, moeda suportada, escala, referência obrigatória ou identificador inválido | Corrigir o pedido |
| 404 | Wallet/transação inexistente | Verificar o identificador |
| 409 | Wallet duplicada ou conflito de idempotência/inbox | Investigar a identidade; não reaproveitar uma key para outro negócio |
| 413 | Corpo HTTP acima do limite do parser | Reduzir o corpo |
| 422 | Regra de negócio rejeitada e persistida | Consultar `failureCode`; a mesma identidade permanecerá terminal |
| 500 com `status: FAILED` | Falha permanente auditada | Consultar o registro/DLQ; não esperar reaplicação da mesma identidade |
| 503 | Infraestrutura temporariamente indisponível | Reenviar a mesma key e o mesmo payload |

O replay de uma transação terminal devolve **o saldo observado quando aquela transação terminou**, mesmo se a wallet tiver sido movimentada depois. A mesma key com conteúdo diferente é conflito. Uma identidade `(providerId, externalTransactionId)` existente também não pode trocar sua key.

### Dinheiro e operações

Valores são strings decimais com exatamente duas casas, como `"25.00"`. As moedas suportadas são `BRL`, `USD`, `EUR` e `GBP`; operações entre moedas diferentes são rejeitadas. Na persistência usa-se `numeric(28,2)`; no domínio, centavos `bigint`.

- BET debita; WIN credita.
- LOSS registra resultado sem saldo, ledger ou incremento de versão. O valor não negativo pode ser informativo, inclusive `0.00`.
- REFUND exige uma BET processada e devolve seu valor integral.
- ROLLBACK inverte BET, WIN ou REFUND processada pelo mesmo valor integral.
- Referências de WIN/LOSS são opcionais; quando fornecidas, precisam resolver uma BET válida da mesma identidade e rodada.
- OPENING é interno e não é aceito por HTTP ou SQS.

A exclusividade de reversão é **por referência e tipo**, seguindo literalmente o enunciado. REFUND e ROLLBACK são tipos diferentes; a política e suas consequências estão detalhadas em [ARCHITECTURE.md](ARCHITECTURE.md).

## Mensagens SQS

Filas locais: `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`.

```json
{
  "messageId": "message-001",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-11-25T12:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "bet-001",
    "idempotencyKey": "provider-a:bet-001",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "SUBSTITUA-PELO-ID-DA-WALLET",
    "roundId": "round-001",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

No envio FIFO, utilize `MessageGroupId` por wallet e um `MessageDeduplicationId` de transporte. A proteção financeira permanece no PostgreSQL. A inbox usa o `messageId` do envelope, independentemente do ID atribuído pelo SQS.

A outbox publica eventos com `eventId` estável. Consumidores externos devem persistir sua deduplicação por `eventId`; mensagens podem se repetir ou chegar fora de ordem. `WalletBalanceChanged` também informa `walletVersion`.

## Carga e observabilidade

Com três APIs rodando:

```bash
LOAD_URLS=http://localhost:3000,http://localhost:3001,http://localhost:3002 \
LOAD_REQUESTS=1000 LOAD_CONCURRENCY=25 LOAD_WALLETS=20 \
bun run test:load
```

O script cria wallets próprias, envia apostas de `1.00 BRL`, repete a identidade anterior a cada quinto pedido, mede throughput HTTP/p50/p95/p99, taxa de erro, retries, conflitos e lag da outbox, e reconcilia todas as wallets. O resultado vai para `test-results/load-report.json`. O experimento executado para esta entrega está em [docs/LOAD_TEST_REPORT.json](docs/LOAD_TEST_REPORT.json); a interpretação fica em [VALIDATION.md](VALIDATION.md).

Logs de aplicação são JSON com contexto de correlação e identificadores. Valores financeiros completos, SQL, receipt handles e mensagens brutas de exceção são excluídos por allowlist. Métricas de transação são incrementadas somente após o commit.

## Estrutura

| Diretório | Responsabilidade |
|---|---|
| `src/domain/` | Money, agregados, ledger, inbox/outbox e eventos |
| `src/application/` | Contratos, caso de uso financeiro e consultas |
| `src/infrastructure/` | MikroORM, migrations, schema e configuração |
| `src/messaging/` | SQS, consumer, publishers, pending worker e shutdown |
| `src/http/` | Controllers, extensão de identidade e erros HTTP |
| `src/observability/` | Logs estruturados e métricas |
| `test/` | Unidade, integração real e concorrência entre processos |
| `scripts/` | Migrations, filas, demonstração e carga |
| `infra/` | Inicialização PostgreSQL e LocalStack |
| `docs/` | OpenAPI, exemplos HTTP, requisitos e relatório de carga |

Leituras de revisão: [ARCHITECTURE.md](ARCHITECTURE.md), [TESTING.md](TESTING.md), [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) e [VALIDATION.md](VALIDATION.md).

## Publicação no GitHub

1. Extraia o ZIP e coloque o **conteúdo de `jungle-gaming-solution/` na raiz do repositório**. `README.md`, `package.json`, `compose.yaml` e a pasta `.github/` devem estar diretamente nessa raiz. Inclua também `.gitattributes`, `.gitignore`, `.dockerignore` e os arquivos `.env.example` e `.env.test.example`.
2. Adicione os arquivos ao Git e preserve a permissão de execução do hook do LocalStack. Se a extração ou o sistema operacional não preservar essa permissão, depois de `git add .` execute:

   ```bash
   git update-index --chmod=+x infra/localstack-init.sh
   ```

3. Faça o commit e o push. Na aba **Actions**, confirme que o workflow **Financial correctness** concluiu com sucesso antes de enviar a entrega. Esse workflow executa a suíte em containers; sua presença no repositório, por si só, não é evidência de uma execução aprovada.
4. Compartilhe o link do repositório e garanta acesso ao avaliador. Se o repositório for privado, conceda o acesso solicitado pelo processo seletivo.

O ZIP é o pacote de distribuição: o repositório deve conter os arquivos extraídos. Publicar o código no GitHub não inicia a API; para executá-la, siga os comandos da seção **Comece aqui**.

## Referências técnicas

- [Enunciado oficial](https://github.com/junglegaming/backend-challenge) e [implementações de referência](https://github.com/junglegaming/backend-challenge/forks). A versão do enunciado usada na implementação está preservada em `docs/CHALLENGE.txt`.
- [MikroORM — Transactions and Concurrency](https://mikro-orm.io/docs/transactions).
- [PostgreSQL 17 — Explicit Locking](https://www.postgresql.org/docs/17/explicit-locking.html).
- [AWS SQS — Visibility Timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html).

O projeto contém uma implementação do desafio e evidências de execução. A suíte cobre os cenários documentados; ela não constitui garantia matemática de ausência de qualquer falha nem validação de um ambiente de produção não testado.
