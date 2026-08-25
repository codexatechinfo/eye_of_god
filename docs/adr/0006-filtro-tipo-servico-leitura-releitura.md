# ADR 0006 — Filtro "tipo de serviço" (leitura/releitura/massiva) em Monitoramento de Livros

## Contexto

A tela "Monitoramento de Livros" (antiga "Massivas") só mostrava dado das 3 tabelas de
staging do scraper de massivas (`pendentes_im`/`atribuidas_im`/`em_execucao_im`). O usuário
pediu um filtro por tipo de serviço — leitura, releitura ou massiva — usando
`contr_execucao_leitura` (a mesma tabela que já alimenta a aba "Trilho") como fonte de
leitura/releitura.

## Decisão

### Duas dimensões independentes, definidas pelo usuário

- **Status** (`Pendente`/`Atribuída`/`Em Execução`) — pra massiva, continua vindo de qual
  tabela a linha está (como sempre foi). Pra leitura/releitura, vem da coluna `situacao` de
  `contr_execucao_leitura`, parseada com a mesma regex já usada em
  `atividadeColaboradoresService.js` (`^(Em Execução|Atribuída)\s*\(...-NOME\)$`, senão
  `Pendente`) — só que calculada em SQL (`STATUS_CONTR_SQL`/`LEITURISTA_CONTR_SQL` em
  `massivasService.js`).
- **Tipo de serviço** (leitura/releitura) — só a data manda, nada a ver com `situacao`:
  `data_recebimento <= data_prevista_limite` é leitura, `>` é releitura. Confirmado
  explicitamente com o usuário que as duas dimensões são independentes — um livro
  "Pendente" (sem `situacao` de execução) não tem relação nenhuma com ter ou não
  `data_recebimento` preenchida.
- Livro sem `data_recebimento` ainda simplesmente não bate nem em "leitura" nem em
  "releitura" quando esses filtros específicos estão ativos — só aparece quando o filtro
  está em "todos" (nenhuma condição de tipo aplicada).

### Arquitetura da consulta

`massivasService.js` passou a ter duas fontes:

- **Fonte massiva** (as 3 tabelas de sempre) — código quase inalterado.
- **Fonte leitura/releitura** (`contr_execucao_leitura`) — nova, com `DISTINCT ON (livro)`
  próprio (já é uma linha por livro; diferente da massiva, não precisa de dedup entre
  "tabelas" porque status vem tudo da mesma coluna).

Cada uma tem seu próprio "último lote" (`pendentes_im` vs `contr_execucao_leitura`, jobs
diferentes, horários de scrape possivelmente diferentes) — por isso `obterResumo`/
`obterDetalhe` buscam os dois lotes em paralelo e **somam em JavaScript**, não com um UNION
SQL gigante dinâmico. Decisão deliberada: um UNION cobrindo prazo/status/lote de duas
tabelas com esquemas bem diferentes ficaria muito mais difícil de revisar e testar do que
duas consultas simples somadas depois — o custo (uma query a mais quando o filtro é
"todos") é irrelevante pra um painel administrativo.

`obterHistoricoLivro` também virou uma junção das duas fontes, ordenada por data/hora real
(`Date`, não comparação de string — ver "bug encontrado" abaixo).

### Prazo (no prazo / prazo final / atraso)

Pra massiva, o prazo vem de `calendario_leitura.prazo_massiva` (join por etapa+mês). Pra
leitura/releitura, o próprio `data_prevista_limite` da linha já é o prazo — sem join,
comparado contra `data_import` (dia do scrape) do mesmo jeito que a massiva compara contra
`dt_import`.

## Bug encontrado e corrigido durante o desenvolvimento

`to_date(...)` no Postgres devolve um objeto `Date` pro driver `pg`. Uma primeira versão de
`historicoContrLivro` fazia `String(dataDoPostgres).split(' ')[0]` esperando um texto tipo
"2026-08-13 ..." — mas `String(new Date(...))` em JS produz
`"Thu Aug 13 2026 00:00:00 GMT+0000..."`, e o `split(' ')[0]` pegava **"Thu"** em vez da
data. Corrigido trocando `to_date(...)` por `to_char(to_date(...), 'YYYY-MM-DD')` nessa
consulta específica, devolvendo texto direto do Postgres. `detalheContr`/`detalheMassiva`
não tinham esse problema porque devolvem o `Date` cru pro JSON (que vira ISO string
automaticamente) e o FRONTEND usa o pipe `date` do Angular pra formatar — só
`historicoContrLivro` monta a string manualmente no lado do Node.

## Consequências

- Card "Total massivas" e os demais continuam com o mesmo nome/formato — agora representam
  o total do(s) tipo(s) de serviço ativo(s), não só massiva. Não renomeado a pedido
  específico algum; se ficar confuso na prática, é ajuste de rótulo, não de lógica.
- Tabela de detalhe ganhou uma coluna "Tipo" (badge leitura/releitura/massiva) — não pedido
  explicitamente, adicionado porque a lista fica ambígua sem isso quando o filtro é
  "todos" e mistura as três fontes.
- Testado via curl (números de leitura+releitura+massiva somam exatamente o total de
  "todos": 908+1703+469=3080) e ao vivo no browser (filtro muda a lista de etapas
  disponível, contagem de registros muda, badge de tipo aparece correto).

## Alternativas descartadas

- **UNION SQL único cobrindo as duas fontes** — descartado pela fragilidade de misturar
  join/prazo/lote diferentes numa consulta só; duas consultas simples somadas em JS é mais
  fácil de auditar linha por linha.
- **Constraint/índice novo em `contr_execucao_leitura` pra acelerar o filtro de tipo** — não
  necessário agora (volume atual não justifica); revisar se o filtro leitura/releitura
  ficar lento em produção.
