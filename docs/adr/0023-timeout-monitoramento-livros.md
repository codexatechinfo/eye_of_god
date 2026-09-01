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

## Adendo 1 — mesma aba quebrando de novo, causa diferente: `calendario_leitura.mes_ref` malformado

Usuário reportou com print a aba "Monitoramento de Livros" mostrando "Não foi possível carregar
os dados de massivas"/"...a tabela de massivas" — texto errado por si só (a mensagem, herdada
de `MassivasService`, sempre dizia "massivas" mesmo no escopo `leiturarelitura`) — mas o próprio
erro sendo exibido já indicava algo real quebrado, não só cosmético.

**Mensagem corrigida primeiro**: `massivas.service.ts#buscarResumo`/`buscarDetalhe` passam a
escolher "massivas" ou "livros" com base em `this.escopo` (já guardado no service desde
`iniciar()`, um `MassivasService` por `<app-massivas-view>` — `providers: [MassivasService]`,
não singleton, confirmado que não vaza entre as duas abas).

**Causa raiz do erro em si**: reproduzido chamando `obterResumo(db, { tipoServico:
'leiturarelitura' })` direto contra o banco (mesmo padrão desta ADR) —
`date/time field value out of range: "31/07/2026"`, disparado em `contarFonteContr`
(`massivasService.js:405`). Rastreado ao `LEFT JOIN calendario_leitura` de
`joinCalendarioContr()`: `to_date(cal.mes_ref, 'YYYY-MM-DD')` — mas 37 das 111 linhas de
`calendario_leitura` (etapas 01-38, aparentando ser o lote de um mês novo — `prazo_leitura`
delas vai de 31/08 a 27/09/2026) têm `mes_ref = '31/07/2026'`, formato `DD/MM/YYYY`, não
`YYYY-MM-DD`. Parsear isso com o formato errado estoura o range de dia/mês válido e derruba a
consulta inteira (não só a linha malformada).

`calendario_leitura.mes_ref` é a ÚNICA coluna de data do schema de importação que foge do
padrão — todo o resto é texto livre `DD/MM/YYYY` (mesmo formato que o scraper grava), e
`importacaoService.js#extrairLinhas` converte QUALQUER célula de Excel formatada como data pra
essa mesma string via `toLocaleDateString('pt-BR')` (comentário original: "se a célula do Excel
estiver formatada como data... senão quebra os `to_date(...)` do resto do app" — escrito
pensando no padrão geral, não na exceção de `mes_ref`). Se a célula de `mes_ref` na planilha
importada estava formatada como data no Excel, essa conversão universal grava DD/MM/YYYY numa
coluna que o resto do código (`joinCalendarioContr`, `joinCalendario`, `PRAZO_LEITURA_SQL`)
sempre tratou como YYYY-MM-DD — inconsistência de formato entre o pipeline de importação
(uniforme) e essa coluna específica (exceção não tratada). Não investigado se foi exatamente
esse o mecanismo desta importação específica (não há log de qual arquivo foi importado quando)
— fica como hipótese mais provável, não confirmada.

**Correção (código, defensiva)**: `cal.mes_ref ~ '^\d{4}-\d{2}-\d{2}$'` acrescentado à condição
do `LEFT JOIN` em `joinCalendarioContr()` E `joinCalendario()` (mesma tabela, mesmo risco nos
dois pontos de uso) — mesmo padrão já usado em `buscarEventosLeitura`/`obterJornadaColaborador`
(ADR 0025) pra formato de data malformado: uma linha de `calendario_leitura` com `mes_ref`
inválido simplesmente não casa no `LEFT JOIN` (prazo/faixa de dias saem `null` só pro livro
daquela etapa/mês), em vez de derrubar a consulta inteira.

**Correção dos dados**: usuário perguntou "é do mês 07 ou 09?" antes de decidir. Confirmado
comparando com os dois lotes já corretos — `mes_ref = 2026-07-01` só tem `prazo_leitura` de
julho, `mes_ref = 2026-08-01` só tem `prazo_leitura` de agosto (mês de `mes_ref` sempre bate com
o mês dos prazos daquele lote); o lote malformado tem `prazo_leitura` quase todo em setembro
(01/09 a 27/09, mais duas linhas em 31/08 — mesma virada de mês que já aparece nos lotes
corretos). Confirma que era o lote de setembro, "31/07/2026" não bate com nada (nem é julho por
completo). Usuário decidiu **apagar** as 37 linhas em vez de corrigir pra `2026-09-01` ("não sei
como foram parar aí") — `DELETE FROM calendario_leitura WHERE mes_ref !~ '^\d{4}-\d{2}-\d{2}$'`,
37 linhas removidas, 74 restantes (37 julho + 37 agosto), 0 malformadas. Setembro fica sem
calendário até uma reimportação correta — aceito pelo usuário, não é bug, é ausência de dado que
ainda não existe.

### Verificação

- `npm test` (12/12), `node --check`, `ng build --configuration development` limpos
- `obterResumo(db, { tipoServico: 'leiturarelitura' })`: antes da correção, erro fatal; depois,
  `735ms`, sem erro
- `obterDetalhe(db, { tipoServico: 'leiturarelitura' })`: antes, transação abortada (efeito
  colateral do erro anterior na mesma transação); depois, `163ms`, `77` linhas
- Depois do `DELETE` das 37 linhas malformadas: `calendario_leitura` com 74 linhas (0
  malformadas), `obterResumo`/`obterDetalhe` continuam OK (`757ms`/`186ms`, `83` linhas) — a
  guarda de formato no código não fica órfã, continua valendo pra qualquer importação futura com
  o mesmo problema
- Não verificado visualmente no navegador (mesma limitação de sempre, sem credencial de login)

## Adendo 2 — causa raiz de verdade corrigida: `importacaoService.js` convertia data errado pra esta tabela

Usuário reportou com print, numa sessão seguinte: reimportou o calendário de setembro pela aba
Importação e `mes_ref` voltou a gravar errado (`31/08/2026` em vez de `2026-09-01`) — mesmo
sintoma do Adendo 1, confirmando ao vivo a hipótese que tinha ficado em aberto lá ("não
investigado se foi esse o mecanismo desta importação específica").

**Causa raiz**: `importacaoService.js#extrairLinhas` converte QUALQUER célula do Excel
formatada como data pra string `DD/MM/YYYY` (`valor.toLocaleDateString('pt-BR')`), igual em
TODAS as colunas de TODAS as tabelas — regra certa pra quase toda coluna de data do schema
(mesmo padrão que o scraper grava), errada pra `calendario_leitura.mes_ref`, que o resto do
código sempre tratou como `YYYY-MM-DD` (`to_date(cal.mes_ref, 'YYYY-MM-DD')`). A guarda de
formato do Adendo 1 evita o crash quando isso acontece, mas não corrige o dado — o usuário
reimportou depois daquele fix e caiu na mesma armadilha de novo, porque a causa (a conversão
em si) continuava lá.

**Correção**: `extrairLinhas` ganhou um terceiro parâmetro opcional, `colunasDataIso` — quando a
coluna da célula está nessa lista, formata como `YYYY-MM-DD` (função nova `formatarDataIso`,
usando componentes LOCAIS do `Date`, não `toISOString()`, que converte pra UTC e pode voltar um
dia) em vez do `DD/MM/YYYY` padrão. `importarArquivo` repassa `config.colunasDataIso` do
`CONFIG_IMPORTACAO` da tabela. **Achado no caminho, ao investigar**: não é só `mes_ref` — antes
de propagar o fix, verificado no código todo lugar que faz `to_date(cal.<coluna>, ...)` pra
achar quais outras colunas de `calendario_leitura` também esperam ISO:
`PRAZO_LEITURA_SQL` (`to_date(cal.prazo_leitura, 'YYYY-MM-DD')`) e as condições de prazo de
massiva (`to_date(cal.prazo_massiva, 'YYYY-MM-DD')`) — `prazo_leitura` e `prazo_massiva`
também precisam de ISO, mesmo problema, só não tinham aparecido ainda porque a guarda de
`mes_ref` do Adendo 1 já filtrava a linha inteira do `LEFT JOIN` antes de `PRAZO_LEITURA_SQL`
chegar a rodar contra elas. `calendario_leitura.colunasDataIso` em `importacaoConfig.js` agora
lista as 3: `['mes_ref', 'prazo_leitura', 'prazo_massiva']`. As outras colunas de data da
tabela (`prazo_regulatorio`, `envio_releitura`, `prazo_releitura`, `envio_massiva`,
`vencimento_fatura`, `envio_leitura`, `prazo_leitura_fimm`) nunca aparecem em nenhum
`to_date(...)` no código — não mexidas, ficam no padrão DD/MM/YYYY por não ter evidência
contrária.

**Dado já gravado errado, corrigido direto no banco**: as 37 linhas do lote de setembro (as
mesmas do Adendo 1, apagadas ali a pedido do usuário e reimportadas por ele depois — a
reimportação caiu no mesmo bug, já que o `importacaoService.js` ainda não tinha sido corrigido
naquele momento) — `mes_ref` atualizado pra `'2026-09-01'`; `prazo_leitura` (37 linhas) e
`prazo_massiva` (19 linhas, nem toda etapa tem prazo de massiva) convertidas de `DD/MM/YYYY`
pra `YYYY-MM-DD` via `to_char(to_date(..., 'DD/MM/YYYY'), 'YYYY-MM-DD')`, só nas linhas que
batiam o padrão malformado (defesa contra converter duas vezes).

### Verificação

- `node --check` nos dois arquivos alterados (`importacaoService.js`, `importacaoConfig.js`),
  `npm test` (12/12)
- Teste de ida e volta real: `.xlsx` em memória (ExcelJS) com `mes_ref` como célula de data de
  verdade (não string) — grava `YYYY-MM-DD` corretamente; célula de data numa coluna QUE NÃO
  está em `colunasDataIso` (`prazo_leitura` no primeiro teste, `vencimento_fatura` no segundo)
  continua `DD/MM/YYYY`, confirmando que a exceção é por coluna, não global
  — segundo teste cobrindo as 3 colunas ISO de uma vez (`mes_ref`, `prazo_leitura`,
  `prazo_massiva`) + 1 coluna de controle fora da lista, todas corretas
- `obterResumo`/`obterDetalhe` testados depois da correção dos dados — `621ms`/`139ms`, sem
  erro
- Não verificado visualmente no navegador (mesma limitação de sempre, sem credencial de login)
