# ADR 0012 — Barra de resumo operacional (Agentes/Comunicação/Progresso/Faixas de dias)

## Contexto

Usuário pediu que as abas Massivas e Monitoramento de Livros trocassem os 7 cards atuais
(Pendentes/Atribuídas/Em Execução/Total/No Prazo/Prazo Final/Atraso) por um layout de
referência (print de outra tela) com: Agentes em campo (com quebra Moto/A pé/Na base),
Comunicação · 30 min, Progresso de atividades, e uma faixa de contadores por status/dias
em atraso (Pendentes/Atribuídos/Em Execução/Em Atraso/&lt;27 dias/33 dias/34+ dias).

Levou 3 rodadas de perguntas pra fechar a fonte de cada número — registrado aqui porque a
regra de negócio das faixas de dias em particular não é óbvia lendo só o schema.

## Decisão

### Agentes em campo / Comunicação / Progresso — dado já existente, sem tocar backend

Vêm inteiramente de `ColaboradoresService` (o mesmo serviço que a aba Trilho já usa) —
`MassivasView` passou a injetá-lo. Como `ColaboradoresService` é `providedIn: 'root'`
(diferente de `MassivasService`, que é por-instância desde a ADR 0010), é a mesma instância
que o Trilho usa: "agentes em campo" é uma métrica de colaborador, não muda conforme a aba
de massiva/livros aberta.

- **Em campo**: colaborador com cargo ≠ `MONITOR` **e** com atividade hoje em
  `contr_execucao_leitura` (`atividadeDe(nome)` não nulo — mesmo dado que already alimenta
  Ativo/Parado/Sem sincronismo no Trilho).
- **Moto / A pé**: dentro de "em campo", por `cargo` (`LEITURISTA MOTOCICLISTA` /
  `LEITURISTA`).
- **Na base**: cargo `MONITOR`, contado à parte (não soma em "em campo").
- **Comunicação · 30 min**: dentro de "em campo", `minutosParado < 30`. Limite **separado**
  do `LIMITE_PARADO_MINUTOS = 20` já usado pelo toggle Ativo/Parado/Sem sincronismo do
  Trilho — de propósito, pra não alterar um comportamento já validado por causa de um
  widget novo. Confirmado com o usuário: "é o mesmo conceito com limite/formato diferente".
- **Progresso de atividades**: soma de `totalRealizadas`/`totalPendentes` de todos os "em
  campo".

### Pendentes/Atribuídos/Em Execução/Em Atraso — mesma fonte de cada aba

Confirmado com o usuário: continuam vindo de `massivasService.resumo()` (`pendentes.livros`,
`atribuidas.livros`, `emExecucao.livros`, `atrasadas.livros`) — a mesma fonte que os cards
antigos já usavam (massiva numa aba, leitura/releitura na outra, via ADR 0006/0010/0011).
Nenhuma mudança de backend nesses quatro.

### Faixas &lt;27 / 33 / 34+ dias — nova, a partir de `prazo_reg_livros`

Tabela sem relação com `tipoServico` (não é massiva nem leitura/releitura) — um relatório à
parte, uma linha por livro por `mes_ref`, com `dias_finais` já calculado.

**A regra não é "dias em atraso ao vivo" direto — é um valor de referência ajustado pela
data de hoje.** `dias_finais` é o nº de dias entre a primeira leitura do livro e o prazo
regulatório (`prazo_calendario`) — um valor fixo por livro, gravado no import da planilha,
não recalculado a cada dia. Pra saber a situação de hoje, ajusta esse valor pela diferença
entre hoje e `prazo_calendario`: cada dia depois do prazo soma 1 a `dias_finais`, cada dia
antes subtrai 1.

```sql
dias_efetivos = dias_finais::int + (CURRENT_DATE - to_date(prazo_calendario, 'YYYY-MM-DD'))
```

Bucket: `< 27` / `= 33` (exatamente no limite regulatório) / `>= 34` (estourou). Os valores
27/33/34 não são arbitrários — refletem faixa de risco frente ao prazo regulatório de 33
dias entre leituras (a mesma noção de `calendario_leitura.prazo_regulatorio`, embora essa
query não a consulte diretamente).

`obterFaixasDias(db, filtros)` roda em paralelo com o resto de `obterResumo()`, filtra por
`mes_ref` do mês corrente e respeita `filtros.regional` quando presente (mesmo padrão dos
outros filtros da tela) — sem isso os números ficam bem maiores que uma visão de uma
regional só (testado: 11.504 livros sem filtro vs. 609 só em Umuarama).

### Template — cards substituídos, não somados

Confirmado com o usuário: a barra nova **substitui** os 7 cards antigos nas duas abas, não
convive com eles. "Total"/"No prazo"/"Prazo final" saíram de vez do template (a lógica de
`selecionarPrazo('noPrazo'|'final')`/`selecionarTotal()`/`totalCardEmDestaque()` que ficou
sem uso foi removida de `massivas-view.ts`; `selecionarPrazo('atrasada')` continua, é o
único prazo que sobrou visível).

## Adendo — ajustes de review

Usuário apontou 3 problemas comparando com o print de referência de novo:

1. **Título fora do print** ("Resumo de Massivas"/"Resumo de Leitura/Releitura" +
   "Dados de... às..."). Removido — o toggle Livros/Leituras ficou sozinho, alinhado à
   direita.
2. **Layout em duas seções, não numa linha só.** A primeira versão separava
   Agentes/Comunicação/Progresso (com `border-b`) dos contadores de status/dias, ficando
   "numa linha abaixo" em vez de tudo junto. Unificado num único `flex flex-wrap` com um
   divisor vertical (`w-px bg-slate-200`) entre os dois grupos, sem separação por borda
   horizontal.
3. **Painel estático — não atualizava sozinho, e o toggle Livros/Leituras não valia pras
   faixas de dias.** `MassivasService` só buscava `resumo()` no `ngOnInit` e em cliques de
   filtro; ganhou `setInterval` de 60s (mesmo padrão de `ColaboradoresService`), limpo em
   `ngOnDestroy` (service passou a implementar `OnDestroy`). `obterFaixasDias()` só contava
   linhas (sempre "livros"); passou a também somar `volume_de_leituras`, retornando
   `{livros, leituras}` por faixa como as outras contagens — `valorFaixa()` no FRONTEND
   aplica o mesmo toggle que `valorCard()` já aplicava nos outros contadores.

## Adendo 2 — barra nova só em Monitoramento de Livros, Massivas volta ao clássico

Usuário esclareceu que o pedido de redesign (anexo2 original) valia só pra
Monitoramento de Livros. A aba Massivas deveria "manter o visual" — os 7 cards clássicos
(Pendentes/Atribuídas/Em Execução/Total/No Prazo/Prazo Final/Atraso) e o título "Resumo de
Massivas", exatamente como eram antes deste ADR. Reaplicado: os 7 cards clássicos (e
`selecionarTotal()`/`totalCardEmDestaque()`, removidos no primeiro adendo) voltaram ao
template, agora atrás de `*ngIf="escopo === 'massiva'"`; a barra nova (Agentes em
campo/Comunicação/Progresso/faixas de dias) ficou atrás de
`*ngIf="escopo === 'leiturarelitura'"`. O título só aparece na aba Massivas — Monitoramento
de Livros continua sem título (pedido do adendo anterior, que era especificamente sobre
essa aba).

## Adendo 3 — Massivas ganha o visual novo de volta (com seus próprios dados), e filtros passam a persistir por aba

Terceira volta do usuário sobre a mesma tela: "quero as informações do anexo1 [os 7 cards
clássicos de Massivas] mas no visual do anexo2 [a barra de uma linha só do Adendo 2] usando
os resumos mas para as massivas". Ou seja, reverte só a parte VISUAL do Adendo 2 — as duas
abas voltam a compartilhar o mesmo layout de barra — mantendo os DADOS que cada aba sempre
mostrou (Massivas continua lendo `massivasService.resumo()` com os 7 contadores clássicos;
Monitoramento de Livros continua com Pendentes/Atribuídos/Em Execução/Em Atraso + faixas de
dias). Não é uma terceira mudança de fonte de dado, só de onde cada contador é desenhado.

Implementado como um único bloco `*ngIf="!carregando && !erro"` com Agentes em
campo/Comunicação/Progresso em comum (sempre os mesmos, não dependem de escopo — são
métrica de colaborador, ver seção acima), um divisor vertical, e dois `ng-container`
mutuamente exclusivos por `escopo` pros contadores: `massiva` renderiza os 7 badges
clássicos (mesmos métodos de sempre — `valorCard`, `selecionarTotal`/`totalCardEmDestaque`,
`selecionarPrazo`/`prazoCardEmDestaque` — só que como botões numa linha em vez de cards em
grid); `leiturarelitura` mantém os 4 status + 3 faixas de dias que já tinha desde o Adendo
2. O título ("Resumo de Massivas" + data/hora) saiu de vez — não fazia sentido nesse layout
de barra, e o pedido nunca mencionou querê-lo de volta.

Separadamente, usuário reportou "os filtros das abas estão se comunicando" — investigado ao
vivo (JWT de teste, checando `document.querySelectorAll('app-massivas-view').length`) e
**não havia vazamento de dado entre abas**: a arquitetura por-instância de `MassivasService`
(ADR 0010) já isola cada aba corretamente. O comportamento real era outro — cada aba
**reiniciava** o próprio filtro toda vez que o usuário saía e voltava a ela, porque
`home.html` usava `*ngIf` pra alternar as duas `<app-massivas-view>`, e `*ngIf` destrói e
recria o componente (e o serviço por-instância junto) a cada troca. Trocado por `[hidden]`
nos dois `<div>` que envolvem cada instância, com `*ngIf="abaAtiva() === 'livros' ||
jaAbriuLivros()"` controlando só a criação preguiçosa (a instância nasce na primeira vez que
a aba é aberta, e depois disso fica viva — só escondida — pelo resto da sessão). Confirmado
ao vivo: filtro Regional=Cascavel setado em Monitoramento de Livros sobrevive a uma
passagem pela aba Massivas e volta.

## Adendo 4 — faixas de dias contavam linha "órfã" de `prazo_reg_livros`; correção pra exigir correspondência real

Usuário pediu exemplo concreto de cada faixa (`<27`/`33`/`34+`) pra conferir se o cálculo
tinha sido entendido certo. Os três exemplos trazidos (livros `32407`, `22792`, `35164`)
não apareciam na busca "Buscar livro..." da própria tela — investigado e a causa raiz era
dupla: (1) `prazo_reg_livros.livro` é gravado **sem** zero à esquerda (`"24188"`, 5 dígitos),
enquanto `contr_execucao_leitura.livro` (fonte da tabela de detalhe) usa sempre 6 dígitos
com zero à esquerda (`"041481"`) — formatos incompatíveis pra busca direta; (2) mesmo
corrigindo o formato manualmente, 2 dos 3 exemplos (`032407`, `035164`) **não existiam** em
`contr_execucao_leitura` de jeito nenhum — a implementação original consultava
`prazo_reg_livros` sozinha (`obterFaixasDias` fazia `SELECT ... FROM prazo_reg_livros WHERE
mes_ref = ...`), contando **toda** linha da planilha do mês, sem checar se aquele livro
tinha alguma atividade viva no scraping.

Usuário esclareceu a regra correta: "prazo_reg_livros é apenas pra ser consultada, ela não
pode aparecer como resultado no painel — o livro em contr_execucao_leitura que vai ser
comparado com o livro de prazo_reg_livros e se encontrar correspondência que vai fazer o
que já lhe foi informado [a fórmula de dias_efetivos]". Ou seja: `prazo_reg_livros` é uma
tabela de **lookup**, nunca fonte de linhas por conta própria — o ponto de partida tem que
ser sempre o livro vivo em `contr_execucao_leitura` (o mesmo "último lote" usado no resto da
tela), e só entra em alguma faixa quando esse livro **também** tem uma linha correspondente
em `prazo_reg_livros` do mês corrente. Livro sem correspondência não conta como "0 dias" —
simplesmente não é avaliado, fica de fora de qualquer faixa.

`obterFaixasDias` reescrita: de `FROM prazo_reg_livros` solto para `FROM
contr_execucao_leitura c ... JOIN prazo_reg_livros p ON p.livro::int = c.livro::int AND
p.mes_ref = ...` (INNER JOIN, não LEFT — livro sem par simplesmente cai fora), com o mesmo
dedup por livro (`DISTINCT ON`, menor quantidade restante) e mesmo filtro de regional (via
`cidades_localidades`) que as outras contagens dessa tela já usam. `p.livro::int =
c.livro::int` em vez de comparar string, pra ignorar a diferença de zero à esquerda — os
dois lados são sempre numéricos, conferido contra as ~410 mil linhas das duas tabelas antes
de assumir isso (`livro !~ '^[0-9]+$'` = 0 em ambas). "Hoje" no cálculo de `dias_efetivos`
passou de `CURRENT_DATE` pra `c.data_import` (data do próprio lote de
`contr_execucao_leitura`) — mesmo princípio já usado em `IMPORT_TS_CONTR_SQL`/
`PRAZO_CONTR_SQL` no resto do arquivo: o "agora" do app é o momento do último scrape, não o
relógio real. `obterResumo` só chama `obterFaixasDias` quando há lote de leitura/releitura
(`ultimoBatchLeitura`) — faixas de dias nunca fez sentido pra escopo `massiva`, que já não
usa esse card no FRONTEND desde o Adendo 3.

Bug pego no processo: primeira versão do filtro de regional usou o offset de parâmetro
errado (`$3` fixo em vez de `$${parametros.length + 2}`, o mesmo padrão já usado em
`contarFonteContr`) — `?regional=CASCAVEL` quebrava com "could not determine data type of
parameter $3" no primeiro teste ao vivo. Corrigido pro mesmo padrão de offset do resto do
arquivo.

Números mudaram bastante com a correção: sem filtro, as faixas foram de 161/663/10680 (total
11.504 — contando toda a planilha do mês, órfã ou não) para 14/143/56 (total 213 — só livros
com atividade viva hoje E correspondência na planilha). A ressalva registrada nas
Consequências originais deste ADR ("34+ chega a 10.680, bem mais que o print de referência")
já apontava nessa direção — hoje fica confirmado: o excesso era de fato linha de
`prazo_reg_livros` sem contrapartida no scraping ativo, como a ressalva especulou.

Testado ao vivo (JWT de teste): sem filtro, API retornou 14/143/56 (a query isolada direto
no banco deu 14/144/57 — diferença de 1 esperada, job de coleta roda em paralelo em segundo
plano); com `regional=CASCAVEL`, 7/17/6, um subconjunto plausível do total. Confirmado
visualmente na aba Monitoramento de Livros. Suíte de isolamento de tenant (12 testes)
continua passando.

## Adendo 5 — faixas <27/33/34+ dias viram filtro clicável (aba Massivas já tinha o equivalente)

Usuário pediu: "adiciona na aba monitoramento de livros o filtro por prazo regulatório onde
vai filtrar os três casos do anexo1 [as faixas &lt;27/33/34+]" e "aba massivas também mas
para os do anexo2 [No Prazo/Prazo Final/Atraso]".

Conferido antes de implementar: **item 2 já existia.** Os badges No Prazo/Prazo Final/Atraso
da aba Massivas já são clicáveis desde a decisão original deste ADR (`selecionarPrazo()`/
`prazoCardEmDestaque()`) e já filtram a tabela de detalhe via `filtros.prazo` →
`condicaoSqlPrazo()` no backend — só reconfirmado ao vivo (clique em "Prazo final" levou a
tabela de 1068 pra 21 registros, batendo com o número do card) pra garantir que nada tinha
quebrado nas reformulações visuais recentes (Adendo 3). Nenhuma mudança de código nesse
ponto.

Item 1 era novo de verdade: as faixas &lt;27/33/34+ dias (aba Monitoramento de Livros) eram
só display (`valorFaixa()`, sem `onclick`) — sem capacidade nenhuma de filtrar a tabela.
Implementado o equivalente ao padrão já usado pros outros badges:

- `EFETIVO_PRAZO_REG_SQL`/`joinPrazoRegLivros()`/`condicaoFaixaDias(faixa)` extraídos como
  helpers reutilizáveis em `massivasService.js` — a mesma fórmula e o mesmo join que
  `obterFaixasDias()` (Adendo 4) já usa pra contar os cards, só que aqui o join é `LEFT` (não
  `INNER`): o filtro é opcional, então sem `faixaDias` selecionada o join não pode excluir
  nenhum livro; quando `preg` não casa, a expressão vira `NULL` e a condição
  (`efetivo < 27`, etc.) nunca é verdadeira, então o filtro só exclui quando de fato ativo.
- `detalheContr()` ganhou a condição via `filtros.faixaDias`, com o `LEFT JOIN
  prazo_reg_livros` só entrando na query quando esse filtro está presente (evita o join extra
  no caso comum, sem filtro).
- Rota `GET /massivas/detalhe` e `massivasController.detalhe` passaram a aceitar
  `faixaDias` como query string, valendo `menor27`, `igual33` ou `maior34`.
- FRONTEND: `MassivasService` ganhou `filtroFaixaDias` (signal) incluído em `montarParams()`
  e resetado em `limparFiltros()`; `MassivasView` ganhou `selecionarFaixa()`/
  `faixaEmDestaque()` (mesmo padrão de `selecionarPrazo()`/`prazoCardEmDestaque()`, mas
  **não** zera os outros filtros ao selecionar — faixa de dias é uma dimensão independente
  de status/prazo, não mutuamente exclusiva com eles); os três `<span>` das faixas viraram
  `<button>` com `(click)` e opacidade reduzida quando outra faixa está selecionada, igual
  aos demais badges da barra.

Testado ao vivo: clique em "34+ dias" (card mostrando 54) filtrou a tabela de "Detalhe por
livro" pra exatamente 54 registros; via API, o filtro com valor `menor27` retornou 14 linhas,
`igual33` 140 (card mostrava 143 — diferença de 3 esperada pelo job de coleta em paralelo
entre o momento do card e o da consulta detalhada), `maior34` 54 (card 56). Suíte de
isolamento de tenant (12 testes) e build do Angular continuam passando.

## Adendo 6 — prazo regulatório também como dropdown na barra de filtros

Usuário pediu pra levar os mesmos filtros do Adendo 5 (badges clicáveis) também pra dentro
da barra de filtros no topo da tela (junto de Regional/Etapa/Status/Tipo), em cada aba.

Implementado como dois `<select>` novos, condicionados por `escopo` (mesmo padrão do select
"Tipo", que já só aparece em `leiturarelitura`): um "Prazo regulatório" com `&lt;27 dias/33
dias/34+ dias` pra Monitoramento de Livros, outro com `No prazo/Prazo final/Atraso` pra
Massivas. Os dois ligam **no mesmo signal** que os badges clicáveis já usam
(`filtroFaixaDias`/`filtroPrazo`) — dropdown e badge ficam sincronizados sozinhos, sem
estado duplicado nem lógica nova: escolher no dropdown reflete no destaque do badge
correspondente (opacidade 1) e vice-versa, exatamente como Status já se comporta.

Testado ao vivo: selecionar "34+ dias" no dropdown (Livros) filtrou a tabela pra 53
registros e destacou o badge "34+ dias" (opacidade 1, os outros em 0.4); selecionar "Prazo
final" no dropdown (Massivas) filtrou pra 21 registros com o mesmo destaque no badge
correspondente. Suíte de isolamento de tenant (12 testes) e build do Angular continuam
passando — mudança só de template (FRONTEND), nenhum backend tocado.

## Adendo 7 — dropdown "Prazo regulatório" removido da aba Massivas

Usuário pediu pra remover o dropdown "Prazo regulatório" (No prazo/Prazo final/Atraso)
adicionado à barra de filtros da aba Massivas no Adendo 6. Removido o `<select
*ngIf="escopo === 'massiva'">` de `massivas-view.html`; o `<select *ngIf="escopo ===
'leiturarelitura'">` (faixas &lt;27/33/34+ dias, Monitoramento de Livros) não foi tocado —
o pedido mencionou só a aba Massivas.

Os badges clicáveis No prazo/Prazo final/Atraso na barra de resumo (que já existiam desde a
decisão original deste ADR, reconfirmados no Adendo 5) **continuam funcionando** — só o
controle redundante na barra de filtros de topo saiu. `filtroPrazo` (o signal por trás)
também não mudou; o dropdown só era mais uma forma de setá-lo, removê-lo não tira
funcionalidade nenhuma que não estivesse disponível pelo badge.

Testado ao vivo: aba Massivas com a barra de filtros voltando a ter só
Regional/Etapa/Status; badges No prazo/Prazo final/Atraso continuam clicáveis e filtrando a
tabela normalmente; aba Monitoramento de Livros com o dropdown de faixas de dias intacto.
Suíte de isolamento de tenant (12 testes) e build do Angular continuam passando — mudança só
de template, nenhum backend tocado.

## Adendo 8 — Monitoramento de Livros levando ~26s pra carregar: índice ausente + vazamento de transação

Usuário reportou (print, tela travada em "Carregando...") que a aba Monitoramento de Livros
"está demorando muito para apresentar os dados", com a coleta rodando normalmente ao lado.

### Diagnóstico

Medido direto via `curl` com JWT local (sem depender do navegador): `/massivas/resumo`
26,7s, `/massivas/detalhe` 25,9s, `/massivas/opcoes-filtro` 0,16s — isolando o problema nas
duas rotas que usam `joinPrazoRegLivros()` (Adendo 4 deste ADR tornou esse JOIN
incondicional). Confirmado rodando a query com e sem o JOIN direto no Postgres, fora da
camada HTTP: 26.408ms com, 360ms sem — ~73x de diferença, mesmo lote de dados.

Causa: `prazo_reg_livros` não tinha índice em `livro` (só `pkey` em `id` e um índice em
`empresa_id`). Como `preg.livro::int = c.livro::int` (necessário porque `contr_execucao_leitura.livro`
vem com zero à esquerda e `prazo_reg_livros.livro` não), nenhum índice b-tree comum na
coluna crua serve — precisa ser um índice funcional. Sem ele, o planner caía em nested loop
completo: ~2.032 linhas do lote × 13.880 linhas de `prazo_reg_livros` ≈ 28 milhões de
comparações.

### Correção

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prazo_reg_livros_livro_mesref
  ON public.prazo_reg_livros ((livro::int), mes_ref);
```

Rodado como `postgres` dentro do container `supabase-db` (`app_user` não é dono da tabela —
mesmo padrão já registrado nos ADRs de RLS deste projeto). `CONCURRENTLY` evita lock
exclusivo de escrita, mas precisa esperar toda transação aberta que referencia a tabela
terminar antes de validar o índice — o comando ficou mais de 60s rodando.

### Segundo bug encontrado no caminho: vazamento de transação em `anexarContextoTenant`

Investigando por que o `CREATE INDEX CONCURRENTLY` não terminava, `pg_stat_activity` mostrou
oito sessões em `idle in transaction`, várias com mais de 10 minutos — todas rastreáveis às
minhas próprias chamadas de diagnóstico (`curl` contra a query lenta). Causa raiz real, não
só efeito colateral do teste: `BACKEND/src/middlewares/authMiddleware.js` fechava a
transação em `res.on('finish', ...)`, evento que só dispara quando a resposta termina de ser
**enviada com sucesso**. Se o cliente desconecta antes disso (timeout do `curl`, aba
fechada, proxy) — exatamente o que acontece quando uma rota demora 26s — `finish` nunca
dispara, e a transação Postgres fica presa em `idle in transaction` indefinidamente,
segurando um snapshot MVCC vivo. Em produção isso seria um vazamento silencioso de conexões
a cada request lento ou abortado, e foi exatamente o que travou o `CONCURRENTLY` acima:
ele só valida depois que toda transação preexistente na tabela termina.

Corrigido trocando para `res.on('close', ...)`, que dispara nos dois casos (resposta
concluída ou conexão abortada), com `res.writableFinished` na condição de commit — só
commita se a resposta realmente terminou de ser enviada; qualquer desconexão no meio vira
rollback. Guard `fechado` evita fechar a transação duas vezes (já que `close` também dispara
após um `finish` normal).

Com o middleware corrigido, encerradas manualmente (`pg_terminate_backend`) as oito sessões
presas — todas leitura, sem risco de perda de dado — o que liberou o `CREATE INDEX
CONCURRENTLY` para terminar.

### Verificação

Índice confirmado via `pg_indexes` (`idx_prazo_reg_livros_livro_mesref` presente). `EXPLAIN`
da query com o JOIN passou a ter o índice disponível para o planner considerar; a
comparação com/sem JOIN no mesmo lote de dados não pôde ser refeita com números ao vivo
nesta sessão porque `contr_execucao_leitura` ficou vazia durante uma janela de
truncate/recarga da coleta (ela mesma reiniciada várias vezes pelo `nodemon`, por causa das
minhas próprias edições de arquivo durante a investigação — mesmo padrão do ADR 0017).
Validação end-to-end (`/massivas/resumo`/`/massivas/detalhe` via `curl` e a tela ao vivo)
fica pendente para o próximo ciclo de coleta completo.

## Consequências

- Testado ao vivo nas duas abas (JWT de teste local): números batendo com o que as queries
  isoladas retornaram direto do banco. Interatividade (clicar num contador filtra a tabela)
  confirmada, sem regressão.
- Suíte de isolamento de tenant (12 testes) continua passando.
- **Ressalva de escala**: sem filtro de regional, "34+ dias" chega a 10.680 de ~13.880
  livros no `prazo_reg_livros` do mês — bem mais que o print de referência do usuário (que
  parecia já estar com um regional selecionado). Isso é esperado dado o comportamento
  descrito (a maioria das linhas históricas tem `prazo_calendario` já passado, então
  `dias_efetivos` cresce), mas vale o usuário conferir com um filtro de regional aplicado se
  os números batem com o que ele espera ver — se não bater, o mais provável é a tabela
  `prazo_reg_livros` conter também livros já concluídos/fechados que deveriam ser excluídos
  do cálculo, o que exigiria uma coluna de status que ainda não foi mapeada.
- **Adendo 8**: índice funcional criado em `prazo_reg_livros`; vazamento de transação
  corrigido em `authMiddleware.js` (`anexarContextoTenant` agora usa `res.on('close', ...)`).
  Validação de timing end-to-end com dados reais pendente do próximo ciclo de coleta.
