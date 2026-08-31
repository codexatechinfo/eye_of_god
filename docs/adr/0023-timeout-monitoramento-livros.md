# ADR 0023 — Timeout de 8-11 minutos na aba Monitoramento de Livros

## Contexto

Usuário reportou a aba "Monitoramento de Livros" presa em "Carregando..."/"Carregando
tabela..." sem nunca terminar. A aba "Massivas" (mesmo componente `app-massivas-view`, escopo
diferente) continuava funcionando normalmente — sinal de que o problema era específico do
código exclusivo do escopo `leiturarelitura` (leitura+releitura, `contr_execucao_leitura`), não
algo global.

## Diagnóstico

Sem conseguir reproduzir pela UI (login fora do alcance da automação), reproduzido chamando
`obterResumo`/`obterDetalhe` (`BACKEND/src/services/massivasService.js`) direto contra o banco,
fora do HTTP. Confirmado ao vivo: `obterResumo(db, { tipoServico: 'leiturarelitura' })` **nunca
retornava** — travado além de 20s, depois além de 30s mesmo isolado.

`SELECT * FROM pg_stat_activity` revelou o quadro completo: várias sessões reais (da aplicação
já rodando, sendo usada pelo usuário) presas de **8 a 12 minutos**, todas executando a mesma
query (a de `contarFonteContr`), mais duas sessões "idle in transaction" órfãs de scripts de
diagnóstico anteriores desta própria sessão que tinham sido interrompidos por `timeout` sem
chegar ao `finally`/`pool.end()`. As sessões travadas bloqueavam inclusive um `CREATE INDEX
CONCURRENTLY` novo (que precisa esperar transações abertas terminarem). Todas eram `SELECT`
(sem risco de perda de dado) — encerradas com `pg_terminate_backend()` pra liberar o banco antes
de seguir a investigação.

### Causa raiz, camada 1 — índice faltando

`contr_execucao_leitura` (871 mil linhas) não tinha nenhum índice em `(data_import,
hora_import)` — exatamente as colunas usadas por `contrDedupSql()` pra isolar o lote mais
recente antes de deduplicar por UC (mesmo padrão/comentário já documentado no próprio arquivo:
"a tabela não tem índice que ajude uma deduplicação global, mas cada lote tem só uma fração das
linhas" — só que esse índice nunca chegou a existir). Sem ele, cada chamada varria a tabela
inteira. `contarFonteContr`/`obterFaixasDias` são chamadas ~8 vezes por requisição
(`Promise.all` de pendentes/atribuídas/emExecução/total/noPrazo/prazoFinal/atrasadas/faixasDias)
— sequencialmente, porque todas correm no mesmo client/transação de `abrirContextoTenant`, não
em conexões paralelas. Corrigido com o mesmo padrão já usado antes (ADR 0021 Adendo 5):

```sql
CREATE INDEX CONCURRENTLY idx_contr_execucao_leitura_empresa_data_hora
  ON contr_execucao_leitura (empresa_id, data_import, hora_import);
```

`empresa_id` primeiro, seguindo o padrão do projeto pra índice em tabela com RLS.

### Causa raiz, camada 2 — a real, a que explica os 8-11 minutos

O índice sozinho **não resolveu**: a mesma query, isolada, continuava travando. `EXPLAIN` (sem
`ANALYZE`, só o plano) revelou o problema de verdade: o planner do Postgres estima a saída do
`DISTINCT ON` de `contrDedupSql()` como **1 linha** — chute genérico do planner pra esse tipo de
subquery, não uma estatística real. A saída real do lote mais recente, medida ao vivo: **13.054
linhas**. Com a estimativa errada em 4 ordens de grandeza, o planner escolhe **Nested Loop**
pros dois `LEFT JOIN` seguintes (`cidades_localidades`, 657 linhas; `calendario_leitura`, 74
linhas) — Nested Loop é ótimo pra 1 linha externa, catastrófico pra 13 mil (~13.054 × 731
comparações de tupla, por chamada, 8 chamadas por requisição).

Confirmado isolando a mesma query com `SET LOCAL enable_nestloop = off` (força Hash Join, que
não depende da estimativa de cardinalidade pra ser rápido nesse caso): **8-11 minutos → 624ms**
numa chamada isolada; a suíte completa de `obterResumo`/`obterDetalhe` caiu pra 3-6s (ainda
serializado num client só, mas sem travar).

## Decisão

`SET LOCAL enable_nestloop = off` no início de `obterResumo` e `obterDetalhe`
(`massivasService.js`, função `desligarNestedLoop`) — vale só pra transação da requisição atual
(criada por `anexarContextoTenant`, sempre dentro de `BEGIN`), não vaza pra outras requisições
nem para outras queries do sistema. Alternativas descartadas:

- **Reescrever a query pra ajudar o planner a estimar certo** — a estimativa de cardinalidade de
  `DISTINCT ON` sobre subquery com filtro de regex/data é uma limitação conhecida do otimizador
  do Postgres, não um problema de estatística desatualizada (`ANALYZE` não teria corrigido isso).
  Reescrever pra contornar isso de forma robusta exigiria materializar o resultado em uma tabela
  temporária real antes dos `JOIN`s — mais invasivo, sem ganho sobre a correção direta.
- **Índice pra ajudar os `JOIN`s** — `cidades_localidades` (657 linhas) e `calendario_leitura`
  (74 linhas) já são pequenas o bastante pra Hash Join ser trivialmente rápido; o problema nunca
  foi a falta de índice nos dois lados do `JOIN`, foi a escolha errada de ALGORITMO de junção.

## Verificação

- Reproduzido e corrigido contra o banco real, chamando `obterResumo`/`obterDetalhe` fora do
  HTTP (mesmo padrão de verificação já usado nesta sessão pra outras features)
- `tipoServico` testado em todos os 5 valores (`massiva`, `leitura`, `releitura`, `todos`,
  vazio) depois da correção — todos entre 1.5s e 6s, nenhum trava
- `npm test` (12/12) continua passando
- `node --check` no arquivo alterado
- Sessões órfãs de teste encerradas (`pg_terminate_backend`), banco confirmado sem sessão
  parada depois da correção
- Verificação visual na aba real (login) não foi feita nesta sessão — mesma limitação de sempre
  (não digita senha em nome do usuário); a reprodução direta contra o banco é o que prova o
  travamento e a correção aqui.
