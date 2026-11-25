# Testes e validação

A suíte verifica dinheiro exato, regras financeiras, constraints, HTTP, SQS, falhas e concorrência entre processos. Os testes de integração e concorrência usam **PostgreSQL e LocalStack reais**. Os testes unitários do transporte usam doubles para controlar pontos específicos, acompanhados de testes reais que verificam commit, redelivery, DLQ e publicação.

**Resultados finais, contagens, duração e comandos efetivamente executados estão em [VALIDATION.md](VALIDATION.md).** Este documento descreve como reproduzir os testes e quais garantias cada grupo verifica; a existência de um teste não deve ser confundida com o registro de sua execução.

## 1. Executar o conjunto em containers

Na raiz do projeto, com Docker Compose disponível:

```bash
docker compose --profile test run --build --rm tests
```

O serviço `tests` configura Bun, variáveis de teste, PostgreSQL, LocalStack e um banco distinto para o roundtrip das migrations. O comando executa typecheck, unidade, integração e concorrência. As aplicações usadas pelos cenários de múltiplos processos são iniciadas pela própria suíte.

Para diagnosticar uma falha das dependências:

```bash
docker compose logs --no-color postgres localstack
```

O workflow `.github/workflows/ci.yml` executa o mesmo comando em GitHub Actions e captura logs das dependências em caso de falha. O workflow só tem resultado depois de efetivamente rodar no repositório; não há resultado de CI remoto presumido nesta entrega.

## 2. Executar com Bun no host

Instale Bun 1.3.3 e as dependências fixadas pelo lockfile:

```bash
bun install --frozen-lockfile
```

Para unidade e validação de tipos, não é necessário iniciar PostgreSQL/SQS:

```bash
bun run typecheck
bun run test:unit
```

Para integração e concorrência, inicie as dependências locais e copie o exemplo de configuração:

```bash
docker compose up -d postgres localstack
cp .env.test.example .env.test
set -a
. ./.env.test
set +a
bun run test:integration
bun run test:concurrency
```

O exemplo acima carrega explicitamente as variáveis de teste no shell; confirme que os valores de `.env.test` apontam para os bancos de teste. Para executar tudo:

```bash
bun run test
```

As variáveis essenciais estão em `.env.test.example`:

| Variável | Uso |
|---|---|
| `NODE_ENV=test` | Permite hooks de falha exclusivos de teste |
| `ALLOW_INTEGRATION_TESTS=1` | Ativa explicitamente as suítes que escrevem nas dependências |
| `DATABASE_URL` e `TEST_DATABASE_URL` | Mesmo banco financeiro de testes, com nome terminado em `_test` |
| `APP_DATABASE_URL` | Mesmo banco usando a role restrita `jungle_app` |
| `MIGRATION_DATABASE_URL` | Banco separado, terminado em `_migration_test` |
| `SQS_ENDPOINT` | LocalStack acessível aos testes e seus subprocessos |
| Credenciais AWS e região | Credenciais locais `test` e região `us-east-1` |

Os helpers recusam executar integração sem opt-in e sem o sufixo de banco esperado. O teste de migration também recusa usar o mesmo banco da suíte financeira.

Para evitar interferência entre execuções independentes, use bancos/filas próprios para cada execução ou rode a sequência padrão. Os testes criam players, identidades e filas isolados com UUIDs. Não truncam o ledger para preparar o próximo cenário. O teste que chama `down` atua somente no banco descartável de migrations.

## 3. Organização da suíte

| Arquivo | Evidência exercitada |
|---|---|
| `test/unit/money.test.ts` | Precisão, escala, limite de NUMERIC, entradas inválidas, imutabilidade e moedas |
| `test/unit/wallet-ledger.test.ts` | Saldo não negativo, versões, vínculo com o lançamento e aritmética do ledger |
| `test/unit/wager-transaction.test.ts` | Kinds, referências, reversões, LOSS informativo e estados terminais |
| `test/unit/contracts.test.ts` | Contratos estritos, hash canônico, normalização e separação da key |
| `test/unit/messages-events.test.ts` | Envelopes tipados, estado de inbox/outbox e cópias defensivas |
| `test/messaging/consumer.test.ts` | Classificação de erros, ordem DLQ/ACK, heartbeat e backoff controlados |
| `test/integration/financial.test.ts` | PostgreSQL real, domínio aplicado, idempotência, atomicidade, schema, role restrita e HTTP real |
| `test/integration/migrations.test.ts` | Up idempotente, down, remoção de funções/triggers e novo up utilizável |
| `test/integration/messaging.test.ts` | LocalStack real, inbox, retries, DLQ, publicação, lease/fencing e crashes |
| `test/concurrency/processes.test.ts` | Três APIs independentes, races, locks por wallet, reinícios e dois publishers |

A reconciliação é feita para as wallets tocadas nos cenários financeiros. Nas suítes de aplicação, ela não é substituída por uma comparação de dois valores retornados pelo mesmo método: a consulta recompõe o saldo a partir dos lançamentos persistidos.

## 4. Cenários que exigem processos e dependências reais

### Concorrência financeira

A suíte de processos inicia três executáveis Bun de `src/main.ts`, confirma PIDs distintos e aguarda `/health/ready`. Distribui cinquenta requisições simultâneas da mesma BET entre as três APIs: exige um ID persistido, um débito e replays para as duplicatas.

No cenário obrigatório de 100.00 contra duas BET de 80.00, exige uma PROCESSED, uma REJECTED por saldo insuficiente, saldo final 20.00 e exatamente um lançamento de débito. Repetir ambas não pode mudar esse resultado.

O teste de isolamento mantém um row lock na wallet A, confirma uma conexão esperando por lock no PostgreSQL e prova que uma operação em B termina antes da liberação de A. Essa observação verifica ausência de serialização global entre wallets.

### Falhas em pontos críticos

| Hook ou cenário | Verificação |
|---|---|
| Exceção antes do commit | Wallet, transação, ledger, inbox e outbox revertem juntos |
| `TEST_CRASH_BEFORE_COMMIT=1` | Processo sofre SIGKILL; uma nova instância consegue aplicar o mesmo comando uma vez |
| `TEST_CRASH_AFTER_COMMIT=1` | Worker morre antes do ACK; a mensagem real reaparece e não reaplica o débito |
| `TEST_CRASH_AFTER_PUBLISH=1` | SQS aceita o evento; outro publisher recupera a outbox com o mesmo eventId |
| Falha de publicação | Evento confirmado continua durável e outro publisher retoma |
| Troca do proprietário do lease | Publisher antigo não consegue marcar a publicação |
| DLQ indisponível | A mensagem inválida não é apagada da fila de entrada |
| Referência fora de ordem e reinício | REFUND e ROLLBACK pendentes são resolvidos depois, sem duplicação |

Os hooks exigem `NODE_ENV=test` e não são parâmetros de requisição HTTP. O teste de crash verifica o término do processo; não equivale apenas a lançar uma exceção e continuar no mesmo worker.

Os cenários de integração também consultam a inbox, o ledger e a outbox persistidos. Na publicação, o que se preserva entre tentativas é o eventId: a deduplicação FIFO pode ocultar uma entrega repetida dentro da janela do broker, por isso a identidade persistida e o lease são inspecionados diretamente.

### Schema e migrations

A suíte tenta executar SQL que criaria saldo negativo/NaN, mudança de saldo sem lançamento, lançamento adulterado, mutação de resultado terminal, evento inconsistente e duplicação de identidades. O banco precisa rejeitar esses caminhos.

Há um teste específico com `jungle_app`: processa uma operação válida e comprova que a role não consegue atualizar/truncar o ledger nem desabilitar os triggers. O teste de `up → down → up` usa exclusivamente o banco de migrations e depois cria/reconcilia uma wallet para comprovar que o schema reconstruído funciona.

## 5. Determinismo e diagnóstico

Os testes usam polling com prazo para readiness, publicação e recuperação, em vez de presumir que um processo estará pronto após uma pausa fixa. A disputa de lock usa uma barreira explícita. Portas efêmeras são alocadas para as APIs; stdout e stderr dos subprocessos são drenados para impedir bloqueio por buffers cheios. Os processos são encerrados ao final de cada cenário.

Quando um teste falha, inspecione primeiro o erro da assertion e os logs da dependência. `failureCode` descreve decisões de negócio; SQLSTATE distingue violações de constraints e conflitos transitórios. As identidades de teste são novas a cada execução, por isso fatos financeiros de uma rodada anterior não precisam ser apagados.

Migrations precisam ser aplicadas por uma credencial administrativa de teste; o teste de permissões usa a credencial restrita separadamente. Não execute o roundtrip de migrations contra a base normal da aplicação.

## 6. Ambiente efetivamente disponível nesta entrega

O ambiente de validação disponibilizou PostgreSQL **17.12**, LocalStack Core **4.14.0** e Bun **1.3.3**. PostgreSQL e o provider SQS do LocalStack foram executados nativamente, com conexões TCP e requisições reais. A execução de Docker/containerd estava bloqueada pela política de Unix sockets do executor.

Consequentemente, a execução nativa das suítes não deve ser apresentada como uma execução do Compose. O projeto inclui a orquestração e o workflow para reproduzir a validação em containers em um ambiente que permita Docker. [VALIDATION.md](VALIDATION.md) registra o que foi executado e o que não foi.

Não se substituiu PostgreSQL por SQLite, banco em memória ou mock, nem se substituiu a integração SQS por um fake local. Os doubles unitários coexistem com testes reais e servem para controlar falhas específicas de transporte.

O teste de carga opcional é exposto por `bun run test:load`. Uma medição só deve ser interpretada junto de ambiente, volume, metodologia, latências, erros e lag; nenhum número de vazão é uma promessa de capacidade para outra máquina.
