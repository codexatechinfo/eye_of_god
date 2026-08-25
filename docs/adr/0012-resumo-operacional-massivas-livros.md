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
