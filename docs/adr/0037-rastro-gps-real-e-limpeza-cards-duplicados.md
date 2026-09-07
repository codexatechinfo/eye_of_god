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
