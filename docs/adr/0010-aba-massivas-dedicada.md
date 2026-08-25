# ADR 0010 — Aba Massivas dedicada; Monitoramento de Livros só leitura/releitura

## Contexto

A [ADR 0006](0006-filtro-tipo-servico-leitura-releitura.md) uniu massiva, leitura e
releitura numa aba só ("Monitoramento de Livros") com um filtro "tipo de serviço". Usuário
pediu pra desfazer essa fusão na tela: uma aba "Massivas" nova, se comportando como a aba
original antes da ADR 0006 (só massiva, sem seletor de tipo); e "Monitoramento de Livros"
passa a mostrar só leitura/releitura — massiva nunca mais aparece lá.

A lógica de backend da ADR 0006 (duas fontes somadas em JS, não UNION SQL) continua válida
e não mudou — só a composição de fontes ativas por tela é diferente agora.

## Decisão

### Backend

`fontesAtivas(tipoServico)` em `massivasService.js` ganhou um valor novo,
`'leiturarelitura'`, que ativa leitura+releitura e exclui massiva — sem tocar nos 4 branches
existentes (`massiva`/`leitura`/`releitura`/`todos`). Nenhuma outra mudança de backend: o
resto de `massivasService.js` já era agnóstico de quais fontes estão ativas.

### Frontend — uma service por aba, não uma global

`MassivasService` guardava filtro num signal por instância, mas era `providedIn: 'root'` —
um singleton só. Com duas abas usando o mesmo componente (`MassivasView`) simultaneamente
disponíveis na árvore de rotas (ainda que só uma renderizada por vez via `*ngIf`), um
singleton faria o filtro de uma aba vazar pra outra a cada troca. Corrigido tirando
`providedIn: 'root'` e adicionando `providers: [MassivasService]` no `@Component` de
`MassivasView` — cada `<app-massivas-view>` ganha sua própria instância, destruída e
recriada do zero toda vez que a aba sai/entra de `*ngIf` (comportamento aceito: perder
filtro ao trocar de aba é esperado, igual às outras abas do app).

O fetch automático que rodava no `constructor` do service foi removido — corria antes do
`@Input() escopo` do componente estar disponível, então sempre buscava com o valor padrão
errado. Criado `iniciar(escopo)`, chamado pelo componente em `ngOnInit` (depois que
`@Input()` já resolveu), que trava o filtro de tipo nesse escopo e só então busca.
`limparFiltros()` agora volta pro escopo da aba, não pro genérico `'todos'` (que incluiria
massiva na aba de leitura/releitura).

### `MassivasView` ganhou `@Input() escopo: 'massiva' | 'leiturarelitura'`

- `escopo="massiva"` (aba Massivas): sem seletor de tipo no template, sem coluna "Tipo" na
  tabela — igual à tela original antes da ADR 0006, já que não há mais mistura de fontes
  pra desambiguar.
- `escopo="leiturarelitura"` (aba Monitoramento de Livros): seletor de tipo com só 3 opções
  (`Tipo · todos` → `leiturarelitura`, `Leitura`, `Releitura`) — sem `Massiva`. Título e
  rótulo do card "Total" mudam de "Massivas" pra genérico, já que a aba não é mais só
  massiva.

### Reorganização das chaves internas de aba (`home.ts`)

A chave interna `'massivas'` apontava pra aba "Monitoramento de Livros" desde a renomeação
de rótulo da [ADR anterior](0005-importacao-de-planilha.md) (só o texto mudou, a chave
não). Como agora existe uma aba "Massivas" de verdade, manter a chave antiga criaria
ambiguidade real (`'massivas'` != aba Massivas). Renomeado: `'massivas'` (antiga) →
`'livros'`; `'massivas'` (chave) passa a ser a aba nova. `'monitoramento'` (Trilho) não
mudou.

## Consequências

- Testado ao vivo (JWT de teste local, sem senha real): aba Massivas mostra "Resumo de
  Massivas", sem seletor de tipo, sem coluna Tipo, 1313 registros só de massiva. Aba
  Monitoramento de Livros mostra "Resumo de Leitura/Releitura", seletor com 3 opções (sem
  Massiva), coluna Tipo presente, badges de tabela só `leitura`/`releitura` (nunca
  `massiva`). Suíte de isolamento de tenant (12 testes) continua passando — não foi tocada
  por essa mudança, mas rodada de novo pra garantir.
- Cards da aba Trilho (lista de colaboradores + painel de detalhe do livro) também
  mudaram nesse ciclo: cor única (azul) em vez de uma cor por card, degradê ainda mais
  discreto (opacidade 20%, era 40%). Fora de escopo desta ADR (é ajuste visual, não de
  dado/arquitetura), registrado só no CHANGELOG/timeline.

## Alternativas descartadas

- **Manter tudo numa aba só com o filtro de tipo** (comportamento da ADR 0006) — descartado
  porque o usuário explicitamente quis abas separadas de novo.
- **`MassivasService` continuar `providedIn: 'root'` com um campo de escopo mutável** —
  descartado: um singleton mutável compartilhado entre duas abas é exatamente o tipo de
  estado-global-disfarçado que causa bug de "filtro vazando" difícil de reproduzir; instância
  por componente resolve isso estruturalmente, sem precisar lembrar de resetar nada na troca
  de aba.
