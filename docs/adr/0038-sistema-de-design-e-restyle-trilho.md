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
