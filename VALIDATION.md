# Relatório de validação da entrega

**Resultado final: 234 testes aprovados, 0 falhas e 1.055 assertions. Typecheck e build aprovados.** A aplicação compilada também foi iniciada em três processos independentes para executar a demonstração e o experimento de carga.

Data: **25 de novembro de 2026**. Os timestamps dos logs são UTC; a última medição de carga foi concluída às `04:24:31Z` (`01:24:31` em America/Sao_Paulo).

## 1. Ambiente usado

| Componente | Versão/configuração observada |
|---|---|
| Sistema | Linux x64, Debian 13 no ambiente de execução |
| Bun | 1.3.3 |
| TypeScript | 5.9.3, `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride` |
| NestJS | 11.1.9 |
| MikroORM | 6.5.9 |
| PostgreSQL | 17.12, binário dos pacotes Debian |
| LocalStack | Core 4.14.0, provider SQS real |
| Processos de aplicação | Três processos Bun/Nest independentes nos testes e na carga |
| Papel de banco na carga | `jungle_app`, sem superusuário |
| Binário da aplicação na carga final | `dist/main.js`, produzido por `bun run build` |
| Paralelismo disponível informado ao processo | 9; limites efetivos do executor não foram calibrados |

PostgreSQL e LocalStack rodaram como processos nativos e foram acessados por TCP/HTTP. Não foram substituídos por SQLite, banco em memória ou mocks nas suítes de integração e concorrência. Os doubles dos testes unitários de transporte controlam falhas pontuais e são complementados por essas suítes reais.

### Limitação de ambiente registrada

**Docker Compose e containers Docker não foram executados neste ambiente.** Os sockets Unix necessários ao Docker/containerd estavam bloqueados. O Compose, o Dockerfile, a inicialização das dependências e o workflow de CI foram preparados; o YAML foi analisado, mas isso não equivale à construção/execução de uma imagem Docker.

O comando para reproduzir o gate em containers está em README/TESTING:

```bash
docker compose --profile test run --build --rm tests
```

O workflow GitHub Actions incluído ainda precisa ser executado no repositório onde o projeto for publicado. Não há status de CI remoto presumido nesta entrega.

## 2. Gate final executado

Com PostgreSQL e LocalStack iniciados, bancos de teste separados e as variáveis de `.env.test.example` configuradas, foram executados:

```bash
bun run test
bun run build
```

`bun run test` encadeia typecheck, unidade, integração e concorrência. O log completo está em [docs/validation/test-run.log](docs/validation/test-run.log).

| Grupo | Testes aprovados | Falhas | Assertions | Duração registrada pelo Bun |
|---|---:|---:|---:|---:|
| Unidade e contratos de transporte | 185 | 0 | 658 | 6,23 s |
| Integração financeira, HTTP, schema, migrations e SQS | 44 | 0 | 331 | 8,67 s |
| Concorrência com processos independentes | 5 | 0 | 66 | 7,16 s |
| **Total** | **234** | **0** | **1.055** | **22,06 s nas suítes** |

A duração não inclui a instalação de dependências, a inicialização de PostgreSQL/LocalStack, o typecheck, o build, a demonstração nem a carga. O bundle contém 31 módulos; as dependências npm permanecem externas, conforme o comando de build.

## 3. Resultados financeiros e de concorrência comprovados

| Cenário | Resultado exigido e observado |
|---|---|
| Wallet aberta com saldo positivo | OPENING, crédito no ledger e eventos no mesmo commit; versão 1 |
| Wallet aberta em zero | Sem lançamento artificial; primeiro movimento na versão 2 |
| Cinquenta envios simultâneos da mesma BET entre três APIs | Um único débito, mesmo ID e 49 replays |
| Duas BET de 80.00 contra saldo 100.00 | Uma processada, uma rejeitada; saldo 20.00 e um débito |
| Outra wallet enquanto uma está bloqueada | B conclui enquanto A aguarda row lock observado no PostgreSQL |
| Replay após outros movimentos/reinício | Saldo histórico original preservado |
| Payload divergente para a mesma key | Conflito sem movimento adicional |
| Outra key para identidade externa existente | Conflito explícito |
| REFUND/ROLLBACK fora de ordem | Pendência persistida, retomada após referência/restart e um único efeito |
| WIN/LOSS com referência antes da BET | Esperam a referência em vez de ignorá-la |
| Reversão sem saldo para debitar | REJECTED auditável com código diferente de BET sem saldo |
| Reversão rejeitada, depois nova tentativa válida com outra identidade | A rejeição não ocupa exclusividade de reversão processada |
| LOSS positivo informativo ou zero | Sem alteração do saldo, versão ou ledger |
| Conflito de moeda/identidade e overflow | Rejeição persistida e sem movimento financeiro |
| SQL direto tentando corromper saldo/ledger/estado/evento | PostgreSQL rejeita por constraint, trigger ou permissão |
| Papel de runtime restrito | Processa operação válida e não altera/trunca ledger nem desabilita triggers |
| Migrations | Up idempotente, down completo e novo up utilizável, em banco separado |
| Paginação | Cursor assinado mantém o limite superior da primeira página apesar de novos lançamentos |

As wallets tocadas pelos cenários financeiros e de concorrência são reconciliadas ao final. Reconciliação recompõe o saldo usando os lançamentos persistidos, com uma única consulta SQL e snapshot consistente.

## 4. Falhas, commit, ACK e publicação

- Uma exceção depois das escritas, mas antes do commit, reverte wallet, transação, ledger, inbox e outbox.
- Outra conexão não enxerga os efeitos/eventos antes do commit.
- Um SQLSTATE `40001` provocado no PostgreSQL exige retry com estado de domínio novo e produz um único débito.
- Um processo encerrado com SIGKILL **antes do commit** deixa a operação reaplicável após restart, sem fatos parciais.
- Um worker encerrado com SIGKILL **depois do commit e antes do ACK** recebe redelivery real e não reaplica o débito.
- Um publisher encerrado com SIGKILL **depois do envio ao SQS e antes da confirmação na outbox** é recuperado com o mesmo eventId.
- Dois publishers/processos publicam eventos confirmados; um proprietário antigo não consegue confirmar uma linha cujo lease foi substituído.
- DLQ indisponível não autoriza apagar uma mensagem inválida da fila original.
- Retries esgotados de comando identificável geram FAILED auditável antes do encaminhamento à DLQ, quando o banco está disponível.
- Heartbeats deliberadamente retidos em testes controlados não sobrescrevem o backoff nem a devolução de visibilidade durante shutdown.

Os testes de publicação verificam os envelopes recebidos no SQS e a identidade persistida da outbox. A entrega continua at-least-once; o projeto não afirma exactly-once no broker. Consumidores externos devem deduplicar eventId de forma persistente.

## 5. Contrato HTTP e documentação

Foram exercitados HTTP 200/201, 202, 400, 404, 409, 413, 422 e 503. O 503 foi provocado por um lock real mantido no PostgreSQL, seguido de retry válido. JSON malformado, corpo excessivo, money inválido, UUID/cursor inválido e header ausente não deixam efeitos financeiros parciais.

A especificação OpenAPI 3.1 foi validada estruturalmente. Ela contém 10 paths, 23 schemas e 116 referências internas; 26 exemplos foram verificados contra seus schemas. `docs/requests.http` reúne 26 requisições manuais de demonstração e diagnóstico. Nenhuma chamada desse arquivo é enviada automaticamente ao ser aberto.

## 6. Experimento de carga executado

Resultado bruto: [docs/LOAD_TEST_REPORT.json](docs/LOAD_TEST_REPORT.json).

O experimento usou três processos da aplicação compilada, 25 requisições concorrentes e 20 wallets novas. Cada operação única foi uma BET de `1.00 BRL`; cada wallet começou com `1000000.00 BRL`. A cada quinto pedido, a identidade do pedido anterior foi repetida. Criação das wallets e consulta inicial de métricas ficaram fora do intervalo de medição.

| Medida | Resultado |
|---|---:|
| Requisições HTTP | 1.000 |
| Operações únicas processadas | 800 |
| Replays | 200 |
| Erros | 0 |
| Taxa de erro | 0% |
| Duração do intervalo HTTP | 1,434 s |
| Vazão HTTP observada | 697,49 requisições/s |
| p50 | 26,65 ms |
| p95 | 95,79 ms |
| p99 | 131,71 ms |
| Conflitos SQL contabilizados no intervalo | 0 |
| Retries contabilizados no intervalo | 0 |
| Maior lag da outbox observado durante a medição | 1,24742 s |
| Eventos ainda pendentes ao terminar o intervalo HTTP | 1.492 |
| Wallets reconciliadas e com saldo esperado | 20 de 20 |

### Interpretação e limite da medição

O HTTP responde após o commit financeiro; a publicação da outbox é assíncrona. Por isso havia 1.492 eventos pendentes ao terminar o intervalo HTTP. Depois da medição, a validação aguardou os publishers e confirmou **zero eventos pendentes no banco de carga**. Essa conclusão está no último registro `delivery_validation_complete` do log.

A vazão acima mede requisições HTTP, incluindo replays. Não é a vazão de publicação/consumo de eventos e não representa capacidade de produção. Foi uma única execução curta, em infraestrutura local; não há intervalo estatístico de confiança, teste de longa duração, calibração de recursos nem extrapolação para outra máquina. A implementação mantém as evidências para que o experimento seja repetido com outro volume e ambiente.

## 7. Escopo não executado ou não implementado

- Execução dos containers/Compose e do workflow remoto de CI: não executada neste ambiente.
- Integração com IdP/OIDC: deliberadamente não ativada, conforme opção aceita no enunciado; o ponto de extensão existe.
- Partidas dobradas, OpenTelemetry e dashboard: diferenciais opcionais não implementados.
- Ambiente de produção, credenciais AWS reais e carga sustentada: fora desta validação.

O relatório descreve os cenários efetivamente observados e as limitações conhecidas. As decisões de negócio adicionais, inclusive exclusividade de reversão por tipo, estão em ARCHITECTURE.md.
