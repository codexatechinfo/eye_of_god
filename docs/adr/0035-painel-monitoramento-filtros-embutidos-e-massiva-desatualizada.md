# ADR 0035 — Painel Monitoramento de Livros/Massivas: filtros embutidos na tabela, "Agentes em campo" por aba, coleta de massivas desatualizada e fix de importação de `prazo_reg_livros`

## Contexto

Usuário mandou uma rodada de 6 pedidos sobre a tela de Monitoramento de Livros/Massivas
(`monitoramento-view.ts`/`.html`), com prints anotados de referência:

1. Os números da barra de resumo ("Agentes em campo"/"Comunicação") deviam ser independentes por
   aba — Monitoramento de Livros já estava certo, mas Massivas contava qualquer colaborador com
   atividade hoje, não só quem tinha massiva atrelada.
2. Clicar no card "Agentes em campo" devia abrir um modal com todos os agentes daquela aba, nome +
   bateria + tempo sem sincronizar + botão "Ver no mapa".
3. Card "Progresso de atividades" da aba Massivas mostrava 0/0 — usuário queria saber por quê.
4. Filtros (Regional/Livro/Etapa/Colaborador/Status/Tipo/Prazo regulatório), até então numa barra
   separada acima da tabela, deviam ficar embutidos no cabeçalho da própria tabela (um controle por
   coluna) e clicar no valor de Regional/Leiturista numa linha deveria filtrar por aquele valor —
   nas duas abas.
5. O bloco "UCs do livro" no modal de histórico do livro devia sumir, mantendo só a timeline.
6. Coluna "Prazo regulatório" vinha sempre "—" — usuário queria a causa e a correção.

## Investigação (itens 3 e 6)

Nenhum dos dois era bug de cálculo — os dois eram dado faltando/malformado no banco, confirmado
direto contra o Postgres antes de qualquer mudança de código:

- **Item 3**: `obterUltimoBatchMassiva` (mesmo padrão de `obterUltimoBatchLeitura`) pega o lote mais
  recente por `id`, não por "hoje" — e o último `id` de `pendentes_im`/`atribuidas_im`/
  `em_execucao_im` era de **04/09/2026 18:00:38**, três dias antes de 07/09/2026 (data da
  investigação). A coleta de massivas (`coletaMassivasJob.js`, loop de 5s) parou de gravar dado
  novo havia dias — `progressoContagens()` no FRONTEND soma só livros com `tipoServico === 'massiva'`
  da atividade de HOJE de cada colaborador (`atividadeColaboradoresService.js`), e sem coleta hoje
  essa lista vem genuinamente vazia. 0/0 estava matematicamente certo dado esse dado parado.
- **Item 6**: `EFETIVO_PRAZO_REG_SQL` exige `prazo_reg_livros.mes_ref` batendo exatamente com o mês
  corrente (`to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM-DD')` = `'2026-09-01'`) — de
  propósito, porque número de livro se repete todo mês com rota diferente (ADR 0032). A tabela só
  tinha `mes_ref` de agosto: `'2026-08-01'` (13.880 linhas, formato certo) e `'31/08/2026'` (13.892
  linhas, formato ERRADO — mesmo bug já corrigido em `calendario_leitura`/`colunasDataIso`, mas que
  nunca tinha sido replicado pra `prazo_reg_livros`: célula de data do Excel sem
  `colunasDataIso` vira `DD/MM/YYYY` igual a qualquer outra coluna, quebrando o `to_date(...,
  'YYYY-MM-DD')` — ver comentário de `calendario_leitura` em `importacaoConfig.js`). Sem setembro
  importado e com a linha de agosto reimportada errada, NENHUM livro batia — "—" em toda linha, não
  só nas sem correspondência de verdade.

## Decisão

### Item 1 — "em campo" por aba

`agentesEmCampoLista()` (`monitoramento-view.ts`) ganhou um filtro extra: quando `escopo ===
'massiva'`, só entra quem tem pelo menos um `livro.tipoServico === 'massiva'` na atividade de hoje.
Monitoramento de Livros não muda (usuário confirmou que já estava certo). Esse filtro é a base de
`agentesEmCampo`/`agentesMoto`/`agentesAPe`/`agentesMonitorEmCampo`/`comunicacaoOk`/
`semComunicar30`/`listaSemComunicar` — todos passam a refletir só quem tem massiva quando a aba é
Massivas, sem precisar duplicar a checagem em cada um.

### Item 2 — modal "Agentes em campo"

Mesmo padrão do modal "Sem comunicar" já existente (mesmo componente, novo `signal`
`mostrarAgentesEmCampo`). Lista vem de `agentesEmCampoLista()` (já escopada pelo item 1), com
bateria via `colaboradoresService.scalefusionDe(nome)` (aparelho — vale pra motoqueiro e pedestre,
só a POSIÇÃO diverge por cargo, não a bateria) e tempo parado via `atividadeDe(nome).minutosParado`.
"Ver no mapa" chama `colaboradoresService.verNoMapa(nome)` — método novo que abre o card do
colaborador (`abrirColaborador`), centraliza o mapa na posição real dele (SEGSAT pro motoqueiro,
Scalefusion pro pedestre, fallback pra última UC realizada — mesma regra de `mapa-bases.ts`) e pede
a troca pra aba Trilho via um novo signal `pedidoAbaTrilho` (contador) — `abaAtiva` só existe em
`Home`, então o pedido cruza de `MonitoramentoView` pra lá através do service compartilhado; `Home`
reage com um `effect()` que seta `abaAtiva.set('monitoramento')` a cada incremento.

### Item 3 — coleta de massivas desatualizada não aparece como se fosse de agora

Usuário, depois de ver a causa raiz: *"se não tem dado nenhum pra hoje então a tabela de massivas
não deve exibir nada pq se exibir vai estar mostrando uma informação infiel"*. `obterResumo`/
`obterDetalhe` (`monitoramentoService.js`) ganharam a checagem `ultimoBatchMassivaBruto.dt_import
=== hojeBr()`: quando o lote mais recente NÃO é de hoje, ele é tratado como se não existisse
nenhum (mesmo caminho de "sem dado" que já existia pra quando as tabelas estão vazias) — cards
todos zerados, tabela vazia. Zero sozinho seria ENGANOSO de outro jeito (pareceria "tudo em dia"),
então o resumo devolve também `massivaDesatualizada: true` + `ultimoLoteMassiva: {dataImport,
horaImport}` (o lote real, só que marcado como velho) — o FRONTEND usa isso pra mostrar um aviso
âmbar explícito ("Sem coleta de massivas hoje — último lote encontrado em ..."), em vez de deixar o
zero sem explicação. Investigar/consertar por que a coleta em si parou de gravar ficou de fora desta
rodada (usuário optou por só corrigir a exibição agora).

### Item 4 — filtros embutidos na tabela

Barra de filtros separada (acima da tabela) removida inteira; os mesmos controles (mesmos signals
de `MonitoramentoService`, sem nenhum novo) viraram uma segunda `<tr>` dentro do `<thead>` da
tabela "Detalhe por livro", uma célula por coluna filtrável (Regional/Livro/Etapa/Status/Tipo/Prazo
regulatório/Leiturista — as colunas sem filtro no backend, como Progresso/Dias em atraso, ficam com
a célula vazia só pra manter o alinhamento). "Limpar filtros" moveu pro cabeçalho da própria tabela
(ao lado da contagem de registros). Como o `<thead>` já era `sticky top-0`, as duas linhas (rótulos
+ filtros) sobem juntas ao rolar, sem CSS novo.

Clique no valor de Regional ou Leiturista numa linha aplica aquele valor exato como filtro
(`filtrarPorRegional`/`filtrarPorLeiturista`, chamando `evento.stopPropagation()` — a linha inteira
já tem `(click)="abrirHistorico(...)"`, sem isso os dois clique disparariam juntos). Válido nas duas
abas, sem diferença de comportamento entre Massivas e Monitoramento de Livros — só a lista de
colunas visíveis já divergia antes (`*ngIf="escopo === 'leiturarelitura'"` em Tipo/Prazo
regulatório), mantido igual.

### Item 5 — remove "UCs do livro" do modal de histórico

Bloco inteiro (`<h4>UCs do livro</h4>` + tabela) removido de `monitoramento-view.html`, mantendo só
a timeline (`<ol>`). Como nada mais no app usava `ucsLivro`/`carregandoUcsLivro`/`erroUcsLivro`/
`buscarUcsLivro` (conferido com grep no FRONTEND inteiro), esses signals/método/interfaces saíram
de `monitoramento.service.ts` junto — deixá-los deixaria uma chamada de rede morta a cada abertura
do modal, sem nenhum consumidor. Endpoint `GET /massivas/livro-ucs` no BACKEND não foi tocado (só o
uso dele no FRONTEND estava fora de escopo do pedido).

### Item 6 — fix de importação de `prazo_reg_livros`

- `prazo_reg_livros.mes_ref`/`.prazo_calendario` ganharam `colunasDataIso: ['mes_ref',
  'prazo_calendario']` em `importacaoConfig.js` (mesmo mecanismo já usado por
  `calendario_leitura`) — próxima importação da planilha grava o formato certo
  (`YYYY-MM-DD`) independente de como a célula do Excel está formatada.
- As 13.892 linhas malformadas (`mes_ref = '31/08/2026'`) foram apagadas do banco a pedido do
  usuário (`DELETE FROM prazo_reg_livros WHERE mes_ref = '31/08/2026' AND empresa_id = $1`,
  confirmado antes/depois) — as 13.880 linhas corretas de agosto (`mes_ref = '2026-08-01'`) ficaram
  intactas. Setembro segue sem nenhuma linha até o usuário importar a planilha nova (fora do
  escopo desta rodada — é ação de dado, não de código).

## Verificação

- `npx tsc --noEmit` e `npx ng build --configuration production` (FRONTEND) limpos, mesmos avisos
  pré-existentes de sempre (budget de bundle, `leaflet` não-ESM).
- `npm test` (BACKEND) — 18/18 testes de RLS passando, sem regressão.
- Script direto contra o banco real confirmou o novo comportamento do item 3:
  `obterResumo(db, {tipoServico:'massiva'})` → `massivaDesatualizada: true`,
  `ultimoLoteMassiva: {dataImport:'04/09/2026', horaImport:'18:00:38'}`, todos os contadores
  zerados; `obterResumo(db, {tipoServico:'leiturarelitura'})` não afetado
  (`massivaDesatualizada: false`, `total.livros: 937`).
- `DELETE` de `prazo_reg_livros` confirmado: antes 2 valores de `mes_ref` (13.880 + 13.892 linhas),
  depois só `'2026-08-01'` (13.880).

## Adendo 1 (2026-09-07) — filtros viram popover "estilo Excel" no cabeçalho

A primeira versão do item 4 (mostrada acima) botou os filtros como `<select>`/`<input>` sempre
visíveis numa segunda linha do `<thead>`. Usuário, com print: *"ficou ridículo os filtros é pra
ficarem como se fosse no excel clico no título e mostra a lista suspensa com opção de digitar"*.

Segunda linha do `<thead>` removida. Cada título de coluna filtrável ganhou um ícone de funil ao
lado (preenchido/azul quando o filtro está ativo, vazio/cinza quando não) — clicar nele abre um
popover ancorado embaixo do próprio título, com campo de busca no topo e, pras colunas com lista
fechada de valores (Regional/Etapa/Situação/Tipo/Prazo regulatório), as opções abaixo filtradas
pelo texto digitado; clicar numa opção aplica e fecha. Pras colunas de texto livre (Livro/
Leiturista, sem lista possível — são nomes/números livres) o próprio campo de busca é o filtro,
sem lista embaixo.

Componente novo e reutilizável, `FiltroColuna`
(`monitoramento-view/filtro-coluna/filtro-coluna.ts`), pra não repetir o popover 7 vezes:
`[opcoes]` null vira o modo texto-livre, `[opcoes]` preenchido vira o modo lista (`opcoes[0]` é
sempre a entrada de "limpar" tipo `{valor:'', rotulo:'Todas'}`, fixa no topo mesmo com busca
digitada — mesma ideia do "(Selecionar tudo)" do Excel não sumir da lista). Fecha sozinho ao
clicar fora (`@HostListener('document:click')` comparando contra o próprio `elementRef`) — sem
overlay de tela cheia, que atrapalharia interagir com outra coluna ou rolar a tabela enquanto um
filtro está aberto. Foca o campo de busca automaticamente ao abrir.

Os métodos que já existiam (`aplicarFiltroRegional`/`aplicarFiltroEtapa`/etc., criados junto com a
primeira versão do item 4) não mudaram — só a UI que os chama trocou de `<select>`/`<input>`
sempre visível pra popover sob demanda.

### Verificação

`npx tsc --noEmit` e `npx ng build --configuration production` limpos, mesmos avisos
pré-existentes (budget de bundle, `leaflet` não-ESM). Não foi possível verificar visualmente no
navegador nesta sessão (sem credencial de login) — revisão de código cuidadosa na ordem de eventos
do clique (botão do funil abre o popover ANTES do listener de documento rodar, mesmo tick — a
condição de fechamento não fecha o que acabou de abrir) no lugar de captura de tela.
