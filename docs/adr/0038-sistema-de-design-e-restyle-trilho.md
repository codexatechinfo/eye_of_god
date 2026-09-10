# ADR 0038 — Sistema de design de marca (tokens) e restyle da aba Trilho

## Contexto

Usuário enviou um protótipo estático de referência (`olho.html`, HTML/CSS/JS vanilla num arquivo
único, ~9300 linhas) com um novo padrão visual/estrutural pra "Olho de Deus" e pediu pra atualizar
o front atual (Angular) pra esse padrão — "baseado no que nós já temos o que não tivermos vai me
perguntando".

### O protótipo é mais amplo que uma repintura

Mapeado por completo antes de qualquer decisão: define 6 abas (Trilho, Agentes, Livros, Massivas,
Risco, Importação), um mecanismo de mapa em `<canvas>` desenhado à mão (Mercator + tiles OSM, sem
Leaflet) com uma "régua" de tempo que reproduz o dia inteiro como um vídeo (play/pause/velocidade)
na aba Trilho, e uma aba **Risco** inteiramente nova — apoio à decisão sobre livros em risco, 10
critérios, probabilidade calculada `(batidos/medidos)³`, 4 ações de decisão (acompanhar/apoiar/
redistribuir/escalar) — cuja maioria dos campos (`PCT_EXECUCAO`, `DIAS_ATRASO`, `UC_REINCIDENTE`
etc.) não existe no backend hoje.

### Decisões de escopo, confirmadas com o usuário antes de codar

1. **Abordagem**: restylizar o Angular existente (mantém toda a arquitetura — componentes,
   services, signals, RLS), não reimplementar como HTML/JS vanilla. O canvas do protótipo é uma
   restrição PRÓPRIA dele (arquivo único offline, sem CDN/node_modules) — não se aplica aqui.
2. **Sequência**: começar pela aba **Trilho**. Agentes/Livros/Massivas/Importação ficam pra fases
   futuras.
3. **Mapa**: mantém **Leaflet** como está — só repintura de cor/ícone, sem reconstruir em canvas. A
   régua de tempo (playback do dia) fica **fora de escopo** desta fase.
4. **Aba Risco**: fica pra uma fase futura separada, com decisões de negócio próprias (o que conta
   como risco, o que cada ação realmente faz) e trabalho de backend novo.

Esta ADR cobre só a **fase 1**: introdução do sistema de tokens de design + restyle visual puro da
aba Trilho e da casca compartilhada (header/navegação). Nenhuma mudança de comportamento, lógica de
signals/effects ou chamadas HTTP — só cores, tipografia, raio, sombra e o "filete" de marca.

## Decisão — tokens de design

Tailwind v4 já estava em uso (`@import "tailwindcss";`, sem `tailwind.config.js`) mas **sem nenhum
sistema de design**: cada template usava classes de fábrica (`slate-*`, `blue-*`, `emerald-*` etc.)
hardcoded, sem camada de abstração, sem dark mode, sem CSS custom properties.

Acrescentado um bloco `@theme` em `FRONTEND/src/styles.css` com os tokens do protótipo:

```css
@theme {
  --color-navy: #0B2E59; --color-azul: #006DFF; --color-azul-t: #0057CC;
  --color-laranja: #F28C28; --color-laranja-t: #C96F16;
  --color-ok: #1F9D62; --color-alerta: #F28C28; --color-critico: #D64545;
  --color-roxo: #6D4AC7; --color-roxo-t: #5537A8;
  --color-teal: #0D9488; /* token extra, ver abaixo */
  --color-fundo: #F2F4F7; --color-sup: #FFFFFF; --color-sup-2: #F7F9FC; --color-sup-3: #EDF1F7;
  --color-linha: #E4E8EE; --color-linha-2: #CFD6E0; --color-callout: #EAF1FB;
  --color-tit: #12161C; --color-txt: #2A2E35; --color-fraco: #6B7684; --color-tenue: #98A2B3;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --radius-sm: 5px; --radius-md: 7px; --radius-lg: 10px; --radius-xl: 10px;
  --shadow-sm: 0 1px 2px rgba(11,46,89,.06), 0 8px 24px rgba(11,46,89,.06);
  --shadow-xl: 0 2px 6px rgba(11,46,89,.10), 0 18px 48px rgba(11,46,89,.14);
}
```

### Por que classes explícitas (`bg-azul`) em vez de sobrescrever a paleta padrão do Tailwind

Dava pra sobrescrever `--color-blue-600` direto e propagar pra `bg-blue-600` em todo o app sem
tocar em nenhum template. Rejeitado porque o protótipo só dá UM azul + um "-t" (hover), não uma
rampa 50→900 inteira — inventar os tons intermediários sem fonte real seria arriscado. Fica mais
trabalho (editar cada ocorrência), mas o diff de cada arquivo mostra exatamente `bg-blue-600` →
`bg-azul`, auditável linha a linha.

### Por que raio/sombra SIM sobrescrevem a escala padrão (`sm`/`md`/`lg`/`xl`)

Ao contrário das cores: nomear os tokens literalmente `--radius-r`/`--radius-r2`/`--radius-r3`
(nomenclatura do protótipo) geraria classes `rounded-r`/`rounded-r2` que colidem com o namespace
nativo do Tailwind de "raio só do lado direito" (`rounded-r-lg` etc.) — ambíguo e arriscado. Como o
app já usa `rounded-lg`/`md`/`full`/`xl` em várias telas, sobrescrever os VALORES desses tokens
padrão propaga o raio novo pro app inteiro sem editar nenhum template — raio não carrega
significado semântico como cor carrega, então essa "mágica global" é segura aqui.

### Token extra: `--color-teal`

O protótipo não tem teal na paleta principal, mas é exatamente o hex que o app já usava em
`COR_SEGMENTO_MUDOU_MUNICIPIO` (`mapa-bases.ts`). Sem esse token, "mudou de livro" (roxo/fúcsia) e
"mudou de município" (teal) perderiam a distinção visual que já existe entre os dois badges da
timeline — mantido de propósito.

### Filete de marca

Barra fixa de 3px no topo da viewport (22% laranja, 78% navy) — assinatura visual do padrão A2L.
Implementada em fluxo normal (`shrink-0`, primeiro filho do `h-screen flex flex-col` de
`home.html`), não `position:fixed` como o protótipo faz: o resto do arquivo já usa
`shrink-0`/`flex-1 min-h-0` consistentemente, então o flexbox absorve os 3px sozinho, sem `calc()`
manual nem `z-index` extra.

### Painel de camadas do Leaflet — CSS global, não Tailwind

`montarDomControleCamadas()` (`mapa-bases.ts`) monta o painel de camadas via `L.DomUtil.create`
puro — fica fora da árvore Angular, `ViewEncapsulation` não alcança. Estilizado com CSS global em
`styles.css` (fora do `@theme`, regras normais mirando `.leaflet-control-layers*`), usando
`var(--color-sup)`/`var(--radius-lg)`/`var(--shadow-sm)` — as custom properties do `@theme` ficam
disponíveis globalmente, não só dentro de classes utilitárias geradas.

## Decisão — restyle da aba Trilho

Mapeamento semântico consistente aplicado a `home.html` (casca), `lista-colaboradores.html`/`.ts`,
`colaborador-detalhe.html`/`.ts` (só variante `'painel'`, a usada no Trilho — `'modal'`, usada na
aba Monitoramento Colaborador, não foi tocada) e `mapa-bases.ts`/`.html`:

- azul (blue-500/600, "selecionado"/"primário") → `azul`/`azul-t`
- verde/esmeralda ("ok"/"realizado") → `ok`
- âmbar/laranja ("alerta"/"impedimento"/"pausa"/"improdutivo") → `alerta`/`laranja-t`
- vermelho ("crítico"/"a realizar"/"reincidente") → `critico`
- violeta/fúcsia ("afastamento INSS"/"mudou de livro"/"setor planejado") → `roxo`/`roxo-t`
- teal ("mudou de município") → `teal`
- slate-900/800 (títulos) → `tit`; slate-600/700 (texto) → `txt`; slate-500/400 (texto fraco) →
  `fraco`/`tenue`; slate-200/100 (bordas/fundos sutis) → `linha`/`linha-2`/`sup-2`/`sup-3`;
  slate-50 (fundo de página) → `fundo`; white → `sup`

`corBateria()` (duplicada em `lista-colaboradores.ts` e `colaborador-detalhe.ts`) trocada nos dois
lugares. `mapa-bases.ts` (`CORES_PONTO`, `COR_SEGMENTO_*`, ícones moto/pausa, anel de foco, polígono
"Setor planejado") trocado pra hex direto (fica fora da árvore Tailwind — ícones `L.divIcon` e
polígonos Leaflet são string/config puro, não classe utilitária).

### Não mexidos, de propósito

- **Rastro GPS / marcadores início-fim** (`#0f172a`) — comentário no próprio código já registra que
  é deliberadamente fora de toda paleta semântica (ver ADR 0034 Adendo 4/5); manter.
- **Limites municipais** (`#0ea5e9`) — não tem categoria semântica clara no mapeamento acima,
  deixado como está.
- **Ícone do pedestre** (`#dc2626`) — comentário no código registra que o usuário já rejeitou uma
  vez `#ef4444` nesse ícone por ficar "ainda alaranjado", pedindo explicitamente `#dc2626`
  ("mais saturado/puro"). O token `--critico` (`#D64545`) é um TERCEIRO vermelho, mais claro/menos
  saturado que `#dc2626` — testado lado a lado (réplica com os três hex) antes de decidir, e a
  diferença é visível. Pra não repetir o mesmo ciclo de feedback, o ícone do pedestre **não foi
  trocado** — segue `#dc2626`. Fica pro usuário decidir explicitamente se quer uniformizar com o
  token novo ou manter esse hex como uma exceção deliberada.

### Duplicação de markup — decisão consciente de não extrair

Os 5 botões de aba (`home.html`) e os 9 cards de indicador (`colaborador-detalhe.html`) são bem
repetitivos, mas extrair pra `*ngFor`/config agora seria refatoração de ESTRUTURA, não restyle —
mexeria em `(click)`, `*ngIf` condicional (botão Importação), lógica de cor condicional
(`semSincronizarCritico()`, estados placeholder de alguns cards), aumentando risco de regressão
comportamental exatamente onde o pedido era "zero mudança de lógica". Fica pra uma tarefa futura
separada, se o usuário quiser.

## Verificação

Sem login disponível nesta sessão (mesma limitação de sempre) — verificado via harnesses estáticos
com o CSS real compilado (`ng build --configuration production`, CSS copiado pro harness), abertos
no Browser pane: header completo (filete + abas + pill de status + "Última importação" + Sair) +
sidebar (contador, chips de categoria, card de colaborador selecionado com bateria) lado a lado —
visual coeso, todas as cores/raios/sombras aplicando corretamente. Comparativo isolado pro vermelho
do pedestre (`#dc2626` vs `#D64545` vs `#ef4444` já rejeitado) confirmou a diferença visível que
motivou não trocar esse ícone específico.

`npx tsc --noEmit` limpo (só mudança de template/string, nenhum arquivo `.ts` com lógica alterada).
`npx ng build --configuration production` limpo — CSS compilado confirmado contendo as novas
classes (`bg-azul`, `text-critico` etc.) e os tokens (`--color-azul: #006DFF` etc.) gerados
corretamente pelo Tailwind v4.

## Próximos passos (fora desta ADR)

- Restyle de Agentes, Livros, Massivas, Importação (mesmo sistema de tokens, próxima fase).
- Decidir sobre a régua de tempo (playback do dia) — mecanismo novo, não construído nesta rodada.
- Aba Risco — feature nova completa, precisa de decisões de negócio (critérios, ações) e trabalho
  de backend antes de qualquer tela.

## Adendo 2 — Rodada 2: restyle estrutural (não só cor)

Usuário testou a rodada 1 no app real e reportou que não bateu com o protótipo: só cor mudou, a
ESTRUTURA (lista de colaboradores, grid de indicador, timeline) continuou a antiga — pediu pra
reanalisar o protótipo por completo e perguntar cada detalhe antes de mexer de novo.

Reli `08-campo.css` (linhas 517-666) e o JS de renderização (`linhaAgente`, `pintaResumoEm`,
`cartaoPonto`, `desenhaAgente`, olho.html linhas 3959-5300) — a diferença é estrutural: o protótipo
usa lista compacta de linha única (sem expandir), cards de indicador neutros (cor só quando tem
significado), timeline em formato de cartão, e ícones de colaborador como formas geométricas
simples (losango/gota) em vez de silhueta. Achado-chave: os nomes de campo no JS do protótipo
(`p.codigo`, `p.tipo_intervalo`, `p.mudou_livro`, `p.hora_import` etc.) batem exatamente com o
nosso contrato de backend — tradução literal, não um formato genérico.

Perguntado o usuário sobre os pontos de maior divergência — respostas: painel de detalhe continua
overlay (não vira 3ª coluna fixa); cards de indicador adotam o padrão neutro; timeline adota o
formato de cartão; lista de colaboradores adota a linha compacta sem expandir.

### Lista de colaboradores (`lista-colaboradores.html`/`.ts`)

Item reescrito pro padrão `.ag-campo`: linha única, nome (mono) + badge contador de realizadas
(cor por limiar de execução — `corBarra()`, já existente), selo de ausência cadastrada, barra fina
de % de execução do dia, cargo · regional, bateria · sem transmitir · contagem de livros (sem
lista). Clique só seleciona (abre o painel de detalhe) — não expande mais nada dentro do próprio
item. Removido: o card expansível inteiro (jornada + lista de livros), `jornadaExpandida` (signal),
`toggleJornada()`, `distanciaFormatada()`/`duracaoFormatada()` (sem uso depois da remoção).

**Achado que exigiu decisão própria (não coberto pelas perguntas):** o card expansível removido era
o único lugar que mostrava jornada do dia (trabalhado/ocioso/ocupação/km) e a lista de livros do
dia com badges de tipo/prazo regulatório — nenhum dos dois tem equivalente direto no `.ag-campo`
compacto do protótipo. Decisão conservadora (sem perder funcionalidade, reportada ao usuário em vez
de pré-aprovada): a barra de % de execução migrou pro item compacto (mesma métrica do `.barra-dia`
do protótipo); "km percorrido" e "ocupação" viraram KPIs no grid do painel de detalhe (o protótipo
já tem os dois ali); a lista de livros do dia migrou pro painel de detalhe, como seção nova.

### Painel de detalhe (`colaborador-detalhe.html`/`.ts`, só variante `'painel'`)

Grid de indicador: de 2 colunas/9 cards coloridos com gradiente pra 3 colunas/9 KPIs neutros
(fundo `sup-2`, borda `linha`, sem gradiente/ícone — cor só no valor, só nos 3 casos com
significado: impedimentos crítico se >0, sem transmitir crítico se ≥ limite, leituras/min sempre
azul, realizadas sempre ok). Cards "Leituras" (total) e "Livros" (separado de "em execução") do
grid antigo removidos — redundantes com "realizadas"+"a realizar" e com o novo "livros em
execução/total" combinado; nenhum dos dois existe no protótipo. "Ocupação" entrou como KPI novo
(não existia em nenhum card do painel antes).

Nova seção "Livros do dia" logo abaixo do grid — badges de tipo/prazo regulatório migrados do card
removido da lista lateral, mesmo comportamento (só informativo, não abre nada ao clicar).

Timeline: cada item virou cartão `.f-seg` (borda + fundo `sup-2` + barra lateral colorida + bolinha
na mesma cor, no lugar da linha vertical com marcador), mantendo a lógica de expandir ao clicar
(`ucExpandida`/`toggleExpandir`) sem nenhuma mudança. Cor do cartão por `corSegmento()` (método
novo) — reaproveita `corDaUc()` (mesma fonte do mapa) e acrescenta um caso que só existe aqui:
pausa (`tipo_intervalo === 'pausa'`) vira crítico mesmo numa leitura normal, pra destacar o tempo
parado (achado do protótipo, `cartaoPonto()`, que nosso `corDoPonto()` não cobria). Impedimento
reincidente (`ciclosConsecutivos > 1`) também crítico; impedimento simples fica `alerta`/âmbar —
**decisão consciente de manter nosso padrão já estabelecido**, não o azul claro (`#9EC3FF`) que o
protótipo reaproveita de uma classe genérica "deslocamento" pra esse caso (reduziria a clareza
semântica que já temos hoje pro impedimento).

### Casca (`home.html`) — aba ativa

Trocado o destaque da aba ativa do padrão "tinta clara" (`bg-azul/10` + texto `tit`) pro padrão
sólido do protótipo (`background:var(--navy);color:#fff`) nos 5 botões de aba.

### Ícones do colaborador no mapa (`mapa-bases.ts`)

Substituídos o traçado SVG exato (potrace de fotos reais, documentado acima em "Não mexidos, de
propósito") pelas formas geométricas simples do protótipo (`desenhaAgente`, olho.html linhas
3962-3999): losango azul (moto) e gota — círculo + cauda triangular (pedestre), coordenadas
copiadas 1:1 da geometria do canvas do protótipo. **Confirmado explicitamente pelo usuário mesmo
sabendo que é o mesmo tipo de simplificação já rejeitada 3 vezes antes** (badge, pino, silhueta
aproximada por primitivas) — pedido novo, não uma omissão. Cor do pedestre continua `#dc2626` (não
o token `--critico`), mesma decisão já tomada e documentada acima — só o formato mudou, não a cor.
Com isso, a "decisão pendente do usuário" listada nos próximos passos originais (uniformizar pro
token `--critico` ou manter `#dc2626`) segue igualmente pendente — não foi tocada nesta rodada, só
a forma do ícone. O ícone do "último
ponto de execução do colaborador aberto" (`iconeUltimoPonto`, cor dinâmica por `corDaUc`) não foi
tocado — é um traçado exato separado, fora do escopo desta pergunta, mantém `iconeColaborador()`
como helper.

### Verificação

`npx tsc --noEmit` e `npx ng build --configuration production` limpos (só os avisos pré-existentes
de orçamento de bundle e leaflet CJS) depois de cada arquivo alterado. Harness estático com o CSS
real compilado, cobrindo: item da lista em verde/amarelo/vermelho/neutro + selecionado + ausência
cadastrada com/sem divergência; grid de KPI neutro com os 3 casos coloridos (realizadas/critico
condicional/azul); timeline com card ok/alerta(impedimento)/crítico(pausa, ícone de pausa no
marcador)/crítico(reincidente)/neutro(a realizar), separadores de mudança de livro/município
preservados; aba ativa em navy sólido; ícones losango/gota — tudo visualmente coeso.

`grep` confirmou nenhuma referência solta a `jornadaExpandida`/`toggleJornada`/`distanciaFormatada`/
`duracaoFormatada` (lista) nem a `iconeColaborador` sem uso (mapa — ainda usado por
`iconeUltimoPonto`) depois das remoções.

### Pendências (fora desta ADR)

- Decidir sobre a régua de tempo (playback do dia) e a aba Risco — inalteradas, ver seção anterior.

## Adendo 3 — Rodada 3: feedback pós-deploy (filtros, legenda, login, marcador de início)

Usuário testou a rodada 2 no app real e reportou 8 pontos. Cada um investigado no código e/ou no
protótipo antes de mexer (padrão já estabelecido nos Adendos 1/2):

**Lista duplicando colaboradores** — confirmado como dado (`ativos_inativos` com 2 linhas pro mesmo
nome), não bug de código. Fora do escopo desta ADR — usuário vai reimportar uma base atualizada;
entregue a query SQL (SELECT pra identificar + DELETE) direto pro usuário rodar, sem acesso a banco
nesta sessão pra executar.

**Barra de filtros da lista** (`lista-colaboradores.html`/`.ts`) — a infraestrutura já existia
inteira em `ColaboradoresService` (`filtroColaborador`/`filtroCargo`/`filtroRegional`/`filtroData`,
`buscar()`/`buscarComDebounce()`/`onFiltroDataChange()`) mas nunca tinha ganhado UI. Construída a
tradução literal de `.f-agentes-topo` do protótipo: busca por texto, data + botão "ao vivo",
selects de regional/cargo, chips de categoria (já existiam) agora com contagem
(`contagensPorCategoria()`, novo computed no service, reaproveita `pertenceCategoria()`).

**"ao vivo"** — adaptação consciente do conceito do protótipo: lá é "reler a cada 60s sem
reenquadrar o mapa" (um toggle real de polling manual); aqui o app já poll a sozinho a cada 60s
enquanto `filtroData()` for hoje (`INTERVALO_ATIVIDADE_MS`, já existia antes desta rodada). Vira um
atalho pra voltar pro dia atual — destacado (`bg-azul`) quando já está em "hoje", clique chama
`onFiltroDataChange(hojeIso())`. Não é polling manual como no protótipo, é reativar o polling
automático que já existe.

**Cabeçalho achatado** (`home.html`) — o estado ativo (`bg-navy text-white`) já batia exatamente com
o protótipo desde a rodada 2 (`#abas .ab.on`). A diferença real estava no que cercava isso: nosso
botão tinha borda, brilho no hover, gradiente animado e o ícone crescia no hover — nada disso existe
no protótipo (`#abas .ab:hover{background:sup3;color:txt}`, sem efeitos). Removido tudo isso dos 5
botões de aba, mantido ícone (SVG já existente) + texto, ajustado pro tamanho do protótipo (34px
altura).

**Marcador de início da trajetória** (`mapa-bases.ts`) — já existia marcador dedicado só pro ÚLTIMO
ponto realizado do dia (`iconeUltimoPonto`, cor dinâmica). Acrescentado o mesmo conceito pro
PRIMEIRO ponto (`ucPrimeiroPonto`, busca cronológica pra frente — oposto de `ucUltimoPonto`), com um
ícone novo `ICONE_PRIMEIRO_PONTO` no mesmo padrão visual de `ICONE_RASTRO_INICIO` (contorno vazado,
cor neutra fixa — não dinâmica, é só posição). Se só há 1 ponto no dia, prioridade pro ícone de
ÚLTIMO (mais informativo), não desenha os dois sobrepostos.

**Login** (`login.html`) — reestilizado do zero pro padrão de tokens (fundo `fundo`, filete de
marca, cartão `sup`, ícone de olho novo — SVG flat inline, não o `favicon-olho.png` existente, que é
uma ilustração 3D detalhada incompatível com o sistema de design desta rodada). Lógica de `login.ts`
intocada.

**Legenda do mapa** — não existia antes (`grep` sem resultado). Protótipo tem 5 categorias
(`pintaLegenda()`, olho.html); usuário pediu incluir TODAS as que o app já usa — 7 no total, com as
mesmas cores hex já usadas nos marcadores/segmentos (`CORES_PONTO`/`COR_SEGMENTO_*`, nenhuma cor
nova). Nota: "pausa" e "impedimento" compartilham a mesma cor (`#F28C28`) — já era assim no código
antes desta legenda existir, não é uma inconsistência introduzida agora.

**Controles de tipo de mapa e Camadas** — o seletor de tipo de mapa (Ruas/Satélite/Satélite c/
rótulos/Topográfico) usava o `L.control.layers` NATIVO do Leaflet (painel que só expandia no hover).
Substituído por um controle customizado (`criarControleBase`/`montarDomControleBase`, mesmo padrão
de `L.Control.extend` já usado pelo painel de Camadas) renderizando os 4 tipos como botões pill
sempre visíveis (`.mapa-base-sel`, CSS global em `styles.css`, mesmo motivo dos outros controles do
mapa: ficam fora da árvore Angular). O painel "Camadas" manteve a lógica interna 100% igual (7
checkboxes, mesmos signals) — só o container/toggle visual mudou, de ícone-com-hover-expande pra
botão "Camadas N" com contador que abre/fecha ao clicar (`.mapa-camadas-caixa`/`.mapa-camadas-bt`,
mais previsível em touch também). `ICONE_CAMADAS_SVG` (ícone do controle antigo) removido, sem uso.

**Alerta "afastado com atividade"** — revisado (`colaboradores.service.ts`), lógica correta:
`afastadosComAtividade` cruza atividade real + afastamento cadastrado por nome, um `effect` abre o
alerta sozinho só quando aparece um nome NOVO (não visto ainda). Usuário nunca viu disparar — não é
necessariamente bug, só dispara quando as duas condições coincidem no mesmo dia, combinação que pode
ser rara nos dados atuais. Nenhuma mudança de código nesta rodada.

### Verificação

`npx tsc --noEmit` e `npx ng build --configuration production` limpos (só os avisos pré-existentes).
Harness estático com o CSS real compilado cobrindo: cabeçalho achatado (ativo vs hover), barra de
filtros completa com chips contados, legenda com as 7 categorias, controle de tipo de mapa (pill
ativo/inativo) + botão de camadas com contador, marcador de início vs último, tela de login inteira
— tudo visualmente coeso. `grep` confirmou zero referência solta a `L.control.layers`/
`ICONE_CAMADAS_SVG` depois da remoção.

### Pendências (fora desta ADR, reafirmadas)

- Duplicidade de "PAULO SERGIO DA SILVA" — aguardando o usuário rodar a query SQL entregue (fora do
  fluxo de código) ou a reimportação de uma base atualizada.
- Régua de tempo (playback do dia) e aba Risco — inalteradas.

## Adendo 4 — Rodada 4: barra do mapa em fluxo normal, zoom, labels do header, scrollbar

Usuário testou a rodada 3 e apontou 3 problemas concretos, mais uma mensagem solta durante a
conversa sobre a scrollbar:

**Zoom do mapa** — controle nativo do Leaflet (`+`/`−`) ficava no canto topleft, competindo por
espaço com os novos controles de tipo de mapa/camadas da rodada 3. Movido pra `bottomright`
(`zoomControl: false` no `L.map()` + `L.control.zoom({ position: 'bottomright' })` explícito) —
mesmo canto da atribuição do Leaflet/tiles, "sobe com as outras informações" ali, pedido do usuário.

**Barra superior do mapa (legenda + tipo de mapa + camadas)** — achado da rodada 3: eu tinha
implementado os 3 como controles Leaflet `L.Control.extend` flutuando no canto topleft (base-sel +
camadas) mais um overlay Angular solto no bottom-left (legenda), tentando imitar visualmente
`.f-barra` do protótipo só com posicionamento absoluto. Relendo o CSS do protótipo com mais cuidado
(`olho.html:564-566`, `.f-barra{height:40px;flex:none;background:var(--sup);border-bottom:1px solid
var(--linha)}`) ficou claro que `.f-barra` NÃO é overlay — é uma barra real, em fluxo normal, acima
do canvas do mapa (`.f-centro{display:flex;flex-direction:column}` → `.f-barra` (40px fixo) →
`#f-tela` (flex:1)). Essa é a causa raiz de "a barra superior ainda não ficou no padrão esperado e
as legendas não foram lá pra baixo".

Corrigido reestruturando `mapa-bases.html`: o componente virou `flex flex-col`, com uma barra real
`shrink-0 h-10` no topo (legenda | spacer | tipo de mapa | camadas, tudo dentro da árvore Angular
normal) e o mapa em si (`#mapaEl` + spinner) num `flex-1 min-h-0` logo abaixo. Isso eliminou também
a necessidade dos controles Leaflet customizados — `criarControleCamadas`/`montarDomControleCamadas`/
`criarControleBase`/`montarDomControleBase` (DOM montado à mão com `L.DomUtil`, CSS global em
`styles.css`) foram REMOVIDOS e viraram estado Angular simples: `baseAtiva`/`camadasAbertas` signals,
`selecionarBase()`/`toggleCamadas()` métodos, checkboxes ligados direto aos signals `camadaX` já
existentes no template. Fechar o dropdown de Camadas ao clicar fora usa o mesmo padrão já
estabelecido em `colaborador-detalhe.ts` (`$event.stopPropagation()` no wrapper + `HostListener
document:click` no componente).

**Labels do header** — usuário deu o mapeamento explícito: TRILHO=TRILHO, MONITORAMENTO
COLABORADOR→AGENTES, MONITORAMENTO DE LIVROS→LIVROS, MASSIVAS=MASSIVAS, IMPORTAÇÃO=IMPORTAÇÃO — nomes
curtos como no protótipo (`#abas .ab`, `olho.html:1112-1117`). Só o texto do botão mudou, `(click)`
e `abaAtiva()` continuam nos mesmos valores internos (`'colaborador'`/`'livros'` etc.) — nenhuma rota
nem lógica de seleção de aba mudou.

**Scrollbar** — mensagem solta do usuário durante a rodada ("a barra de scroll lateral tá ocupando
muito espaço, tá feio, precisa mais discreto mais slim"): scrollbar padrão do SO (grossa, cinza-
escura) destoava das listas compactas do novo design. Adicionado CSS global (`::-webkit-scrollbar`+
`scrollbar-width:thin`) em `styles.css`, mesmo padrão do protótipo (`olho.html:53-57`) — track
transparente, thumb em `--color-linha-2`, escurece pra `--color-fraco` no hover. Vale pra qualquer
lista com scroll no app, não só a de colaboradores.

### Verificação

`npx tsc --noEmit` e `npx ng build --configuration production` limpos. Harness estático cobrindo:
barra superior do mapa em larguras diferentes (confirmado que só quebra/trunca em containers de
teste artificialmente estreitos, não na largura real da área do mapa no app — sidebar 320px deixa
900px+ disponíveis em telas comuns), zoom no canto inferior direito, dropdown de Camadas, header com
os 5 labels novos, scrollbar fina visível num container de teste com overflow. `grep` confirmou zero
referência solta aos métodos/classes CSS removidos (`criarControleCamadas`, `montarDomControleBase`,
`.mapa-base-sel`, `.mapa-camadas-*`) e zero ocorrência dos labels antigos no header.

### Pendências (fora desta ADR, reafirmadas)

- Duplicidade de "PAULO SERGIO DA SILVA" — mesma pendência do Adendo 3.
- Régua de tempo (playback do dia) e aba Risco — inalteradas.

## Adendo 5 — Rodada 5: painel cobrindo a barra do mapa + dropdown de Camadas cortado

Usuário testou a rodada 4 no app real (print da tela inteira com o painel de RAFAEL COUTINHO
aberto) e reportou 2 bugs:

**Painel de detalhe cobria a barra superior do mapa** — o painel (`colaborador-detalhe.html`,
variante `'painel'`) era `absolute inset-y-0 right-0` dentro do MESMO `relative` que envolvia
`app-mapa-bases` inteiro (`home.html`). `inset-y-0` cobre do topo ao fundo desse container — incluindo
a barra de legenda/tipo de mapa/camadas que a rodada 4 colocou DENTRO de `app-mapa-bases`, então
abrir o painel tampava essas informações (comentário antigo no próprio código já dizia "sem cobrir
header/filtros que ficam acima dela" — verdade quando esse header vivia FORA da área do mapa, deixou
de ser quando a barra passou a viver dentro).

Usuário pediu explicitamente pra inverter o comportamento: "quando abre a barra lateral... deve
empurar o mapa e a barra superior... para não cobrir". Isso reverte uma decisão tomada na rodada 2
(manter overlay, não virar coluna fixa como o protótipo) — decisão nova e explícita do usuário desta
vez, não um esquecimento. Implementado: painel deixou de ser `position:absolute`, virou coluna real
num flex row (`home.html`: `<main class="... flex"><app-mapa-bases class="flex-1 min-w-0 .../><app-colaborador-detalhe/></main>`)
— `app-mapa-bases` tem `flex-1 min-w-0` (encolhe), o painel tem `w-full max-w-xs shrink-0` (largura
fixa, não encolhe). Abrir o painel agora empurra/encolhe o mapa E sua barra superior junto, em vez de
cobrir qualquer um dos dois. Variante `'modal'` (Monitoramento Colaborador) não foi tocada — continua
`fixed inset-0`, sem relação com este layout.

**Dropdown de "Camadas" não abria / ficava cortado** — causa raiz: a barra superior inteira
(`mapa-bases.html`) tinha `overflow-x-auto` (defensivo, pra caso a legenda não coubesse). Definir
overflow-x força overflow-y a virar não-visível também (regra do CSS) — como o dropdown de Camadas é
`position:absolute` DENTRO dessa barra e precisa crescer pra BAIXO dela (~250px de altura pros 7
checkboxes, a barra em si só tem 40px), ele ficava cortado pela própria barra. Corrigido: o
`overflow-x-auto`/`min-w-0` saiu da barra inteira e foi só pra dentro do wrapper da LEGENDA (o único
trecho que pode precisar rolar horizontalmente quando o mapa encolhe com o painel aberto — ver bug
acima); tipo de mapa e Camadas ficam fora desse overflow, sempre visíveis e sem cortar o dropdown.

### Verificação

`npx tsc --noEmit` e `npx ng build --configuration production` limpos. Harness estático confirmando
os dois casos: painel ao lado do mapa (não sobre) com a barra superior inteira visível e legível ao
lado dele; clique no botão Camadas abre o dropdown completo (7 checkboxes) por cima do mapa, sem
corte.

### Pendências (fora desta ADR, reafirmadas)

- Duplicidade de "PAULO SERGIO DA SILVA" — mesma pendência do Adendo 3.
- Régua de tempo (playback do dia) e aba Risco — inalteradas.

## Adendo 6 — Rodada 6: tipo de mapa também virou dropdown

Usuário mandou print mostrando a legenda com scroll horizontal (fade visível na borda) — os 4 botões
pill de tipo de mapa (Ruas/Satélite/Satélite c/ rótulos/Topográfico) ocupavam espaço demais na barra,
sobrando pouco pra legenda. Pediu pra colocar o tipo de mapa no mesmo formato do botão "Camadas"
(dropdown), não mais pills sempre visíveis.

Implementado: `tiposBase` (array) continua igual, mas a UI virou um botão só (`{{ rotuloBaseAtiva }}`
+ seta) que abre uma lista ao clicar — mesmo padrão exato do dropdown de Camadas (`baseAberta` signal
espelhando `camadasAbertas`, `toggleBase()`/`selecionarBase()` fecham o próprio dropdown e o do
outro, `fecharDropdowns()` — renomeado de `fecharCamadas()` — fecha os dois num HostListener só).
Isso libera a maior parte da largura da barra pra legenda, que só precisa do `overflow-x-auto`
defensivo em telas realmente estreitas com o painel aberto.

### Verificação

`npx tsc --noEmit` e `npx ng build --configuration production` limpos. Harness confirmando: as 7
categorias da legenda cabem inteiras sem rolar numa largura realista (800px); dropdown de tipo de
mapa abre com as 4 opções, ativa em navy, mesmo comportamento de fechar ao clicar fora do de Camadas.

### Pendências (fora desta ADR, reafirmadas)

- Duplicidade de "PAULO SERGIO DA SILVA" — mesma pendência do Adendo 3.
- Régua de tempo (playback do dia) e aba Risco — inalteradas.

## Adendo 7 — Rodada 7: scroll da timeline sumiu (regressão do Adendo 5)

Usuário reportou "sumiu o scroll lateral da timeline" logo depois da rodada 5. Causa raiz: ao trocar
o painel de `position: absolute inset-y-0` (Adendo 5, pra empurrar o mapa em vez de cobri-lo) pra um
`div` de fluxo normal, a div perdeu a altura EXPLÍCITA que `inset-y-0` garantia (top:0+bottom:0 =
100% do container). Sem `absolute`, uma div só cresce pelo conteúdo — como o painel é `flex flex-col`
com um trecho `flex-1 overflow-y-auto` (a timeline), esse `flex-1` não tinha mais um teto de altura
pra respeitar, então o painel inteiro crescia pra caber TODOS os itens do dia, sem scroll interno
nenhum (a rolagem, se sobrasse algo, virava rolagem da PÁGINA, não da timeline).

`<app-colaborador-detalhe>` (o host, `home.html`) já é esticado corretamente pelo `flex` do `<main>`
(align-items: stretch, padrão) — mas isso só dá altura definida ao HOST; a div de dentro (filha
comum, não item de flex de mais ninguém) não herda `height:100%` sozinha, precisa do `h-full`
explícito pra repassar essa altura. Corrigido acrescentando `h-full` na div do painel
(`colaborador-detalhe.html`) e, por robustez/clareza, `class="block h-full"` no próprio host
`<app-colaborador-detalhe>` (mesmo padrão já usado em `<app-mapa-bases>` ao lado).

### Verificação

`npx tsc --noEmit` e `npx ng build --configuration production` limpos. Harness com 15 itens de
timeline (~900px de conteúdo) dentro de um painel de 400px de altura — confirmado que só ~5 itens
aparecem por vez, com scrollbar fina visível na área da timeline, painel não estoura mais o
container pai.

### Pendências (fora desta ADR, reafirmadas)

- Duplicidade de "PAULO SERGIO DA SILVA" — mesma pendência do Adendo 3.
- Régua de tempo (playback do dia) e aba Risco — inalteradas.

## Adendo 8 — Rodada 8: identidade do cabeçalho e foco do campo de busca

Usuário reportou 2 pontos rápidos (dos 5 desta rodada — os outros 3 estão em andamento/pendentes,
ver seção seguinte):

**Cabeçalho ainda sem a identidade "Olho de Deus"** — desde a rodada 4, o cabeçalho só tinha o logo
A2L; nunca chegou a ganhar o bloco `#topo .ident` do protótipo (nome do produto + "supervisão de
campo · coleta HH:MM"). Adicionado em `home.html`, reaproveitando `ultimoImport()` (já existia,
mesmo dado do bloco "Última importação" mais à direita no cabeçalho) — sem chamada nova ao backend.

**Campo de busca da lista mostrando uma caixa com borda preta dentro dele** — o wrapper (`div` com
borda/fundo customizados) estiliza o foco via `focus-within:border-azul`, mas o `<input>` de dentro
não tinha `outline-none` — o contorno de foco PADRÃO do navegador (geralmente preto) aparecia em
volta do input, dentro do wrapper, parecendo uma "caixa dentro da caixa". Adicionado `outline-none`
no input de busca e, por consistência, nos outros 3 campos da mesma barra (data, regional, cargo),
que tinham o mesmo risco (só não tinha sido notado ainda por não terem wrapper próprio).

### Verificação

`npx tsc --noEmit` e `npx ng build --configuration production` limpos.

### Pendências desta rodada (itens 3, 4 e parte do 5, ver conversa)

- Régua de tempo / playback da timeline do dia (play/pause, velocidade, ponto em destaque
  acompanhando) — reativa uma feature explicitamente adiada desde a fase 1 (ver Contexto desta ADR);
  usuário confirmou querer agora. Ainda não implementada.
- Performance: 1 de 2 consultas lentas identificadas foi corrigida (ver Adendo de performance no
  CHANGELOG — `idx_base_dados_leitura_data_usuario_hora`). A segunda (`obterBaselineDigitadosPorLivro`,
  parte de `/colaboradores/atividade-hoje`, ~1,3s) resistiu a duas tentativas (índice novo, reescrita
  com `LATERAL` — pior, cancelada em produção) — precisa de mais investigação antes de tentar de
  novo, não é um fix rápido como o primeiro.
- Duplicidade de "PAULO SERGIO DA SILVA" — mesma pendência do Adendo 3.
- Aba Risco — inalterada.

## Adendo 9 — Rodada 9: crachá de resumo do colaborador

Usuário pediu, com print de referência: ao clicar num colaborador, além da timeline já existente,
mostrar um cartão resumo — avatar com iniciais, "vista há Xh", última UC lida, barra de progresso do
dia, e uma projeção de quanto tempo falta pra terminar o serviço.

Achado no protótipo (`pintaCracha()`/`#f-cracha`, `olho.html:5016-5110` + CSS `olho.html:666-723`) —
o "cartão de pessoa" (crachá): mesma lógica, mesmos limiares (`ANEL_VIVO_MIN=15`,
`ANEL_MORNO_MIN=60` minutos desde a última posição reportada, decidindo o anel verde/âmbar/cinza ao
redor do avatar) e a mesma fórmula de projeção (`tempoTrabalhado ÷ realizadas × pendentes`).
Traduzido literalmente pro novo componente `colaborador-cracha` (`.ts`/`.html`/`.css`), montado dentro
de `mapa-bases.html` no canto superior esquerdo do mapa — canto livre desde que os controles de tipo
de mapa/camadas viraram uma barra em fluxo normal acima do mapa (rodada 5/6).

Reaproveitado o que já existia, sem nenhuma chamada nova ao backend: `formatarDuracao`/
`formatarTempoParado` (idênticas às funções `duracao()`/`desde()` do protótipo), `scalefusionDe()`/
`segsatDe()` (mesma regra `ehMoto` de `mapa-bases.ts` decide qual das duas fontes de posição usar),
`atividadeDe()` e `jornadaPorColaborador()`.

**Adaptação consciente (única divergência do protótipo):** lá, a linha "às HH:MM, leu a UC..." mostra
o ponto no INSTANTE da régua de tempo (`atividadeNoInstante()`) — sem régua tocada, o protótipo
mostra "arraste a régua pra andar pelo dia". Como a régua (item pendente desta mesma rodada, ver
seção anterior) ainda não existe aqui, o crachá mostra a ÚLTIMA UC realizada do dia (mesmo conceito
de "último ponto" já usado no mapa, `ucUltimoPonto` em `mapa-bases.ts`) — quando a régua for
construída, essa linha passa a acompanhar a posição dela.

### Verificação

`npx tsc --noEmit` e `npx ng build --configuration production` limpos. Harness cobrindo os 2 estados
visuais: "vivo" (anel verde, com atividade e projeção calculada) e "frio" (anel cinza, sem atividade
hoje, texto "vista há" em vermelho, projeção mostrando "sem dado suficiente") — batendo com o anexo
de referência do usuário (mesmas iniciais "AG" pro nome de exemplo, mesmo formato de fórmula).

### Pendências (fora desta ADR, reafirmadas)

- Performance: segunda consulta lenta (`obterBaselineDigitadosPorLivro`) ainda pendente.
- Duplicidade de "PAULO SERGIO DA SILVA" — mesma pendência do Adendo 3.
- Aba Risco — inalterada.

## Adendo 10 — Rodada 10: régua de tempo (playback do dia)

Usuário pediu, com print de referência: uma barra de execução baseada na timeline, com play, que vai
"andando" pelos pontos do dia e move a timeline em destaque conforme passa. Isso reativa a régua de
tempo do protótipo — explicitamente adiada desde a Decisão de escopo original desta ADR ("a régua de
tempo... fica fora de escopo desta fase").

Achado no protótipo (`olho.html:4603-4617` constantes, `5435-5580` lógica, `.f-regua-caixa`/`#t-regua`
CSS `579-588`) — mecanismo completo: `extremos` (início/fim do dia, do primeiro ao último ponto ±15min,
span mínimo 1h), `instante` (posição do cursor em segundos do dia, nasce no FIM — "é o estado do dia
até agora"), um `<canvas>` desenhando eixo + marcas de hora + uma marca colorida por ponto (esmaecida
depois do instante) + cursor, `toca()`/`quadro()` (loop de animação via `requestAnimationFrame`,
avança `instante` por `dt × velocidade`, rebobina do fim se tocar de novo), e `aplicaInstante()`
(função central que sincroniza mapa, timeline e crachá a cada mudança de instante).

Traduzido pra um novo componente `regua-tempo` (canvas próprio, mesmo desenho — eixo, marcas de hora,
tiques coloridos, cursor navy) montado dentro de `mapa-bases.html`, abaixo do mapa (mesma coluna da
barra superior — não estica pra trás do painel de detalhe, que é coluna à parte). Estado
(`reguaInstante`/`reguaTocando`/`reguaVelocidade`/`reguaExtremos`) vive em `ColaboradoresService` —
compartilhado entre o controle, o mapa e o crachá, mesmo padrão de `ucFocada`/`colaboradorSelecionado`
já usados ali.

**Cor dos tiques**: usa `corDaUc()` (já existente, mesma regra do mapa/timeline) em vez da lógica de
cor do protótipo — que não distinguia "a realizar" (sem `codigo`) de "normal", um gap que nosso app já
resolve. Pontos sem `hora_import` (ainda não realizados) não entram na régua — não têm posição no eixo
do tempo, mesmo comportamento do protótipo.

**Sincronização com o resto da tela** (equivalente a `aplicaInstante()`):
- **Timeline** (`colaborador-detalhe.html`): um novo `effect` no service seta `ucFocada` pro ponto no
  instante atual — reaproveita o scroll+destaque que já existiam pra clique num ponto do mapa. Só
  dispara quando a régua está TOCANDO ou já foi arrastada (`instante !== extremos.fim`) — na posição
  de repouso inicial (colaborador recém-aberto) não força nenhum scroll indesejado.
- **Crachá** (`colaborador-cracha.ts`): a linha "às HH:MM, leu a UC..." passou a usar `reguaInstante`
  (ver Adendo 9 — antes usava sempre o último ponto do dia; como a régua nasce no fim, o
  comportamento em repouso é idêntico).
- **Mapa** (`mapa-bases.ts`): o marcador de "último ponto" (ícone de localização real,
  `iconeUltimoPonto`) agora acompanha o instante da régua em vez de ser sempre o último ponto
  cronológico absoluto — arrastar/tocar a régua move esse marcador ponto a ponto.

**Simplificação consciente (não implementada nesta rodada):** o protótipo também ESMAECE (opacidade
reduzida) todos os pontos/segmentos futuros diretamente no MAPA em si, não só no canvas da régua —
nosso mapa usa marcadores Leaflet reais (não um canvas próprio como o protótipo), e replicar esse
esmaecimento exigiria tocar toda a lógica de criação/atualização de marcador e segmento em
`atualizarRotaJornada`. Como o pedido do usuário focou explicitamente na régua + timeline em destaque
(não mencionou o mapa esmaecendo pontos futuros), isso ficou de fora — o mapa segue mostrando a rota
inteira do dia, só o marcador de "último ponto" acompanha a régua. Fica como possível next step se o
usuário quiser esse efeito também no mapa.

### Verificação

`npx tsc --noEmit` e `npx ng build --configuration production` limpos. Harness reproduzindo a mesma
matemática de desenho (dados fake com pausa/impedimento/reincidente) confirmou visualmente: eixo,
marcas de hora, tiques nas cores certas, cursor na posição certa. Testado via `javascript_tool`
(a Browser pane não avança `requestAnimationFrame` em aba automatizada, limitação do ambiente, não do
código): "voltar ao início" e "play" alternam estado e ícone corretamente; simulação manual do passo
do quadro (`dt × velocidade`) confirma avanço correto do instante; simulação de estourar o fim confirma
que trava exatamente em `extremos.fim` e para de tocar; instante no meio do dia confirma pontos
passados nítidos e futuros esmaecidos (alpha 0.25).

### Pendências (fora desta ADR, reafirmadas)

- Esmaecimento de pontos/segmentos futuros diretamente no mapa (Leaflet) — não implementado nesta
  rodada, ver nota de simplificação acima.
- Performance: segunda consulta lenta (`obterBaselineDigitadosPorLivro`) ainda pendente.
- Duplicidade de "PAULO SERGIO DA SILVA" — mesma pendência do Adendo 3.
- Aba Risco — inalterada.

## Adendo 11 — Rodada 11: crachá mostrando "nenhuma UC" indevidamente + projeção desligada

Usuário reportou, com print, o crachá de CLAUDENEI CAJUEIRO DA SILVA mostrando "Nenhuma UC realizada
hoje" e "vista há nunca" ao mesmo tempo que a barra de progresso já mostrava 391 concluído/13 com
impedimento/676 a realizar (dado real de atividade, vindo de `atividadeDe()`) — e uma projeção de
"8h 47min pra fechar o serviço" calculada em cima desse mesmo dado.

**Causa**: `ultimoPonto` (Adendo 10) passou a depender de `reguaInstante()`, que só existe depois que
a JORNADA (não a atividade — são fontes diferentes, `jornadaPorColaborador()` vs `atividadeHoje()`)
termina de carregar pra aquele colaborador. Entre abrir o colaborador e a jornada chegar (ou se ela
demorar/falhar), `reguaInstante()` fica `null`, e o crachá mostrava "nenhuma UC" mesmo com atividade
real — o usuário pediu: "onde mostra a UC tem que sempre mostrar a última".

**Correção**: `ultimoPonto` agora tenta o ponto no instante da régua primeiro, mas SEMPRE cai pro
último ponto realizado (busca sem depender de `reguaInstante`) se a busca por instante não achar
nada — nunca mais regride pra "nenhuma atividade" só por causa do estado transitório da régua/jornada.

**Projeção desligada por pedido explícito** ("põe dois traços por enquanto"): `projecaoSegundos()`
agora sempre retorna `null` — o template já cai sozinho no estado `semProjecao` ("—" + "sem dado
suficiente pra projetar"), sem precisar mexer no HTML. Conta original comentada no próprio método,
pra reativar rápido quando o usuário pedir de volta.

### Verificação

`npx tsc --noEmit` e `npx ng build --configuration production` limpos.

### Pendências (fora desta ADR, reafirmadas)

- Projeção "tempo pra fechar o serviço" — desligada por pedido do usuário, código preservado
  comentado em `colaborador-cracha.ts` pra reativar quando pedido.
- Esmaecimento de pontos/segmentos futuros diretamente no mapa (Leaflet) — não implementado, ver
  Adendo 10.
- Performance: segunda consulta lenta (`obterBaselineDigitadosPorLivro`) ainda pendente.
- Duplicidade de "PAULO SERGIO DA SILVA" — mesma pendência do Adendo 3.
- Aba Risco — inalterada.
