# ADR 0015 — Percentual de execução e dias do prazo regulatório, por colaborador e por livro

## Contexto

Três pedidos na mesma mensagem, todos girando em torno de duas métricas que já existiam
isoladas (nos cards de resumo) mas nunca tinham sido expostas no nível de linha/colaborador:

1. Barra de % de execução abaixo do nome de cada colaborador na lista do Trilho, e reordenar
   a lista pelos mais críticos.
2. Coluna de percentual de execução na tabela "Detalhe por livro" (Massivas e Monitoramento
   de Livros).
3. Informação de "dias do prazo regulatório" por livro, na lista "Livros de hoje" do Trilho
   e também nas tabelas de detalhe.

## Decisão

### Percentual de execução — sem mudança de backend

`digitados / (digitados + não digitados) × 100` já está disponível em toda linha/colaborador
que chega ao FRONTEND (`AtividadeColaborador.totalRealizadas/totalPendentes`,
`DetalheLinha.digitados/nao_digitados`) — os itens 1 e 2 são cálculo e apresentação, sem
tocar em nenhuma rota nem query nova.

- `colaboradores.service.ts` ganhou `percentualExecucao()` exportada (pura, reaproveitada
  pelo componente da lista e pela nova pontuação de ordenação).
- `massivas-view.ts` ganhou `percentualLinha()`/`corPercentual()`, e a coluna "Progresso" na
  tabela (barra + %) — nas duas abas, já que a conta é a mesma independente da fonte
  (leitura/releitura/massiva).
- Cores por faixa (mesmo padrão em ambos os lugares): ≥70% verde, 30–69% âmbar, <30%
  vermelho.

### Reordenar o Trilho pelos mais críticos

`pontuacaoDestaque()` já tinha 3 tiers (sem sincronismo > parado > ativo, ordenados do mais
grave pro menos grave) com `minutosParado` como critério dentro de cada tier — decisão
validada em sessões anteriores, não mexida nos tiers sem sincronismo/parado. Só o tier
"ativo" (quem está de fato executando hoje) passou a ordenar por percentual de execução
ascendente (menor % primeiro = mais crítico), com `minutosParado` como desempate secundário
dentro da mesma faixa de %. Os outros dois tiers continuam como estavam — percentual não
diferenciaria "parado" de qualquer forma (por definição, todo mundo parado está em 0%), e
"sem sincronismo" já reflete um problema mais grave (perda de comunicação) que não deveria
ser mascarado por quem simplesmente está com uma % mais alta.

### Dias do prazo regulatório — precisou de backend novo

Diferente do percentual, esse valor não existia calculado em lugar nenhum acessível por
livro — só como agregado nos 3 cards `<27/33/34+ dias` (ADR 0012 Adendo 4). Reaproveitada a
mesma fórmula (`dias_finais + (hoje − prazo_calendario)`, correspondência por número do
livro contra `prazo_reg_livros`, livro sem par = null/"não avaliado", nunca 0):

- **`massivasService.js` / `detalheContr()`**: passou a sempre incluir
  `EFETIVO_PRAZO_REG_SQL AS dias_prazo_regulatorio` no SELECT e sempre fazer
  `joinPrazoRegLivros()` (antes o join só entrava quando o filtro `faixaDias` estava ativo —
  ver ADR 0012 Adendo 5). Testado: 1638 linhas em 0.24s, sem impacto de performance
  perceptível por sempre juntar contra uma tabela de ~14k linhas via `livro::int`.
- **`atividadeColaboradoresService.js` / `listarAtividadeHoje()`**: como a query principal
  já processa todas as linhas cruas do dia (não é uma consulta deduplicada por livro como
  `detalheContr`), juntar `prazo_reg_livros` direto nessa query seria caro. Em vez disso, uma
  segunda consulta pequena (`obterMapaPrazoRegulatorio`) busca `livro → {diasFinais,
  prazoCalendario}` do mês corrente **uma vez só**, vira um `Map`, e o efetivo é calculado em
  JS (`calcularDiasPrazoRegulatorio`) na hora de montar cada `livros.push(...)` — mesma
  fórmula, só que sem JOIN por linha. Testado: resposta completa (292 colaboradores, ~1600
  livros com correspondência) em 1.7s, dentro do aceitável pra essa rota (já era a mais
  pesada da tela antes desta mudança).
- Só se aplica a leitura/releitura — livro de massiva nunca teve essa correspondência
  (mesma decisão de todas as ADRs anteriores sobre esse assunto); `diasPrazoRegulatorio`
  vem `null` pra esses.

### FRONTEND — onde aparece

- **Trilho, "Livros de hoje"**: badge `Nd` ao lado do badge de tipo (leitura/releitura),
  colorido pela mesma faixa dos cards (`<27` verde, `=33` âmbar, `>=34` vermelho); ausente
  quando `null` (sem correspondência, ou livro de massiva).
- **Tabelas de detalhe**: coluna "Prazo regulatório" só em `escopo === 'leiturarelitura'`
  (não existe pra massiva, mesma razão de sempre); `'—'` quando `null`.

## Adendo — releitura entrava incorretamente na conta; rural já ficava de fora, mas agora explícito

Usuário esclareceu: massiva, releitura e etapa rural (21-38) devem ficar **de fora** do
cálculo/contagem de prazo regulatório — só leitura urbana (01-19) conta.

Investigado antes de corrigir: `prazo_reg_livros.etapa` já só contém 01-19 na prática (0
linhas rurais nas ~270k combinações testadas), então o JOIN por número do livro nunca batia
com etapa rural — essa parte já estava correta, só não era uma regra *explícita*, dependia
de a planilha nunca ter tido etapa rural por coincidência. Já releitura era um problema real:
o JOIN é só por número do livro, sem olhar `tipoServico` — e o **mesmo** número de livro pode
aparecer como leitura numa consulta e releitura em outra (o livro já foi lido, depois voltou
como releitura). Confirmado contra dado real: dos ~1330 livros com correspondência no último
lote, 275 eram releitura — entravam incorretamente na conta de `<27/33/34+ dias`.

Corrigido embutindo a condição na própria expressão `EFETIVO_PRAZO_REG_SQL`
(`massivasService.js`), que agora só calcula o valor quando `TIPO_SERVICO_CONTR_SQL =
'leitura' AND ${ETAPA_URBANA_CONTR_SQL}` — fora disso, `NULL` explícito. Como a expressão é
compartilhada pelas três consumidoras (`obterFaixasDias`, `detalheContr`, e o equivalente em
JS de `atividadeColaboradoresService.js`), a correção propagou pras três de uma vez sem
precisar duplicar a regra: em `obterFaixasDias`, `NULL` cai fora do `WHERE faixa IS NOT
NULL`; em `detalheContr`, a linha continua aparecendo na tabela, só que com `—` na coluna
Prazo regulatório; em `atividadeColaboradoresService.js` (JS puro, não reaproveita a
expressão SQL), a mesma condição foi replicada manualmente (`tipoServico === 'leitura' &&
etapaUrbana`) antes de consultar o mapa.

Testado ao vivo (JWT de teste): faixas de dias caíram de 14/143/56 pra 14/7/2 (a maioria do
excesso em `igual33`/`maior34` era releitura); no detalhe, 0 linhas de `releitura` com
`dias_prazo_regulatorio` preenchido (era >0 antes), 1057 linhas de `leitura` continuam
corretas; na atividade do Trilho, 0 livros de releitura ou etapa rural com
`diasPrazoRegulatorio`, 1163 livros de leitura urbana continuam com o valor certo. Suíte de
isolamento de tenant (12 testes) e build do Angular continuam passando.

## Adendo 2 — destaque de cor no prazo, colaborador só-massiva classificado errado, ordem padrão por criticidade

Três pedidos numa mesma mensagem, com prints comparando o estado atual.

**1. Destaque de cor na coluna "Prazo regulatório".** Só os extremos chamam atenção: `>33`
dias (crítico, já passou da janela normal) em vermelho, `<27` dias (ainda folgado) em verde;
`27–33` fica neutro, de propósito — é a janela "normal" que não precisa de alerta.
`corPrazoRegulatorio(dias)` nova em `massivas-view.ts`, aplicada via `[ngClass]` na célula.

**2. Colaborador só-massiva com 0 executadas aparecia como "ativo".** Usuário reportou (print)
ALYSSON DIEGO DENIPOTI com `REALIZADAS: 0` mas sem o indicador de "parado". Bug real: no
ramo que cria uma entrada NOVA de colaborador (ADR 0013 — colaborador que só tem massiva,
sem nenhuma leitura/releitura hoje), `parado`/`ativo` estavam **fixos** em `false`/`true`,
independente de `digitadosMassiva`. Corrigido aplicando a mesma regra já usada pra
leitura/releitura (`parado = totalRealizadas === 0`, já validada) — `paradoMassiva =
digitadosMassiva === 0`. Só o ramo de entrada nova foi tocado; o ramo que mescla massiva num
colaborador que já existia (já tinha leitura/releitura hoje) não mexe nos booleans
`parado`/`ativo`/`semSincronismo` calculados antes da mescla — esses continuam refletindo só
a atividade de leitura/releitura, fora de escopo deste pedido.

**3. Ordem padrão da tabela pelos mais críticos, em qualquer filtro, nas duas abas.**
`linhasOrdenadas()` só ordenava quando o usuário clicava num cabeçalho de coluna — sem
coluna escolhida, a tabela ficava na ordem crua que o backend manda (`dt_prev_limite ASC`).
Trocado o caso "sem coluna" pra ordenar por `diasAtraso()` descendente (mais dias em atraso
primeiro — a única noção de atraso que as duas abas já calculam do mesmo jeito, ver
`corLinha()`/`diasAtraso()`), com `percentualLinha()` ascendente como desempate (entre dois
livros com o mesmo atraso, quem fez menos ainda é mais crítico). Continua valendo pra
qualquer combinação de filtro, já que é a ordem padrão aplicada sobre o resultado já
filtrado — só é substituída quando o usuário clica explicitamente num cabeçalho.

Testado ao vivo (JWT de teste): coluna Prazo regulatório com "34 dias" em vermelho
(`text-red-600 font-semibold`) ao filtrar pela faixa 34+; ALYSSON DIEGO DENIPOTI confirmado
via API com `{totalRealizadas: 0, parado: true, ativo: false}` (era `ativo: true` antes) e
visualmente com o destaque âmbar de "Parado" na lista; tabela sem nenhuma coluna ordenada
mostrando 12/9/8/6/6/6/6/6 dias de atraso em ordem decrescente. Suíte de isolamento de
tenant (12 testes) e build do Angular continuam passando.

## Adendo 3 — ordenação por criticidade em todos os tiers do Trilho; coluna "Recebido em" nas tabelas

Dois pedidos na mesma mensagem, com print mostrando o problema do primeiro.

**1. Ordenação por criticidade só valia no tier "ativo".** Usuário reportou (print) o filtro
"Sem sincronismo" com percentuais fora de ordem (1%, 14%, 26%, 13%, 3%, 48%...) e confirmou
que a lista sem filtro nenhum também não refletia a ordenação por criticidade. Causa: o
Adendo 1 só tinha mudado o `return` do tier "ativo" em `pontuacaoDestaque()`; os tiers "sem
sincronismo" e "parado" continuavam somando só `minutosParado`, sem o componente de
percentual. Corrigido calculando `criticidade = (100 - percentualExecucao) * 1000 +
minutosParado` **uma vez só** e somando o offset de cada tier em cima dela (`2_000_000 +
criticidade` pra sem sincronismo, `1_000_000 + criticidade` pra parado, `criticidade` sozinha
pra ativo) — os 3 tiers continuam na mesma ordem de gravidade de sempre (sem sincronismo >
parado > ativo), mas agora TODOS ordenam por percentual dentro do próprio tier, e a fórmula
deixou de ter 3 implementações ligeiramente diferentes pra ter 1 só reaproveitada. Em
"parado" isso não muda nada na prática (todo mundo tem 0% ali por definição — `totalRealizadas
=== 0` — então a parcela de percentual vira uma constante igual pra todos, e `minutosParado`
segue sendo o único critério que realmente diferencia), mas simplifica o código sem
precisar de caso especial.

**2. Coluna "Recebido em" nas duas tabelas de detalhe.** Dado já existia nas tabelas de
origem — `contr_execucao_leitura.data_recebimento`/`hora_recebimento` (leitura/releitura) e
`pendentes_im`/`atribuidas_im`/`em_execucao_im.dt_rec_abertura` (massiva, já vem como
"DD/MM/YYYY HH:MM" pronto). `detalheContr()`/`detalheMassiva()` (`massivasService.js`)
passaram a expor `data_recebimento` — pra leitura/releitura, concatenado em SQL
(`c.data_recebimento || ' ' || c.hora_recebimento`); pra massiva, `dt_rec_abertura` direto,
sem transformação. FRONTEND: coluna nova entre "Tipo" e "Data limite" (antes da coluna de
prazo, que é sobre quando o livro *vence*, não sobre quando foi *recebido*), com
`ordenarPor('dataRecebimento')` convertendo a string "DD/MM/YYYY HH:MM" pra epoch antes de
comparar (o formato brasileiro não ordena certo como string crua).

Testado ao vivo (JWT de teste): filtro "Sem sincronismo" com percentuais em ordem crescente
(1%, 0%, 1%, 2%, 3%, 5%, 5%, 6%...); lista sem filtro nenhum com os mesmos primeiros nomes
(o tier mais severo domina o topo, como sempre, só que agora também ordenado por %); coluna
"Recebido em" presente nas duas abas ("05/08/2026 06:38" em Livros, "20/08/2026 12:54" em
Massivas). Suíte de isolamento de tenant (12 testes) e build do Angular continuam passando.

## Adendo 4 — ordenação master de 3 tiers, substituindo a hierarquia por categoria

Usuário redefiniu a ordem master da lista do Trilho: "colaboradores com livros com mais de
33 dias e livros em execução com menos de 27 dias, depois críticos em percentual de
execução independente se é classificado como parado ou ativo ou sem sincronismo e por
último colaboradores sem serviços atribuídos". Isso substitui a hierarquia anterior (sem
sincronismo > parado > ativo, cada um ordenado por % dentro do próprio tier, Adendo 3) por
algo mais simples e diferente: **3 tiers**, e dentro do segundo, as três categorias somem
como critério de ordenação (viram um grupo só).

1. **Tier 1 — livro em prazo regulatório extremo.** `temLivroCritico()` nova em
   `colaboradores.service.ts`: verdadeiro quando o colaborador tem QUALQUER livro com
   `diasPrazoRegulatorio > 33` (não importa o status do livro — já estourou o prazo, é
   crítico de qualquer forma), OU algum livro **"Em Execução"** com `diasPrazoRegulatorio <
   27` (a assimetria é intencional: livro "Pendente" com `<27` é só o normal esperado, sem
   sinal de nada; livro que já está "Em Execução" mas ainda não chegou nos 27 dias efetivos é
   incomum o bastante pra merecer atenção). Mesmos limiares 27/33 já usados no destaque de
   cor da tabela de detalhe (Adendo 3 da ADR 0015).
2. **Tier 2 — todo mundo com atividade hoje, por % de execução.** Parado/ativo/sem
   sincronismo deixam de ser tiers separados aqui — um colaborador "parado" com % baixo
   (sempre 0%, por definição) pode aparecer misturado entre "ativos" com % também baixo, sem
   distinção por categoria. `minutosParado` continua desempatando dentro da mesma faixa de %.
3. **Tier 3 — sem serviço.** Sempre por último, incondicionalmente.

Os 4 toggles (Parado/Sem serviço/Ativo/Sem sincronismo) continuam filtrando exatamente como
antes (`categoriaDe()` intocada) — só a ORDEM mudou, e vale mesmo com um filtro de categoria
ativo: um colaborador "sem sincronismo" com livro crítico ainda aparece antes de outro "sem
sincronismo" sem livro crítico, dentro do próprio filtro.

Testado ao vivo (JWT de teste): lista sem filtro nenhum com ADAILSON PETRANSKI (7%) primeiro
— confirmado que ele tem o livro `021689` com `34d` (>33, dispara o tier 1) — seguido de mais
4 colaboradores também com livro crítico (25%/28%/30%/42%), depois o resto por %; com o
filtro "Sem sincronismo" ativo, os MESMOS 5 colaboradores críticos continuam no topo (prova
que a ordenação master prevalece dentro do filtro); últimos 5 da lista sem filtro nenhum são
todos "sem serviço" (sem barra de %). Suíte de isolamento de tenant (12 testes) e build do
Angular continuam passando.

## Consequências

- Testado ao vivo (JWT de teste): lista do Trilho com filtro "Ativo" mostrando ordem
  crescente de % (0%, 0%, 0%, 5%, 7%, 8%, 8%, 9%...); barra vermelha confirmada em 5% (classe
  `bg-red-500`); colaborador GUSTAVO FOGACA DOS SANTOS expandido mostrando badges `33d`/`32d`
  nos livros de leitura e nenhum badge nos de massiva. Tabela de detalhe (Monitoramento de
  Livros) com as duas colunas novas — "Prazo regulatório" com `—` ou número, "Progresso" com
  barra+% (43% em âmbar, batendo com 111/(111+145)); aba Massivas com "Progresso" mas sem
  "Prazo regulatório".
- Suíte de isolamento de tenant (12 testes) e build do Angular continuam passando.
