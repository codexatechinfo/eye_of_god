# ADR 0011 — Prazo real de leitura/releitura (calendário + SLA de releitura por hora)

## Contexto

Usuário perguntou se o atraso na aba "Monitoramento de Livros" já usava `calendario_leitura`
(por etapa+mês) e um SLA de 24h/48h (urbana/rural) sobre `data_recebimento` pra releitura.
Não usava — conferido no código: o prazo de leitura/releitura vinha direto da coluna
`data_prevista_limite` da própria linha de `contr_execucao_leitura`, comparado por **dia**
contra `data_import`. `calendario_leitura` só era usada pra massiva (`prazo_massiva`).
Confirmado com o usuário que a regra correta é:

1. **Leitura**: prazo é `calendario_leitura.prazo_leitura`, por etapa (comparando a coluna
   `etapa` com a etapa do calendário). Etapas 01–19 são urbanas, 21–38 são rurais.
2. **Releitura**: prazo é `data_recebimento` (+ `hora_recebimento`) `+ 24h` pra etapa urbana,
   `+ 48h` pra etapa rural — SLA por hora, não por calendário.

## Decisão

### `massivasService.js` — novas expressões SQL reaproveitáveis

- `TIPO_SERVICO_CONTR_SQL` — extraída da lógica que já existia (ADR 0006) espalhada em 3
  lugares (`detalheContr`, `historicoContrLivro` e, agora, também no cálculo de prazo), pra
  não manter 3 cópias da mesma regra.
- `ETAPA_NUM_CONTR_SQL` — `contr_execucao_leitura.etapa` **não vem limpo**: o scraper grava
  `"ETAPA 18 - (528)"` (número entre parênteses é uma contagem que varia a cada ciclo, não
  faz parte da etapa — confirmado no banco: 100% das ~317 mil linhas estão nesse formato,
  zero linhas com etapa "limpa"). Extrai só o número via regex, mesma ideia do parser já
  usado em `atividadeColaboradoresService.js` pro mesmo problema.
- `ETAPA_URBANA_CONTR_SQL` — `ETAPA_NUM_CONTR_SQL BETWEEN 1 AND 19`. Confirmado contra
  `calendario_leitura`: as etapas cobertas são exatamente 1–19 e 21–38 (sem etapa 20).
- `joinCalendarioContr()` — `contr_execucao_leitura` não tem coluna `mes_ref` própria (ao
  contrário das tabelas de massiva, que têm e por isso o `joinCalendario` original junta por
  `etapa + mes_ref` direto). O mês é inferido do mês de `data_prevista_limite` — conferido
  contra o banco que bate exatamente com `calendario_leitura.prazo_leitura` pra linhas de
  leitura (etapa 18, mês 2026-08: os dois lugares dão 26/08/2026).
- `PRAZO_RELEITURA_SQL` — `data_recebimento` + `hora_recebimento` (formato sempre `HH:MI`,
  sem segundos — conferido no banco) `+ 24h`/`+48h` conforme `ETAPA_URBANA_CONTR_SQL`.
- `PRAZO_LEITURA_SQL` — `calendario_leitura.prazo_leitura`, fim do dia (`23:59:59`) pra não
  expirar à meia-noite do próprio dia do prazo. Usada também pra linha ainda **pendente**
  (sem `data_recebimento`) — antes de receber, não há como saber se vai virar leitura ou
  releitura, então usa o mesmo prazo de leitura como referência.
- `PRAZO_CONTR_SQL` — `CASE` escolhendo entre as duas acima conforme `TIPO_SERVICO_CONTR_SQL`.
- `IMPORT_TS_CONTR_SQL` — "agora" pro cálculo é o momento do último scrape
  (`data_import`+`hora_import`, formato sempre `HH:MI:SS` — conferido), não o relógio real,
  mesmo padrão já usado em todo o resto do app.

`condicaoSqlPrazoContr(tipo)` reescrita pra comparar `PRAZO_CONTR_SQL` contra
`IMPORT_TS_CONTR_SQL`: `atrasada` agora é comparação de **timestamp completo** (a hora
importa pra releitura); `final`/`noPrazo` continuam por **dia** (mesmo dia do prazo / depois
do prazo), pra bater com os outros cards do app.

### Bug de fuso horário pego durante o teste

`to_timestamp()` do Postgres devolve `timestamp with time zone`; `to_date() + interval`
devolve `timestamp without time zone` — misturar os dois no mesmo `CASE` (a escolha entre
prazo de releitura e prazo de leitura) força um cast implícito. Além disso, e mais grave: o
driver `pg` do Node.js converte `timestamp without time zone` pro **fuso horário do processo
Node**, não UTC — testado com dado real, `"2026-08-13 23:59:59"` (hora "de parede", sem fuso)
virava `"2026-08-14T02:59:59.000Z"` no JSON (+3h, fuso de Brasília do host rodando o
backend). Um erro que só apareceria testando o **valor**, não bastaria a query rodar sem
erro de sintaxe.

Corrigido em duas frentes:
1. `::timestamp` explícito em `PRAZO_RELEITURA_SQL`/`IMPORT_TS_CONTR_SQL` (ambos usam
   `to_timestamp()`), garantindo que a comparação inteira seja `timestamp without time zone`
   dos dois lados, sem cast implícito ambíguo.
2. **Nunca deixar o driver serializar o valor.** `detalheContr` e `historicoContrLivro`
   formatam o prazo com `to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` (string ISO com `Z`
   explícito) em vez de devolver o timestamp cru — evita completamente a conversão de fuso
   do driver, e o `'Z'` deixa explícito pro FRONTEND (`new Date(...)`, Angular `date` pipe
   com `:'UTC'`) que o valor já é a "hora de parede" a ser exibida como está, sem conversão
   nenhuma.

### FRONTEND — `massivas-view.ts` também precisou de precisão de hora

`diasAtraso()`/`corLinha()` comparavam só por **dia** (truncavam hora pra meia-noite dos
dois lados) — consistente com o prazo antigo (por dia), mas incoerente agora que releitura
tem prazo por hora: uma linha podia contar como "atrasada" no card (cálculo do backend, hora
exata) e ainda aparecer verde/amarela na tabela (cor calculada no FRONTEND, só por dia).
Reescrito: `agoraMs()` (renomeado de `hojeUtcMs()`) agora inclui a hora do último scrape
(`resumo.horaImport`, campo que já existia mas não era usado nesse cálculo);
`prazoMs()`/`corLinha()` comparam timestamp completo pra decidir atraso (vermelho), e só
truncam por dia pra decidir "vence hoje" (amarelo) — mesma lógica de dois níveis que o
backend usa em `condicaoSqlPrazoContr`.

## Consequências

- Testado contra o banco real (não só que a query roda — o **valor**): releitura do livro
  033330 (recebido 21/08 17:55, etapa urbana) calcula prazo 22/08 17:55, batendo exatamente
  com o cálculo manual em SQL puro. Leitura das etapas 29/31/32 batendo exatamente com
  `calendario_leitura.prazo_leitura` (13/08, 16/08, 17/08). Resumo com filtro
  `leiturarelitura`: 638 no prazo / 503 prazo final / 195 atraso, somando certo com o total
  de 1577. Testado ao vivo no browser: card "Atraso" filtra e colore linhas de vermelho
  corretamente; popup de histórico do livro mostra o prazo sem deslocamento de fuso.
- Suíte de isolamento de tenant (12 testes) continua passando — não tocada por essa mudança,
  rodada de novo por garantia.
- **Linha "pendente" (sem `data_recebimento`) usa o prazo de leitura como referência** —
  decisão não explicitamente pedida pelo usuário, documentada aqui: antes de receber, a
  linha não tem como saber se vai virar releitura, então o prazo mais conservador (o de
  leitura) é o único calculável.
