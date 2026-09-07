# ADR 0036 — Nova aba "Monitoramento Colaborador"

## Contexto

Usuário pediu uma aba nova, "no modelo da aba Monitoramento de Livros" (mesma barra de resumo,
mesmo padrão de tabela com filtro embutido no cabeçalho — ver ADR 0035), mas com a tabela centrada
em COLABORADOR em vez de livro: nome, bateria, último registro de leitura; clicar na linha abre o
detalhe de execução do dia dele, com um botão "Ver no mapa".

## Decisão

### Sem MonitoramentoService — reaproveita ColaboradoresService inteira

Diferente das abas Livros/Massivas (que têm fonte própria — `contr_execucao_leitura`/tabelas de
massiva, via `MonitoramentoService` isolado por instância), esta aba não tem nenhuma fonte de dado
própria: colaborador, atividade de hoje, bateria (Scalefusion) e última UC realizada já são
exatamente o mesmo estado global que a aba Trilho usa (`ColaboradoresService`, singleton). A aba
nova só CONSOME esse estado — nenhuma chamada de rede própria, nenhum polling próprio.

Componente novo `MonitoramentoColaboradorView`, sem `providers` (ao contrário de
`MonitoramentoView`, que isola `MonitoramentoService` por instância) — não há filtro de
servidor pra isolar aqui.

### Filtros da tabela são LOCAIS, não os da barra lateral da aba Trilho

`ColaboradoresService` já tem `filtroRegional`/`filtroCargo`/`filtroColaborador` — mas esses
pertencem à barra lateral da aba Trilho (`FiltrosColaboradores`, dispara `buscar()` no servidor).
Reaproveitar os mesmos signals aqui faria um filtro aplicado nesta aba nova vazar pra aba Trilho (e
vice-versa) — os dois filtros são conceitos diferentes que por acaso têm nomes parecidos. A tabela
desta aba tem seus PRÓPRIOS signals (`filtroTabelaColaborador`/`filtroTabelaCargo`/
`filtroTabelaRegional`/`filtroTabelaCategoria`), filtrando client-side sobre `colaboradores()` (a
lista JÁ carregada, sem round-trip novo) — mesmo padrão de filtro embutido "estilo Excel" da ADR
0035 (componente `FiltroColuna`, reaproveitado direto, sem duplicar).

### Barra de resumo: mesmos 3 cards da esquerda, cards da direita trocados

"Agentes em campo"/"Comunicação"/"Progresso de atividades" são os MESMOS cálculos das abas Livros/
Massivas (código duplicado aqui de propósito — mesma convenção já usada no projeto pra pequenos
helpers, ver `hojeBr()` em vários arquivos do BACKEND — evita acoplar esta aba a
`MonitoramentoView`). "Progresso de atividades" aqui soma `totalRealizadas`/`totalPendentes` já
agregados de `AtividadeColaborador`, sem precisar iterar `livros` por tipo de serviço (esta aba não
distingue leitura/releitura/massiva).

Os cards da direita (Pendentes/Atribuídos/etc. + faixas de dias, nas abas Livros/Massivas) não
fazem sentido pra colaborador — substituídos pelos 5 status já usados no toggle da barra lateral da
aba Trilho (`CategoriaAtividade`/`OPCOES_CATEGORIA`/`categoriaDe`, todos reaproveitados de
`colaboradores.service.ts`, sem duplicar a lógica de classificação): Ativo/Parado/Sem
sincronismo/Sem serviço/Afastados. Clicáveis, filtram a tabela (`filtroTabelaCategoria`).

### Tabela "Detalhe por colaborador"

Uma linha por colaborador ATIVO (não só quem está em campo hoje — mesmo princípio da aba Livros,
que lista todo livro, não só os com atividade): Colaborador, Cargo, Regional, Bateria (Scalefusion,
`—` quando não há dado), Último registro de leitura (`data_import`+`hora_import` de
`localizacoes()`, mesma fonte da posição "por leitura" do mapa), Realizados/Pendentes, Progresso
(%), Status (badge da categoria). Ordenação por coluna e paginação client-side, mesmo padrão da ADR
0035.

### Clique na linha: reaproveita `app-colaborador-detalhe` direto, sem duplicar

`ColaboradorDetalhe` (o painel de timeline do dia já usado na aba Trilho) é inteiramente dirigido
por `colaboradoresService.colaboradorSelecionado()` — não depende de estar dentro da aba Trilho
especificamente. `abrirDetalhe(nome)` só chama `colaboradoresService.abrirColaborador(nome)` (mesmo
método que o clique no mapa já usa) e o componente `<app-colaborador-detalhe>`, incluído direto no
template desta aba nova, aparece sozinho — zero código de modal novo escrito.

Layout em duas camadas pra isso funcionar: a área rolável (resumo + tabela) fica num
`<div overflow-y-auto>` PRÓPRIO; `<app-colaborador-detalhe>` fica FORA dela, direto no wrapper
`relative h-full`. Sendo `position: absolute` (`inset-y-0 right-0`), se estivesse DENTRO da área que
rola, ele rolaria junto com o conteúdo (elemento absolute é arrastado pelo `overflow:auto` do
ancestral que é sua containing block) — o objetivo é o painel ficar fixo na borda direita da aba
enquanto a tabela rola por baixo, igual já acontece na aba Trilho (mesmo componente, mesmo
comportamento visual).

### "Ver no mapa" — botão novo em `ColaboradorDetalhe`, não só nesta aba

Em vez de um botão específico desta aba nova, o botão "Ver no mapa" foi acrescentado direto no
cabeçalho de `colaborador-detalhe.html` (ao lado do X de fechar) — funciona de qualquer lugar que
abra esse painel (esta aba nova, o modal "Agentes em campo" das abas Livros/Massivas, e a própria
aba Trilho, onde só re-centraliza sem trocar de aba). Reaproveita
`colaboradoresService.verNoMapa(nome)`, já existente.

## Verificação

- `npx tsc --noEmit` e `npx ng build --configuration production` limpos, mesmos avisos
  pré-existentes (budget de bundle, `leaflet` não-ESM).
- Layout de duas camadas (painel fixo + conteúdo rolável) verificado com o CSS real compilado do
  projeto numa réplica isolada: simulado scroll de 600px no conteúdo, posição do painel não mudou
  (`painel top ANTES: 322.0px` / `DEPOIS: 322.0px`) — confirma que `app-colaborador-detalhe` não
  rola junto com a tabela.
- Não foi possível testar visualmente no app real nesta sessão (sem credencial de login).

## Adendo 1 (2026-09-07) — aba reordenada + header em tema claro

Usuário: a aba nova tinha que ficar logo após Trilho (estava depois de Massivas), e a barra
superior inteira devia inverter pro tema claro (era escura, `bg-gradient-to-r from-slate-900
via-slate-800 to-slate-900`, texto branco/`slate-400`).

- Ordem das abas em `home.html`: Trilho, **Monitoramento Colaborador**, Monitoramento de Livros,
  Massivas, Importação.
- Header: `bg-white border-b border-slate-200 shadow-sm` no lugar do gradiente escuro. Aba ativa
  passa de `text-white`/`bg-white/10` pra `text-slate-900`/`bg-blue-50` (com borda azul clara);
  inativa de `text-slate-400` pra `text-slate-500` (hover `text-slate-900`). Overlay de hover no
  tema escuro usava branco translúcido (`bg-white/[0.06]`) — no claro passa a preto translúcido
  (`bg-slate-900/[0.04]`), mesma ideia invertida. Pílula de status (Coletando/Parada/Offline) e
  "Última importação" trocam de tons `400` (pensados pra contraste em fundo escuro) por `600`
  (contraste em fundo branco) — sem isso o texto ficaria claro demais pra ler. Botão "Sair" segue o
  mesmo padrão (fundo `slate-100` em vez de `slate-800/80`).
- Logo A2L: dois dos cinco `<path>` do SVG usavam `fill="#FFFFFF"` (as letras "A" e "L") —
  invisíveis em fundo branco. Trocado pra `#0F172A` (mesmo tom de `slate-900`); os acentos laranja
  (`#F28C28`) e azul (`#006DFF`) da marca não mudam.

### Verificação

Réplica estática com o CSS real compilado do projeto (mesmo header inteiro, `abaAtiva` fixado em
"colaborador" e status "coletando" pra renderizar todos os estados de cor de uma vez) — logo
legível, aba ativa destacada em azul claro na posição certa (logo após Trilho), pílula de status e
"Última importação" com contraste adequado no fundo branco. `npx tsc --noEmit` e `npx ng build
--configuration production` limpos.
