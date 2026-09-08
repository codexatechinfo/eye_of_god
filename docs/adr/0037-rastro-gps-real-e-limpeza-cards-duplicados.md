# ADR 0037 — Camada "Rastro executado" (GPS real do dia) e limpeza de cards duplicados

## Contexto

Usuário mandou 3 pedidos sobre a aba Trilho:

1. Print do painel "CAMADAS" perguntando: a linha azul do mapa (marcada como "Trajetória do dia") é
   o trajeto de EXECUÇÃO (leituras) ou o histórico real do GPS? Pediu as duas opções, marcáveis/
   desmarcáveis independentemente.
2. Print com os cards do card expandido da lista lateral (esquerda) e do painel de detalhe
   (direita) circulados — reportou informação redundante entre os dois, pediu pra tirar os cards da
   esquerda e só levar pra direita o que não existe lá.
3. Investigar por que alguns colaboradores não têm registro de bateria.

## Investigação (item 1)

Conferido no código (`mapa-bases.ts`) antes de mexer: o painel "CAMADAS" já tinha 7 itens, mas só 5
tinham `signal` de verdade — **"Rastro executado" e "Paradas e gaps" eram checkboxes desabilitados
("Ainda não implementado")**, nunca chegaram a ser construídos. A linha azul que o usuário via no
mapa era inteiramente "Trajetória do dia" (`camadaSequencia`) + "Pontos coletados"
(`camadaPontos`) — as duas construídas a partir da mesma fonte, `PontoJornada`
(`obterJornadaColaborador`, uma linha por UC LIDA): é o **trajeto de execução**, inferido de
onde/quando cada leitura aconteceu, conectando os pontos em ordem cronológica — **não é GPS
contínuo**. Resposta direta ao usuário: a linha que ele via era só a de execução; a de GPS real
nunca existiu na tela.

Achado que resolveu o "Rastro executado" nunca ter saído do papel: as tabelas `scalefusion`
(pedestre) e `segsat_posicoes` (motoqueiro) — criadas nas ADR 0033/0034 pra alimentar só a última
posição conhecida no mapa — já guardam o HISTÓRICO completo (uma linha por coleta, não
sobrescrita). Conferido ao vivo: um pedestre teve 330 posições coletadas num único dia, um
motoqueiro 28 — dado suficiente pra desenhar uma trilha real.

## Decisão (item 1)

Nova camada "Rastro executado", agora com `signal` de verdade (`camadaRastroGps`), sourced do
histórico do dia inteiro de `scalefusion`/`segsat_posicoes` — trajeto GPS bruto do aparelho/moto,
INDEPENDENTE de "Trajetória do dia" (que continua existindo do jeito que estava, sem nenhuma
mudança). As duas ficam marcáveis/desmarcáveis separadamente, exatamente como pedido.

- Backend: `obterHistoricoPosicoes(db, colaborador, dataIso)` em `scalefusionService.js` e
  `segsatFrotaService.js` — `SELECT ... WHERE colaborador = $1 AND data_hora_posicao::date =
  $2::date ORDER BY data_hora_posicao ASC`. As duas colunas de data dessas tabelas já são
  `timestamptz` (ao contrário do resto do schema, texto `DD/MM/YYYY`) — sem o risco de fuso horário
  que motiva tanto cuidado em outras partes do código, `::date` já basta. Endpoint novo `GET
  /colaboradores/gps-historico?colaborador=X&data=YYYY-MM-DD&fonte=scalefusion|segsat` — `fonte`
  vem do FRONTEND (que já sabe o cargo do colaborador, mesma regra `ehMoto` já usada em
  `atualizarMarcadoresColaboradores`/`verNoMapa`), evita reconsultar cargo no servidor.
- Frontend: `ColaboradoresService.carregarGpsHistorico(nome, fonte)` +
  `gpsHistoricoPorColaborador` (mapa por colaborador, mesmo padrão de `jornadaPorColaborador`).
  `mapa-bases.ts` busca de forma **opt-in** — só quando a camada está ligada, mesmo raciocínio já
  estabelecido pra "Limites municipais" (ADR 0022 Adendo 2): evita chamada de rede pra quem nunca
  abre a camada. `rastroGpsChaveAtual` (colaborador+data+fonte) evita rebuscar a cada refresh de
  60s do mesmo dia.
- Visual: linha cinza fina tracejada (`#6b7280`, weight 2, opacity 0.55, `dashArray: '2 6'`), de
  propósito discreta — é uma camada de CONFERÊNCIA ("onde o aparelho realmente esteve"), não deve
  competir visualmente com "Trajetória do dia" (mais grossa, colorida por tipo de transição) quando
  as duas estão ligadas ao mesmo tempo.

### Verificação

`obterHistoricoPosicoes` testado direto contra o banco real: pedestre com 330 pontos hoje, primeiro
às 00:00:27 último às 18:40:27 (cobre o dia inteiro); motoqueiro com 28 pontos SEGSAT; colaborador
inexistente devolve array vazio (sem erro). `npx tsc --noEmit`, `npx ng build --configuration
production` e `npm test` (18/18) limpos.

## Decisão (item 2) — cards duplicados

Comparado campo a campo: o card expandido da lista lateral (8 indicadores: Km percorrido, Sem
sincronizar há, Leituras, Realizadas, A realizar, Impedimentos, Livros, Livros em execução) e o
painel de detalhe (8 indicadores: Leituras/min, Livros em execução, Improdutivo, Km percorrido, Sem
sincronizar há, Realizadas, A realizar, Impedimentos) — **os dois abrem juntos** (mesmo
`colaboradorSelecionado`), e 6 dos 8 cards da esquerda já existiam idênticos à direita. Só
"Leituras" (total = realizadas + pendentes) e "Livros" (total atribuído, diferente de "Livros em
execução") existiam SÓ na esquerda.

Grid de indicadores inteiro removido de `lista-colaboradores.html` (o card expandido da lista
lateral agora só mostra jornada + lista de livros do dia, sem repetir números que já aparecem do
lado direito). Os dois valores exclusivos ("Leituras" e "Livros") migraram pro painel de detalhe
(`colaborador-detalhe.html`), mesmo estilo visual dos cards já existentes lá. `semSincronizarCritico`
e a importação de `LIMITE_PARADO_MINUTOS` em `lista-colaboradores.ts` ficaram órfãos com a remoção
(só eram usados dentro do grid apagado) — removidos junto.

### Verificação

`npx tsc --noEmit` e `npx ng build --configuration production` limpos.

## Investigação (item 3) — colaboradores sem registro de bateria

Consultado direto no banco: **79 de 352 colaboradores ativos (22%) nunca tiveram um único registro
em `scalefusion`** (nem um battery/posição, desde que a tabela existe). Descartadas três hipóteses
antes de concluir:

- **Não é problema de nome/typo**: cruzado cada um dos 79 contra os 285 nomes distintos extraídos
  de `nome_dispositivo` (mesmo regex do parser) — zero coincidência. Se fosse erro de grafia, bateria
  algum nome parecido; não bate nenhum, exato ou aproximado.
- **Não é concentrado em admissão recente**: só 21 dos 79 foram admitidos a partir de 01/09/2026;
  os outros 58 (73%) já trabalham há mais tempo — descarta "ainda não deu tempo de receber o
  aparelho".
- **Não é concentrado em cargo ou regional**: proporção praticamente igual em todo cargo
  (LEITURISTA 22%, LEITURISTA MOTOCICLISTA 22%, MONITOR 33% — mas é só 1 de 3) e toda base/regional
  (de 8% em Toledo a 33% em Cascavel/Apucarana, sem nenhuma base zerada nem perto de 100%).

Conclusão: os 79 simplesmente não têm nenhum dispositivo cadastrado na Scalefusion com o nome deles
— não é bug de correspondência no código (a mesma lógica de match já usada em `coletarPosicoes`
funciona perfeitamente pros outros 273), é uma lacuna de cadastro/provisionamento de aparelho, fora
do alcance deste sistema corrigir sozinho (ação é do lado da administração da Scalefusion/MDM, não
deste app). Não gerou mudança de código — reportado ao usuário como achado.

## Adendo 1 (2026-09-07) — texto "Sem leituras novas hoje" lia como contradição + header mais slim

Usuário, com print: colaborador com "Sem leituras novas hoje" no card, e logo abaixo a lista
"LIVROS HOJE" com 5 livros atribuídos (todos 0/1, nenhum lido ainda). Perguntou: como assim "sem
leituras" se tem livro ali embaixo?

Não é bug de dado — os dois vêm de fontes diferentes por design: `jornada.semDado` (mensagem
acima) reflete `base_dados_leitura` vazia pro colaborador na data (nenhuma UC REALIZADA hoje);
"Livros hoje" (`a.livros`, de `contr_execucao_leitura`/massiva) é a ATRIBUIÇÃO do dia,
independente de já ter sido lida ou não — um colaborador pode (e frequentemente tem) livro
atribuído sem ainda ter lido nada dele. O dado está certo; o TEXTO que sugeria contradição
("sem leituras" bem em cima de uma lista de livros) é que precisava mudar. Trocado pra "Nenhuma
leitura realizada ainda hoje" — deixa claro que é sobre o que já foi CONCLUÍDO, não sobre o que
está atribuído.

Também nesta rodada: barra de navegação superior (header) reduzida — container `py-2.5` → `py-1`,
botões das abas `py-1.5` → `py-1` (+ `px-3` → `px-2.5`), logo `h-7` → `h-5`, pílula de status
`py-1` → `py-0.5`, botão "Sair" `py-1.5` → `py-1`.

### Verificação

Réplica com o CSS real compilado do projeto, header antigo e novo lado a lado, altura medida via
`getBoundingClientRect()`: 125px → 105px (16% mais fino), sem quebrar layout/legibilidade dos
textos (mantidos `text-xs`, só o respiro ao redor encolheu). `npx tsc --noEmit` e `npx ng build
--configuration production` limpos.

## Adendo 2 (2026-09-07) — barra de filtros da sidebar removida da aba Trilho

Usuário, com print: remover a barra de filtros (Etapa/Regional/Buscar colaborador/Cargo/Data/
Limpar) do topo da lista lateral da aba Trilho.

`app-filtros-colaboradores` (componente próprio, 68 linhas, usado só ali — conferido com grep no
projeto inteiro) removido de `lista-colaboradores.html`, import tirado de `lista-colaboradores.ts`,
e o componente inteiro apagado (`filtros-colaboradores/`) — ficaria órfão sem nenhum outro lugar
que o usasse.

Os signals de filtro em `ColaboradoresService` (`filtroEtapa`/`filtroRegional`/
`filtroColaborador`/`filtroCargo`/`filtroData`) e os métodos que eles disparavam (`buscar`,
`buscarComDebounce`, `onFiltroDataChange`, `limparFiltros`) **não foram removidos** — continuam
usados por outras partes do app independente dessa UI: `buscar()` é a chamada que carrega o roster
inteiro (`colaboradores()`, base de tudo — mapa, as duas abas de Monitoramento etc.), disparada uma
vez no início independente de filtro; `filtroData` decide "hoje vs. dia passado" em cascata pra
jornada/localizações/etc.; `regionais()`/`cargos()` já são reaproveitados pelos filtros próprios da
aba Monitoramento Colaborador (ADR 0036). Sem a UI, os filtros de busca (etapa/regional/
colaborador/cargo) simplesmente nunca mudam de `''` — equivalente a estarem sempre "limpos", exibe
o roster inteiro sem filtro, exatamente o efeito esperado ao remover a barra.

### Verificação

`npx tsc --noEmit` e `npx ng build --configuration production` limpos (bundle ligeiramente menor,
confirma a remoção).

## Adendo 3 (2026-09-07) — spinner no mapa enquanto a rota do colaborador carrega

Usuário: abrir um colaborador (ou "Ver no mapa") demora um tempo considerável até a rota aparecer
no mapa, sem nenhum indicativo de que algo está carregando — parecia travado.

Causa: a linha só é desenhada quando `jornadaPorColaborador` recebe a resposta de `GET
/colaboradores/jornada` (query pesada, cruza vários livros do dia — ver `obterJornadaColaborador`);
até lá, nada na tela mudava.

`ColaboradoresService.carregarJornada` ganhou um parâmetro `interativo` (default `false`) — só
liga o novo signal `carregandoJornada` quando é `true`. Chamado com `true` nos dois lugares onde é
o usuário esperando (`selecionarColaborador`/`abrirColaborador` — cobre clique na lista, no ícone
do mapa e "Ver no mapa"); o refresh silencioso de 60s (`carregarJornada(nome)` sem o parâmetro, na
função que já existia pra manter a timeline atualizada) continua sem tocar no spinner — mostrar um
spinner a cada minuto por um refresh em segundo plano seria ruído, não ajuda em nada.

`mapa-bases.html` ganhou um wrapper `relative` em volta do `<div #mapaEl>` (antes era o único
elemento raiz) e uma pílula flutuante (`position: absolute`, topo centralizado,
`pointer-events-none` — não bloqueia interação com o mapa) com ícone girando
(`animate-spin`) e "Carregando rota do colaborador...", visível enquanto
`colaboradoresService.carregandoJornada()` for `true`.

### Verificação

Réplica com o CSS real compilado do projeto: pílula branca translúcida, ícone azul girando,
centralizada no topo — visual limpo, não cobre o mapa. `npx tsc --noEmit` e `npx ng build
--configuration production` limpos.

## Adendo 4 (2026-09-07) — "Rastro executado" ligado não mostrava nada

Usuário, com print: ligou a camada e só via a "Trajetória do dia" de sempre, nada do rastro GPS
novo.

Investigação eliminou hipóteses de dado/lógica antes de chegar na causa real: `obterHistoricoPosicoes`
testado direto contra o banco pra três motoqueiros reais de hoje — retorna pontos válidos
normalmente (28 a 330 por dia, dependendo do colaborador); a lógica dos dois `effect()` (decidir
quando buscar, redesenhar quando o dado chega) revisada e confirmada correta linha a linha, sem
race condition. A causa era puramente visual: o estilo escolhido (`dashArray: '2 6'`, `opacity:
0.55`, cinza claro `#6b7280`) pensado pra ficar "discreto" tinha um problema real — pontos de GPS
consecutivos ficam bem próximos um do outro, e cada segmento curto entre dois pontos não tem
comprimento suficiente pra sequer desenhar um traço completo do padrão tracejado. Confirmado ao
vivo com Leaflet de verdade (sem tile de mapa, só isolando a linha) usando coordenadas reais de um
motoqueiro (80 pontos, rota real): o tracejado sai cheio de buracos, quase invisível; a MESMA
trilha em linha sólida sai nítida.

Estilo trocado: linha sólida, mais escura (`#475569` em vez de `#6b7280`), um pouco mais grossa
(`weight: 2.5`) e mais opaca (`0.75`) — ainda visualmente mais discreta que "Trajetória do dia"
(`weight: 3`, cores vivas por tipo de transição), mas agora realmente aparece.

### Verificação

Réplica isolada com Leaflet real e 80 pontos reais de um motoqueiro (rota com ida e volta, boa
variação espacial) — estilo antigo (tracejado) renderiza fragmentado e apagado; estilo novo
(sólido) renderiza como uma linha contínua e legível. `npx tsc --noEmit` e `npx ng build
--configuration production` limpos.

## Adendo 5 (2026-09-07) — "Setor planejado" no oceano, "Paradas e gaps" ligado a "Trajetória do dia" e painel fechando ao arrastar o mapa

Usuário, com 2 prints e um pedido de 5 itens: (1) e (2) voltaram a perguntar o que é "Rastro
executado" e "Trajetória do dia" — resposta é a mesma do item 1 original e do Adendo 4 (execução ≠
GPS real; ver acima), possivelmente o print é anterior à correção visual do Adendo 4. (3) o
polígono de "Setor planejado" de um colaborador esticava do Paraná até dentro do oceano Atlântico.
(4) desmarcar "Trajetória do dia"/"Pontos coletados" também apagava os indicadores de pausa e de
troca de município/livro, sem jeito de escondê-los separadamente — o checkbox "Paradas e gaps" já
existia no painel, mas nunca tinha sido implementado (ver Contexto/item 1: era um dos dois
checkboxes desabilitados "Ainda não implementado"). (5) mover (arrastar) o mapa fazia o painel de
detalhe do colaborador (e sua execução no mapa) sumir sozinho.

### Item 3 — polígono no oceano

Causa raiz: `pontosValidosDoDia()` (usada tanto pelo casco convexo de "Setor planejado" quanto por
"Limites municipais") chamava `Number(item.latitude)`/`Number(item.longitude)` direto, sem checar
antes se o valor existia. UCs cuja coordenada não foi minerada (`LEFT JOIN` com
`coordenadas_ucs_mineradas` em `obterJornadaColaborador`, que pode não casar) chegam com
`latitude`/`longitude` `null` — e `Number(null)` é `0` (finito, passa `Number.isFinite` sem
problema), não `NaN`. Esse ponto fantasma em `(lat_real, 0)` ou `(0, lng_real)` — ou seja,
exatamente em cima da linha do Equador/meridiano de Greenwich, longe do Paraná — entrava no casco
convexo e esticava o polígono até lá, cruzando o oceano no caminho.

Corrigido filtrando `latitude`/`longitude` truthy ANTES do `Number()` (mesmo padrão já usado em
`validos` no restante do arquivo — `pontosValidosDoDia` era a única função que ainda não seguia
essa regra):

```ts
private pontosValidosDoDia(pontos: PontoJornada[]): L.LatLngTuple[] {
  return pontos
    .filter(item => item.latitude && item.longitude)
    .map((item): L.LatLngTuple => [Number(item.latitude), Number(item.longitude)])
    .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
}
```

### Item 4 — "Paradas e gaps" ativado

Antes, marcadores de pausa (`tipo === 'pausa'`) moravam em `grupoPontos` junto com os pontos
normais, e os segmentos coloridos (pausa/mudou de livro/mudou de município — ver `corDoSegmento`)
moravam em `grupoSequencia` junto com os segmentos normais. Não existia camada separada pra eles,
então desligar "Pontos coletados" ou "Trajetória do dia" (as únicas duas camadas que realmente
existiam ali) levava esses indicadores junto — mesmo sem o usuário querer especificamente escondê-
los.

Criada `grupoParadasGaps`, camada nova de verdade (signal `camadaParadasGaps`, `effect` de
sincronização, item ativo no painel — substituindo o antigo checkbox desabilitado). Roteamento em
`atualizarRotaJornada()`:

- Segmento (linha entre dois pontos consecutivos): vai pra `grupoParadasGaps` quando
  `tipo_intervalo === 'pausa' || mudou_livro || mudou_municipio` (`ehSegmentoEspecial`, mesmo
  critério de `corDoSegmento`); senão continua em `grupoSequencia`. Precisou de um array de
  rastreio próprio (`segmentosParadasGaps`, espelhando `segmentosRota`) pra saber o que remover a
  cada refresh.
- Marcador de ponto: `tipo === 'pausa'` vai pra `grupoParadasGaps`; `'normal'`/`'ultimo'` continuam
  em `grupoPontos` (novo helper `grupoDoTipoPonto(tipo)`). Os três lugares que antes chamavam
  `this.grupoPontos.removeLayer(...)` direto (reset ao fechar o painel, remoção por troca de tipo
  entre refreshes, limpeza final de UCs que saíram da lista) passaram a usar o helper — sem isso, o
  marcador de uma UC que virou "pausa" ficaria "preso" tentando ser removido do grupo errado.

Camada nova nasce **ligada por padrão** (`camadaParadasGaps = signal(true)`) — preserva o
comportamento atual (indicadores sempre visíveis) até o usuário optar por desmarcar.

### Item 5 — painel fechando ao arrastar o mapa

Investigação descartou qualquer `colaboradorSelecionado.set(null)` explícito fora de
`ColaboradorDetalhe.fechar()` e qualquer handler de `moveend`/`dragend`/`zoomend` no mapa (nenhum
existe). O culpado é um comportamento nativo do browser/Leaflet: soltar o botão do mouse depois de
arrastar (pan) o mapa dispara um evento `click` normal no `document` — que `aoClicarFora` (o
`@HostListener('document:click', ...)` que fecha o painel ao clicar fora dele) não tinha como
distinguir de um clique de dispensa genuíno, já que o alvo do evento (dentro do mapa) não estava na
lista de exceções... exceto que ESTAVA (`app-mapa-bases` já é exceção) — o caso real reportado
envolvia arrastar terminando fora da área do mapa (ex.: sobre a lista ou área neutra da página)
quando `mousedown` começa dentro do mapa, ou vice-versa, escapando das exceções por seletor.

Corrigido de forma mais geral do que enumerar seletores: novo `@HostListener('document:mousedown')`
guarda a posição do clique; `aoClicarFora` agora só fecha o painel se o `click` terminar a até 5px
de onde o `mousedown` começou — acima disso, trata como arraste e ignora. Limiar pequeno o
suficiente pra não perder um clique de dispensa genuíno com leve tremor da mão, grande o bastante
pra cobrir qualquer arraste real de pan do mapa.

### Verificação

Item 3: mesma função `pontosValidosDoDia` já coberta por teste anterior (Adendo do "Rastro
executado") — reconferida a lógica: `null`/`undefined`/`''` agora são descartados antes do
`Number()`, só passam valores realmente numéricos. Item 4: `grep` confirmou que os três pontos de
remoção de marcador (`this.grupoPontos.removeLayer`) foram todos trocados pro helper
`grupoDoTipoPonto`, e que `segmentosParadasGaps` é limpo nos mesmos três lugares onde
`segmentosRota` já era (reset do painel, início do rebuild). Item 5: revisão de código confirma que
`posicaoMousedown` é atualizado em TODO `mousedown` do documento (não só dentro do mapa), então
cobre arrasto iniciado ou terminado em qualquer lugar da página. `npx tsc --noEmit` e `npx ng build
--configuration production` limpos (sem erros novos, só os warnings pré-existentes de budget do
bundle e do pacote `leaflet` não ser ESM).

## Adendo 6 (2026-09-07) — "Rastro executado" sem dado (gap de cadastro) + "última leitura" com horário errado

Usuário, com print de um motoqueiro específico (Paulo Aparecido de Azevedo Ferreira): (1) "Rastro
executado" continuava sem exibir nada; (2) o ícone do motoqueiro no mapa mostrava tooltip "última
leitura em 07/09/2026 13:20:33", mas a UC mais recente na timeline dele (115936467) tinha horário
13:32:42 — mais tarde, ou seja, o tooltip não era realmente a "última" leitura.

### Item 1 — investigado, não é bug de código

Consultado direto no banco pra este colaborador: **zero linhas em `segsat_posicoes` hoje, e zero
linhas na tabela de mapeamento `segsat` (placa↔colaborador) com o nome dele** — ele nunca teve
veículo vinculado nessa planilha. Ampliando a consulta pra todos os motoqueiros ativos: **58 de 286
(20%) têm mapeamento em `segsat`; só 21 têm alguma posição registrada hoje**. Mesma classe de
achado já documentada no Contexto desta ADR pro gap de Scalefusion (79/352 sem dispositivo
cadastrado) — aqui a lacuna é proporcionalmente maior (80% dos motoqueiros sem veículo mapeado).
Não é bug de correspondência de nome nem de lógica de coleta (`coletarPosicoes` funciona
perfeitamente pros 58 que estão mapeados); é lacuna de cadastro/provisionamento da planilha SEGSAT
(ADR 0034), fora do alcance deste sistema resolver sozinho — reportado ao usuário como achado, sem
mudança de código. "Rastro executado" só pode mostrar rastro pra quem tem posição coletada.

### Item 2 — bug real, corrigido

Causa: `obterUltimaUcRealizadaPorColaborador` (fonte do tooltip "última leitura" e da coluna
"Último registro" da aba Monitoramento Colaborador) usava um `JOIN` (não `LEFT JOIN`) com
`coordenadas_ucs_mineradas` **dentro do mesmo `DISTINCT ON`** que escolhe a leitura mais recente do
colaborador — decisão de design original documentada no próprio comentário da função (pular pra
uma leitura anterior do mesmo dia se a mais recente não tiver coordenada minerada, pra sempre
conseguir posicionar o pino no mapa). Funcionava pra POSIÇÃO, mas o mesmo `JOIN` também filtrava
qual `hora_import` era retornado — quando a leitura genuinamente mais recente (UC 115936467, sem
coordenada minerada — confirmado: zero linhas pra ela em `coordenadas_ucs_mineradas`) ficava de
fora, o horário exibido regredia pra uma leitura mais antiga (UC 43353258, que tem coordenada),
divergindo da timeline (`obterJornadaColaborador`, que não exige coordenada pra listar uma UC).

Corrigido separando as duas responsabilidades em CTEs distintas: `ultima_leitura` (sem exigir
coordenada — sempre a leitura genuinamente mais recente do dia, o que é mostrado como
`data_import`/`hora_import`) e `ultima_posicao` (com o `JOIN`, escolhe a leitura mais recente COM
coordenada — o que decide `latitude`/`longitude` do pino), unidas por `LEFT JOIN` no final. O
horário exibido agora sempre bate com a timeline; a posição do pino continua sendo uma aproximação
(a leitura com coordenada mais próxima no tempo) quando a leitura real mais recente não tem
coordenada — inevitável, não tem onde desenhar um pino sem coordenada, mas pelo menos não finge
mais que aquele é o horário real.

### Verificação

Testado direto contra o banco, antes e depois, pro colaborador do print: antes, `hora_import`
`13:20:33` (UC 43353258, errado); depois, `hora_import` `13:32:42` (bate com a timeline), mantendo
`latitude`/`longitude` do UC 43353258 (aproximação necessária, coerente). Rodada a função pra TODOS
os colaboradores do dia (24 linhas) — nenhuma ficou sem posição que já não ficasse sem antes (mesma
cobertura de lat/lng, só o horário mudou). `npm test` (18/18) limpo.
