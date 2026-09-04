# ADR 0030 — Painel lateral vira timeline do DIA do colaborador (não mais de um livro só)

## Contexto

O painel lateral direito (aberto ao clicar num colaborador ou no ícone dele no mapa) mostrava a
timeline de UCs de UM livro selecionado — cada livro tinha que ser aberto separadamente pra ver o
que aconteceu nele. Usuário pediu 4 mudanças:

1. A lista "Livros hoje" dentro do card do colaborador na sidebar continua aparecendo, mas os
   livros deixam de ser clicáveis — viram só informação.
2. Clicar no colaborador (na lista ou no ícone do mapa) abre o painel mostrando o histórico de
   execução do DIA INTEIRO do colaborador, cruzando todos os livros dele — não mais um livro
   isolado.
3. Na timeline do dia: mudança de município ou de livro entre dois pontos consecutivos precisa
   ficar visível, tanto na lista quanto como linha colorida no mapa; pausa (intervalo acima do
   limite por etapa) faz o marcador da UC virar um ícone de pausa em vez da bolinha colorida.
4. Cada linha da timeline mostra, abaixo do endereço: UC, depois livro (antes era só "Livro X ·
   #sequência"); expandir mostra o resto dos campos da UC.

## Decisão

### Backend: `obterJornadaColaborador` passa a expor a lista ponto-a-ponto

A query já buscava todas as UCs do colaborador no dia, cruzando todos os livros, em ordem
cronológica — só descartava a lista depois de somar os agregados. Agora o `SELECT`/`LEFT JOIN`
também traz `mensagem`/`equipamento` (pra `codigo` via `extrairCodigoDeMensagem`) e
`nom_municipio`/`localidade`/`endereco`/`classe_principal`/`sequencia` de
`coordenadas_ucs_mineradas`. Cada ponto ganha o segmento em relação ao ponto cronologicamente
anterior (mesmo padrão de `anexarSegmentosDeslocamento` em `monitoramentoService.js`, reaproveitando
`calcularSegmento` de `deslocamentoService.js` sem alterá-lo) mais duas flags novas, que só fazem
sentido cruzando livros: `mudou_livro` (comparação direta de `livro`) e `mudou_municipio`
(comparação de `nom_municipio`, só quando os dois lados têm o dado). Resposta ganha `pontos: [...]`
— agregados (`trabalhadoSegundos` etc.) continuam idênticos.

Endpoint (`GET /colaboradores/jornada`) e controller não mudaram — só repassam o objeto maior.

### Frontend: `TimelineUcItem`/painel por-livro removidos, `PontoJornada` no lugar

`colaboradores.service.ts`: `TimelineUcItem` virou `PontoJornada` (ganhou `livro`, `mudou_livro`,
`mudou_municipio`; perdeu os campos que só existiam vindo de abertura de OS — sempre `null` desde
a ADR 0028). Removidos por completo (só serviam ao painel por-livro): `livroSelecionado`,
`abrirLivro`, `fecharLivro`, `buscarUcsLivro`, `timelineLivro`, `atuaisLivro`,
`distanciaTotalLivro`, `carregandoTimelineLivro`, `erroTimelineLivro`, `intervaloUcsLivroId`,
`realizadasLivro`, `aRealizarLivro`, `impedimentosLivro`, `ordenarPorSequencia` (lista do dia já
vem cronológica, não por sequência). `selecionarColaborador`/`abrirColaborador` (já existentes,
inalterados) viram o único gatilho do painel. Polling de 60s do painel aberto passou a viver dentro
do `setInterval` geral já existente (recarrega a jornada do colaborador selecionado junto com
atividade/localizações), no lugar do `setInterval` próprio que `abrirLivro` mantinha.

`GET /massivas/livro-ucs`/`obterUcsDoLivro`/`anexarSegmentosDeslocamento` **não foram tocados** —
continuam servindo o modal de detalhe de livro da aba Massivas/Monitoramento de Livros
(`monitoramento.service.ts`, serviço completamente separado), que não faz parte desta mudança.

### Componente renomeado: `LivroDetalhe` → `ColaboradorDetalhe`

`pages/home/components/livro-detalhe/*` → `colaborador-detalhe/*`, selector `app-livro-detalhe` →
`app-colaborador-detalhe`. `*ngIf` do painel passa de `livroSelecionado()` para
`colaboradorSelecionado()` — fechar o painel (X ou clique fora) agora também fecha o card expandido
na lista, já que os dois são a mesma coisa agora (pedido do usuário: clicar no colaborador abre os
dois juntos). Cabeçalho mostra o nome do colaborador; cards de resumo (Realizadas/A realizar/
Impedimentos/Livros em execução/Último sincronismo) trocam a fonte de `atuaisLivro` (um livro) pra
`atividadeDe(nome)` (já dia-inteiro, todos os livros — não precisou de cálculo novo). Lista de UCs
itera `pontos` na ordem cronológica que já vem do backend, com indicador de mudança de
livro/município antes da linha (cor dedicada — ver abaixo) e ícone de pausa no lugar da bolinha
quando `tipo_intervalo === 'pausa'`. Removido `mudancasPorUc` (mudança de colaborador/situação por
UC, dependia de `timelineLivro`) — não tinha tradução direta pro conceito de dia inteiro; fica pra
pedir de volta se fizer falta.

### Mapa (`mapa-bases.ts`): rota/pontos/camadas passam a ser do dia, não do livro

- Marcador do colaborador no mapa: clique agora só chama `abrirColaborador` (a chamada a
  `abrirLivro` foi removida) — mesmo painel do dia que a lista já abre.
- Linha da rota: era uma polyline pontilhada "planejada" (ordem de sequência) + linhas de desvio
  vermelhas separadas quando a execução real pulava a ordem. Virou uma linha por PAR de pontos
  cronologicamente consecutivos (`segmentosRota`), cada uma colorida pela razão da transição —
  prioridade pausa (âmbar) > mudou de livro (fúcsia `#c026d4`) > mudou de município (teal
  `#0d9488`) > deslocamento normal (slate `#94a3b8`, mesma cor de antes). Usuário rejeitou
  simplificar removendo esse detalhe — pediu explicitamente que a transição entre livros/municípios
  ficasse marcada na própria linha, com a mesma cor do indicador da lista lateral.
- Pontos: `CircleMarker` colorido (mesma regra de sempre) trocado por um `L.marker` com ícone de
  pausa (mesmo desenho de duas barras usado na lista) quando o intervalo anterior daquele ponto foi
  classificado como pausa.
- "Setor planejado" (casco convexo): antes de todas as UCs do livro, agora de todas as UCs válidas
  do dia inteiro do colaborador.
- "Limites municipais": antes buscava/cacheava por livro (`limitesMunicipaisLivroAtual`), agora por
  chave colaborador+data (`limitesMunicipaisChaveAtual`) — mesma ideia, escopo maior.
- Checkbox do painel "Camadas" renomeado de "Sequência planejada" pra "Trajetória do dia" (mesmo
  grupo/toggle, `camadaSequencia` sem mudança de nome interno) — o conceito de "planejado vs real"
  não existe mais cruzando livros diferentes, só a trajetória real com a razão de cada mudança.

## Consequências

- Nenhuma mudança de schema — só `SELECT` mais largo numa query que já existia.
- Card "Livros hoje" na sidebar (lista de livros do colaborador) continua existindo, só perdeu o
  clique — vira puramente informativo (item 1 do pedido).
- Alguém que clicava um livro específico pra ver só a timeline DAQUELE livro perde essa
  granularidade — agora só existe a visão do dia inteiro. Não foi pedido preservar as duas.

## Verificação

`node --check` no arquivo backend alterado; `npm test` (12/12). `ng build` sem erro (cobre o
renome de componente/imports). Testado ao vivo contra o banco real (fora do navegador, sem
credencial de login pro app): `obterJornadaColaborador` rodado pra 3 colaboradores com atividade
hoje — 8/2/12 pontos respectivamente, `mudou_livro` detectado corretamente (2/1/3 transições),
`tipo_intervalo === 'pausa'` detectado (2 casos num colaborador com deslocamento maior),
agregados (`trabalhadoSegundos`/`distanciaMetros`) batendo com a cobertura real de coordenadas de
cada um (ex.: colaborador com só 1/8 pontos com coordenada corretamente deu trabalhado=0, sem
segmento válido pra calcular). `mudou_municipio` não apareceu na amostra (colaboradores testados
não trocaram de município no dia) — lógica idêntica à de `mudou_livro`, mesma fonte de dado já
usada em outros lugares (`nom_municipio` de `coordenadas_ucs_mineradas`), não teve caso positivo
pra confirmar visualmente nesta sessão.

Verificação visual completa (login, badge/ícone de pausa no mapa, cor das transições, painel
abrindo ao clicar) **pendente** — sem credencial de teste disponível nesta sessão; fica pro usuário
confirmar do lado dele.

## Adendo 1 (2026-09-04) — clique no nome não abria o painel; vermelho vira regime sucessivo; linha centraliza o mapa

Usuário testou a versão da ADR principal e reportou 3 ajustes, com print do mapa (linhas fúcsia/
laranja atravessando uma região enorme, do Foz do Iguaçu urbano até um ponto isolado perto do
aeroporto) e do card colapsado com um ponto vermelho.

### Bug: clicar no nome do colaborador na lista não abria o painel

`ColaboradorDetalhe.aoClicarFora` ([colaborador-detalhe.ts](../../../FRONTEND/src/app/pages/home/components/colaborador-detalhe/colaborador-detalhe.ts))
fecha o painel em qualquer clique fora dele, exceto dentro de `app-mapa-bases` — mas a lista lateral
(`app-lista-colaboradores`) não estava na exceção. Clicar no nome do colaborador (fora do mapa)
disparava `selecionarColaborador` (abre) E o `document:click` do painel (fecha) no MESMO evento —
abria e fechava no mesmo clique, parecendo "não fazer nada". Corrigido: `app-lista-colaboradores`
entrou na mesma exceção que `app-mapa-bases` já tinha.

### Vermelho vira "regime sucessivo" (>1 mês), não mais "código repetido em outra UC no mesmo dia"

`corDaUc` comparava o código de impedimento contra OUTRAS UCs no mesmo dia pra decidir vermelho —
usuário quer que vermelho signifique especificamente "essa UC recebeu o MESMO código por mais de 1
mês consecutivo" (conceito que já existia, `RegimeSucessivo`/`ciclosConsecutivos`, mas só aparecia
como texto no card expandido, nunca decidia a cor do ponto). `corDaUc` reescrita pra usar
`regimeSucessivoPorUc` em vez de `mapaPrimeiraUcPorCodigo` (removida — ficou sem uso). Como a cor
precisa estar certa ANTES de expandir (não é mais sob demanda), `carregarJornada`
(`colaboradores.service.ts`) passou a pré-carregar regime sucessivo de toda UC com código de
impedimento assim que a jornada do dia chega (`carregarRegimeSucessivo` já cacheia por UC, sem
refazer a busca em polls seguintes). Backend (`obterRegimeSucessivo`,
[monitoramentoService.js](../../../BACKEND/src/services/monitoramentoService.js)) passou a devolver
também `mesesConsecutivos: string[]` (a lista de meses, não só a contagem) — o loop que já contava
`ciclos` já tinha o mês de cada linha em mãos, só não guardava. Card expandido agora lista os meses.

### Linhas de transição centralizam o mapa ao clicar

O print mostrou o problema real: o `fitBounds` automático (primeira vez que abre um colaborador)
enquadra TODOS os pontos do dia — se um ponto isolado fica longe dos demais (ex.: perto do
aeroporto, no anexo), o mapa fica tão distante que não dá pra ver detalhe nenhum da região onde a
maioria dos pontos está. Cada segmento de `segmentosRota` ganhou um `click` que dá `fitBounds` só
nos 2 pontos daquele segmento (`padding: [60,60]`, `maxZoom: ZOOM_FOCO`) — clicar na linha da
transição leva direto pra região onde ela aconteceu.

### Indicador de troca de colaborador/devolução a Pendente do livro

Usuário perguntou se a timeline indica quando um livro que aparece no dia do colaborador passou
pra OUTRO colaborador, ou voltou pra "Pendente" — confirmou que não indicava, e pediu pra
implementar. `obterJornadaColaborador` ganhou uma segunda query, cruzando os livros distintos do
dia contra o estado ATUAL deles no roster (`contr_execucao_leitura`, o scraper de Acompanhamento
reescreve a cada ciclo — ADR 0028), independente de quem leu o quê em `base_dados_leitura`:
`DISTINCT ON (livro::int) ... ORDER BY livro::int, id DESC` pega a linha mais recente por livro
(join por `livro::int`, não string — mesmo cuidado de formato com/sem zero à esquerda entre as
duas tabelas, ADR 0025). Cada ponto ganha `livro_situacao_atual`, `livro_colaborador_atual`,
`livro_reatribuido` (colaborador atual existe e é diferente deste) e `livro_pendente`
(`situacao === 'Pendente'`). Badge neutro (slate, pra não competir com as cores de transição
geográfica) na linha colapsada quando qualquer um dos dois é `true`, com detalhe no card
expandido.

Diferente do antigo `mudancasPorUc` (removido nesta mesma ADR, comparava colaborador/situação
entre UCs de UM livro só via `buscarEventosLeitura`) — isso é sobre o estado atual do livro
inteiro no roster, não sobre variação dentro da lista de UCs.

Verificado ao vivo: 506/506 pontos de um colaborador real casaram corretamente com o roster
(situação e colaborador atual conferidos manualmente pra um ponto) — nenhum caso de reatribuição/
Pendente na amostra do dia testado (é esperado ser raro, não indica bug).

## Verificação (Adendo 1)

`node --check` no backend; `npm test` (12/12); `ng build` sem erro. `obterRegimeSucessivo` testado
ao vivo contra UCs reais com impedimento (`mesesConsecutivos` populado corretamente, ex.:
`ciclosConsecutivos: 1` → `["07/2026"]`) — não achei nenhuma UC real nesta base com
`ciclosConsecutivos > 1` pra confirmar visualmente o caso vermelho (pode ser raro nesta operação:
código repetindo no mesmo mês seguinte). Lógica de contagem/lista de meses validada à parte com
dado sintético (3 meses seguidos com o mesmo código → `ciclosConsecutivos: 3`, lista de meses na
ordem certa, parada correta ao bater um código/mês diferente). Verificação visual (clique no nome,
cor vermelha, clique na linha) segue pendente por falta de credencial de teste.

## Adendo 2 (2026-09-04) — cards "Último sincronismo" mostram há quanto tempo, não a hora

Os cards "Último sincronismo" (`lista-colaboradores.html`, colapsado e expandido, e
`colaborador-detalhe.html`) mostravam a HORA do último sincronismo (`ultimaMudancaHora.slice(0,
5)`, ex. "08:45"). Usuário pediu pra mostrar HÁ QUANTO TEMPO o colaborador não sincroniza — dado
que já existia pronto (`AtividadeColaborador.minutosParado`, é o mesmo valor que decide o toggle
Ativo/Sem sincronismo), só não estava sendo exibido nesses cards.

Nova função compartilhada `formatarTempoParado(minutos)` em `colaboradores.service.ts` — mesma
fórmula que já existia DUPLICADA em `monitoramento-view.ts` (usada no modal "sem comunicar 30min"),
agora só uma implementação; `monitoramento-view.ts` passou a chamar a versão compartilhada.
Rótulos dos cards mudaram de "Último sincronismo" pra "Sem sincronizar há", valor de
`ultimaMudancaHora` (hora) pra `minutosParado` formatado (ex. "23min", "1h 30min", "2d").

## Adendo 3 (2026-09-04) — card "Sem sincronizar há" vira vermelho passando do limite

Usuário reportou com print o card em azul mostrando "14h 36min" — quis o card virando vermelho
quando passa do mesmo limite que já decide Ativo/Sem sincronismo (`LIMITE_PARADO_MINUTOS`, 30min).
Novo método `semSincronizarCritico(minutos)` (`lista-colaboradores.ts`, card expandido, e
`colaborador-detalhe.ts`) troca a paleta azul → vermelha (borda/fundo/ícone/rótulo/valor) via
`[ngClass]` quando `minutos >= LIMITE_PARADO_MINUTOS`. Texto inline sob o nome na lista (sempre
visível, fora do card expandido) não mudou — usuário apontou especificamente "esse card" (o
card com ícone, não o texto solto).

## Adendo 4 (2026-09-04) — ícones do colaborador no mapa viram marker (pino), cores mantidas

`iconeColaborador` (`mapa-bases.ts`) desenhava um badge circular (círculo branco, borda colorida,
glifo dentro) pros ícones de moto/pedestre no mapa. Usuário pediu pra trocar por um marker
(pino de mapa), mantendo as mesmas cores (moto azul `#2563eb`, pedestre laranja `#ea580c`).
Path do pino é o formato padrão "map marker" (mesmo usado no Material Design Icons/Google Maps):
cabeça circular branca no topo com o glifo dentro (mesmo SVG de antes, só reposicionado/escalado
pra caber no círculo menor), corpo preenchido na cor com contorno branco, ponta embaixo.

Mudança importante: a âncora do ícone (`iconAnchor`) passou do CENTRO (badge circular, `[14,14]`)
pra PONTA DO PINO (base, `[15,39]`) — é a ponta que aponta pra coordenada real no mapa, mesmo
comportamento de qualquer marker de mapa padrão. O offset do tooltip do marcador de colaborador
foi ajustado junto (`[0,-14]` → `[0,-39]`) pra continuar aparecendo acima do pino, não no meio dele.

Não verificado visualmente no navegador nesta sessão (sem servidor local disponível pra
renderizar o SVG isolado) — path matemático conferido (fórmula padrão de map-marker, transform de
centralização/escala do glifo interno padrão), `ng build` sem erro.

## Adendo 5 (2026-09-04) — pino substituído por silhueta sólida (sem fundo), com print de referência

Usuário mandou print de referência (silhueta de motociclista e de pedestre, estilo ícone sólido,
sem fundo/moldura) e pediu pra substituir o pino do Adendo 4 por isso — "sem fundo só o ícone
mesmo cada um na sua cor". `iconeColaborador` reescrita: assinatura mudou de
`(cor, caminhoSvg)` pra `(svgInterno, viewBox, largura, altura)` — cada ícone agora é montado com
formas simples (círculos + retângulos rotacionados, mesma cor, sem contorno/fundo) em vez de um
path único traçado à mão ou de um badge/pino.

- **Moto**: 2 rodas (círculos) + barra ligando os topos + tanque/banco (retângulo arredondado) +
  guidão + piloto sentado (cabeça, tronco inclinado, braço no guidão, perna na pedaleira).
- **Pedestre**: cabeça + tronco + 2 braços e 2 pernas em ângulos opostos (meio do passo).

Âncora voltou pro CENTRO (`iconAnchor: [largura/2, altura/2]`, não tem mais "ponta" de pino) —
offset do tooltip do marcador voltou junto (`[0,-39]` → `[0,-16]`).

**Verificado visualmente de fato nesta sessão** (diferente do Adendo 4): sem conseguir logar no
app, montado um HTML isolado com os mesmos SVGs e servido via `python -m http.server` local,
aberto e testado no navegador via screenshot — 2 iterações até o ícone da moto ficar reconhecível
(1ª tentativa não lia como motocicleta; guidão da 2ª tentativa flutuava perto da cabeça, parecendo
solto; versão final lê claramente como moto+piloto e pedestre andando, testado também em miniatura
30px sobre fundo escuro simulando o mapa). `ng build` sem erro.
