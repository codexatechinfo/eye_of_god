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

## Consequências

- Testado ao vivo (JWT de teste): lista do Trilho com filtro "Ativo" mostrando ordem
  crescente de % (0%, 0%, 0%, 5%, 7%, 8%, 8%, 9%...); barra vermelha confirmada em 5% (classe
  `bg-red-500`); colaborador GUSTAVO FOGACA DOS SANTOS expandido mostrando badges `33d`/`32d`
  nos livros de leitura e nenhum badge nos de massiva. Tabela de detalhe (Monitoramento de
  Livros) com as duas colunas novas — "Prazo regulatório" com `—` ou número, "Progresso" com
  barra+% (43% em âmbar, batendo com 111/(111+145)); aba Massivas com "Progresso" mas sem
  "Prazo regulatório".
- Suíte de isolamento de tenant (12 testes) e build do Angular continuam passando.
