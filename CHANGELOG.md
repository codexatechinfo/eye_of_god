# Changelog

Este projeto segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e
[SemVer](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Alterado

- Painel lateral de detalhe (aba Trilho): mostrava a timeline de UM livro só, aberto livro por
  livro. Agora clicar num colaborador (na lista ou no ícone do mapa) abre a timeline do DIA
  INTEIRO dele, cruzando todos os livros — com indicador de mudança de livro/município entre
  pontos consecutivos (linha colorida no mapa também) e ícone de pausa no lugar da bolinha quando
  o intervalo passa do limite. Lista "Livros hoje" no card do colaborador perdeu o clique, virou
  só informação. Componente renomeado `LivroDetalhe` → `ColaboradorDetalhe`. Ver [ADR
  0030](docs/adr/0030-painel-timeline-dia-colaborador.md).

### Corrigido

- Filtros de colaborador (aba Trilho): limite de "tempo parado" que decide Ativo/Sem sincronismo
  estava em 20min desde sempre, deveria ser 30min — unificado com o limite já usado (30min) na
  barra de resumo da aba Massivas/Monitoramento de Livros, antes mantidos de propósito separados.
  Colaborador com afastamento cadastrado (atestado/licença/suspensão) que mesmo assim gerou
  atividade real hoje agora aparece nos dois filtros que bate (Afastados + o de atividade), sobe
  pro topo da lista, ganha badge e dispara alerta central automático — antes a atividade sempre
  vencia e esse caso nunca aparecia em Afastados. Ver [ADR
  0029](docs/adr/0029-filtros-colaboradores-afastado-com-atividade.md).

- Coleta de Acompanhamento: lista de ETAPAs travava em 2, mesmo existindo mais com dado real no
  portal — sem `stylesheet`, a página colapsava pra caber na viewport e a rolagem que carrega
  mais etapas ficava sem efeito; ciclos voltando a cada 5s também não davam folga pro site
  terminar de montar a lista. `stylesheet` tirado do bloqueio de recursos e pausa entre ciclos
  subiu pra 3min. Ver Adendo 1 da [ADR
  0028](docs/adr/0028-acompanhamento-sem-abrir-os-roster-coordenadas-mineradas.md).

- Logs dos jobs Massivas/Coleta Acomp/Controle de Empreiteiras (rodam concorrentes, escrevem no
  mesmo terminal) sem separação visual — parte sem timestamp, nenhuma distinção além do texto do
  prefixo. Todo log de job unificado em `logTempo.js`, com o prefixo `[Nome do Job]` colorido por
  job. Ver Adendo 1 da [ADR
  0028](docs/adr/0028-acompanhamento-sem-abrir-os-roster-coordenadas-mineradas.md).

- Importação por planilha de `calendario_leitura`: célula de data no Excel gravava `mes_ref`
  (e, achado no caminho, também `prazo_leitura`/`prazo_massiva`) no formato `DD/MM/YYYY` em vez
  do `YYYY-MM-DD` que essas 3 colunas específicas exigem — quebrava a aba Monitoramento de
  Livros de novo, mesmo depois da guarda de formato anterior (aquela evitava o crash, não
  corrigia o dado). Causa raiz corrigida: conversão de data do Excel agora respeita exceção por
  coluna. Dado já gravado errado (calendário de setembro) corrigido direto no banco. Ver Adendo
  2 da [ADR 0023](docs/adr/0023-timeout-monitoramento-livros.md).

- Importação por planilha de `contr_execucao_leitura`: o modelo (`importacaoConfig.js`) nunca
  tinha sido atualizado desde a reestruturação de colunas da ADR 0018 — ainda listava 8
  colunas removidas há tempos (`tipo_oss`, `numero_os`...) e não tinha nenhuma das colunas
  atuais (`uc`, `colaborador`, `codigo`...); uma planilha só falharia tarde, na hora de
  gravar. Achado ao auditar todas as tabelas do banco contra o modelo de importação/exportação
  (pedido do usuário). Corrigido: colunas e chave de upsert reescritas pro schema real,
  testado de ida e volta contra o banco. As outras 12 tabelas do modelo já batiam com o schema
  real. Ver Adendo 23 da [ADR
  0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).

- Aba "Monitoramento de Livros" quebrando com "Não foi possível carregar os dados de massivas"
  (mensagem errada — nem estava na aba Massivas) e a consulta de fato falhando por trás: 37
  linhas de `calendario_leitura` com data em formato errado (`31/07/2026` em vez de
  `2026-07-31`) faziam o `to_date(...)` estourar e derrubar a aba inteira, não só essa linha.
  Mensagem agora reflete a aba certa; consulta agora ignora linha de calendário com data
  malformada em vez de quebrar tudo. As 37 linhas malformadas (calendário de setembro, dado
  ruim) foram apagadas do banco. Ver Adendo 1 da [ADR
  0023](docs/adr/0023-timeout-monitoramento-livros.md).

- Mapa (aba Trilho) mostrava marcador e rota de colaborador sem nenhuma atividade no dia
  filtrado — o marcador usava sempre a última posição conhecida de qualquer dia, sem checar se
  havia serviço no dia selecionado no calendário. Agora só aparece quem tem atividade no dia
  filtrado. A consulta de posição (`/colaboradores/localizacoes`) foi reescrita sobre
  `base_dados_leitura` (data/hora reais da leitura, não o ciclo de raspagem do scraper) —
  mesmo princípio da ADR 0025. Achado no caminho: a importação diária de `base_dados_leitura`
  parece travada ou degradada há alguns dias (quase zero linhas desde 29/08) — enquanto isso,
  o mapa fica sem marcador nenhum (decisão deliberada: nunca mostrar posição de um instante
  que não é o real). Ver Adendos 11, 12 e 13 da [ADR
  0021](docs/adr/0021-tabela-coordenadas-ucs-mineradas.md).

- Barra lateral (aba Trilho) e painel de detalhe do mesmo livro podiam mostrar números
  diferentes de "realizadas" (ex.: "39/50" na barra vs. "40 realizadas/48 a realizar" no painel)
  — eram duas fontes com escopos diferentes: a barra sempre escopada ao dia selecionado, o
  painel mostrando o roster completo do livro sem filtro de data. As duas contagens agora usam a
  mesma fonte e o mesmo corte temporal (data selecionada no calendário), então sempre concordam.
  Achado no caminho e corrigido: `contr_execucao_leitura` nunca teve índice em `livro` (871 mil
  linhas, toda consulta por livro do sistema fazia sequential scan). Ver [ADR
  0025](docs/adr/0025-timeline-deslocamento-jornada-base-dados-leitura.md), Adendo 1.

- Jornada do colaborador (aba Trilho) finalmente mostra tempo trabalhado real — antes ficava
  sempre ~0s pra qualquer colaborador (causa raiz: horário do ciclo de raspagem, não da leitura
  real). Timeline do livro, deslocamento/km percorrido e impedimentos agora se baseiam em
  `base_dados_leitura` (data/hora reais por UC), que também revelou UCs já realizadas que
  `contr_execucao_leitura` ainda mostrava como pendentes. Impedimentos passam a separar
  obstrução real de campo (portão fechado, cão feroz...) de categoria administrativa
  (telemedida, leitura do cliente, troca de medidor...). Corrigidas no caminho duas
  inconsistências de dado achadas ao vivo (linhas em branco e 132 linhas com data em formato
  ISO). Ver [ADR 0025](docs/adr/0025-timeline-deslocamento-jornada-base-dados-leitura.md).

- Painel do livro: cards "Realizadas" e "A realizar" podiam mostrar 0/0 ao mesmo tempo que
  "Impedimentos" mostrava um número real (livro aberto pelo clique no colaborador no mapa,
  quando esse livro não está na lista de "atividade hoje" — os 3 cards agora vêm sempre da
  mesma fonte, nunca mais ficam inconsistentes entre si). Ver [ADR
  0021](docs/adr/0021-tabela-coordenadas-ucs-mineradas.md), Adendo 9.

- Botão "Centralizar no mapa" desabilitado (UC sem coordenada cadastrada) agora tem tooltip
  explicando o motivo, em vez de só ficar cinza sem explicação. Ver Adendo 10 da ADR 0021.

- Aba Monitoramento de Livros presa em "Carregando..." indefinidamente. Causa: consulta de
  resumo/detalhe (`contr_execucao_leitura`, 871 mil linhas) sem índice em `(data_import,
  hora_import)` e uma estimativa de cardinalidade errada do Postgres (`DISTINCT ON` sobre
  subquery, chutava 1 linha quando a saída real era 13 mil) que fazia o otimizador escolher
  Nested Loop em vez de Hash Join nos `JOIN`s com tabelas pequenas — de 8-11 minutos por
  requisição para 1.5-6s. Ver [ADR 0023](docs/adr/0023-timeout-monitoramento-livros.md).

### Alterado

- Scraper de Acompanhamento parou de abrir OS de cada livro (a causa real de "sessão perdida" —
  confirmado ao vivo que a taxa ficou igual ou pior mesmo testando com até 10 contas Copel
  isoladas em paralelo, descartando colisão de sessão como causa) — agora só lê a lista de
  livros já carregada no DOM após 1 busca (login + busca + leitura, sem fila/retry/paralelismo).
  Ciclo caiu de 35-50min pra 28s-3min. `contr_execucao_leitura` passa a ter 1 linha por livro
  por ciclo (situação/colaborador), sem mais `uc`/`codigo` — todo dado por UC (quais existem,
  quais foram executadas, quando) passa a vir de `coordenadas_ucs_mineradas` + `base_dados_leitura`
  em vez de `contr_execucao_leitura`, nos 6 pontos que dependiam do jeito antigo (painel de
  detalhe do livro, barra lateral, histórico do livro, cards/tabela de "Monitoramento de
  Livros", painel "Leitura Urbana", regime sucessivo de impedimento por UC). Ver [ADR
  0028](docs/adr/0028-acompanhamento-sem-abrir-os-roster-coordenadas-mineradas.md).

- Performance da barra lateral (aba Trilho): `work_mem` do Postgres estava no padrão de 4MB,
  forçando consultas com `DISTINCT ON` sobre centenas de milhares de linhas a espalhar sort pra
  disco. Aumentado globalmente pra 64MB (`effective_cache_size` também, de 128MB pra 4GB — sem
  reiniciar o banco) e a consulta mais pesada (`obterEventosPorLivrosAteData`) ganhou um limite
  próprio maior (160MB) só pra sua transação. Melhora real mas parcial — o maior custo restante
  (varredura de `base_dados_leitura`, 3,5 milhões de linhas) segue sem solução simples. Ver
  Adendo 2 da [ADR 0025](docs/adr/0025-timeline-deslocamento-jornada-base-dados-leitura.md).

- Barra lateral: `obterEventosPorLivrosAteData` (a consulta mais pesada, chamada a cada poll de
  60s) ganhou cache em memória com TTL de 3 minutos — `base_dados_leitura` só recebe carga em
  lote diário, não muda minuto a minuto. Reduz o poll subsequente de ~10s pra ~4s. Achado e
  corrigido no caminho: a primeira versão da chave de cache não considerava a empresa, o que
  faria duas empresas diferentes pedindo o mesmo livro/data compartilharem cache uma da outra
  (vazamento entre tenants) — corrigido antes de considerar pronto. Ver Adendo 3 da [ADR
  0025](docs/adr/0025-timeline-deslocamento-jornada-base-dados-leitura.md).

- Arquivos de código renomeados de `massivas*` pra `monitoramento*` (`massivasController.js`,
  `massivasRoutes.js`, `massivasService.js`, `massivas.service.ts`, `massivas-view/*` e os
  tipos/classes correspondentes) — a maior parte do conteúdo real desses arquivos é sobre
  leitura/releitura de livros, não sobre as tabelas de staging de massiva; o nome antigo podia
  confundir. Arquivos genuinamente sobre massiva (`coletaMassivas*`, `copelMassivas*`) mantidos.
  Contrato de API (`/massivas/...`) e texto visível ao usuário não mudaram. Ver [ADR
  0026](docs/adr/0026-rename-massivas-para-monitoramento.md).

### Removido

- Coluna `calendario_mes_seguinte` de `prazo_reg_livros` — não usada em nenhuma consulta do
  app, só ocupava espaço no allowlist de importação. Removida do allowlist também, pra uma
  planilha futura com essa coluna ser rejeitada de forma clara em vez de falhar tentando
  gravar numa coluna que não existe mais. Ver Adendo 6 da [ADR
  0015](docs/adr/0015-percentual-execucao-e-prazo-regulatorio-por-livro.md).

- Tabela `control_empreiteiras` — superada pela `base_dados_leitura` (ADR 0024, réplica exata
  da mesma estrutura) desde a reconstrução da timeline/deslocamento/jornada sobre dados reais
  de leitura (ADR 0025); não recebia dado nem era consultada por nenhuma feature havia tempos.
  Estava vazia (0 linhas), sem FK ou view dependente. Removida também do modelo de
  importação/exportação (`importacaoConfig.js`, que também alimenta a planilha de exemplo
  baixável) — deixa de aparecer no dropdown da aba Importação. Ver Adendo 1 da [ADR
  0004](docs/adr/0004-poda-de-tabelas-nao-usadas.md).

### Adicionado

- Extração "Controle de Empreiteiras" do portal Copel passa a alimentar `base_dados_leitura`
  automaticamente — portada de um script Python fornecido pelo usuário, agora encadeada dentro
  do job de Massivas (mesma sessão Copel, sem login extra). Cada ciclo reconcilia o dia anterior
  (relatório pode ter sido corrigido/consolidado desde a última coleta) e depois o dia atual,
  cada um com seu próprio apagar+reimportar. Ver [ADR
  0027](docs/adr/0027-extracao-controle-empreiteiras-base-dados-leitura.md).

- Nova tabela `base_dados_leitura` (empresa_id + RLS, `id` autoincremento), réplica exata da
  estrutura de `control_empreiteiras` — mesmo cabeçalho de planilha fornecido pelo usuário.
  Habilitada pra importação pela aba Importação (upsert por
  data/hora/usuário/UC). Populada com 3.511.075 linhas (4 CSVs + 1 planilha, agosto/2026) via
  script de uso único. Ver [ADR 0024](docs/adr/0024-tabela-base-dados-leitura.md).

- Aba Trilho: painel "Camadas" no mapa com 5 toggles ativos (Pontos coletados, Setor planejado,
  Limites municipais, Demais agentes, Sequência planejada) e 2 desabilitados pra funcionalidade
  futura (Rastro executado, Paradas e gaps), agora como controle nativo do Leaflet (ícone
  recolhido abaixo do seletor de tipo de mapa, expande no hover — mesmo estilo do controle de
  tiles). "Setor planejado" desenha o casco convexo das instalações do livro aberto; "Limites
  municipais" desenha o contorno real dos 399 municípios do Paraná, importado do IBGE (nova
  tabela `municipios_limites`, novo endpoint `GET /municipios/limites`, script
  `BACKEND/scripts/importarLimitesMunicipais.js`) — mostra só o(s) município(s) que o livro
  aberto realmente toca, não a malha inteira do estado (`POST
  /municipios/limites-por-pontos`). Ícone do controle "Camadas" trocado (era o mesmo do
  controle de tipos de mapa, difícil distinguir). Tooltip do ponto no mapa e a timeline do livro
  não repetem mais "UC" antes do número nem o número da UC duas vezes na mesma linha. Timeline
  do livro: "Pendente" virou "A realizar" (é só "ainda não realizada", nunca foi a situação real
  do portal). Clicar no ícone do colaborador no mapa agora também abre o card dele na lista
  lateral esquerda (destaque + jornada) **e rola a lista até ele** — sem isso o destaque
  acontecia fora da área visível numa lista de ~360 nomes, parecendo que nada tinha mudado.
  Desmarcar "Demais agentes" agora só esconde os colaboradores que não correspondem à rota
  aberta — o dono da rota selecionada continua sempre visível. Ver
  [ADR 0022](docs/adr/0022-camadas-mapa-e-limites-municipais.md).

- Aba Trilho: mapa mostra sempre um ícone por colaborador (moto para motoqueiro/monitor, pessoa
  a pé para pedestre) na posição da última UC que ele realizou (qualquer dia) — os círculos de
  contagem por regional foram removidos. Clicar no ícone abre o livro da UC que gerou aquela
  posição e desenha no mapa a rota das UCs na ordem de `sequencia`, com um ponto colorido por UC
  (verde/azul/âmbar/vermelho — pendente é azul, não cinza, que sumia visualmente sobre o mapa) e
  uma linha de desvio quando a execução real pula a ordem planejada; passar o mouse no ponto
  mostra sequência, UC, endereço e código. A timeline do painel do livro é uma lista única
  ordenada por `sequencia`, com o
  endereço de cada UC (município, localidade, endereço, classe de consumo), separadores de
  deslocamento entre UCs consecutivas ("+3m desloc 120m · 40 m/min", destacado quando vira pausa
  acima do limite por etapa) e um card de detalhe expansível por UC (situação, código,
  deslocamento, velocidade, coordenada, "Centralizar no mapa"/"Street View", e um aviso de
  "regime sucessivo" quando a mesma UC repete o mesmo código de impedimento em meses
  consecutivos), e um balão índigo entre duas UCs quando o livro mudou de colaborador e/ou de
  situação entre uma e outra. Clicar num ponto do mapa foca e expande a UC correspondente na
  lista. Card "Km percorrido" (livro e colaborador) e barra de "Jornada" do colaborador
  (trabalhado/ocioso, expansível) passam a mostrar dado real, calculado por Haversine entre as
  UCs. Corrigido: o painel e a rota fechavam sozinhos ao interagir com o mapa (clique no marcador
  borbulhava até o fechamento por "clique fora"). Novos endpoints `GET
  /colaboradores/localizacoes`, `GET /colaboradores/jornada`, `GET /massivas/uc-regime`. Ver
  Adendos 5 a 8 da [ADR 0021](docs/adr/0021-tabela-coordenadas-ucs-mineradas.md).

- Aba Importação: `coordenadas_ucs_mineradas` agora aceita import via planilha (upsert por
  `unidade_consumidora` — UC repetida substitui a linha, UC nova só adiciona), incluindo
  `geom`/`geom_area` (aceita o mesmo formato hexadecimal WKB que a tabela já usa). Novo botão
  "Baixar exemplo de todas as tabelas" — gera um `.xlsx` com uma aba por tabela importável,
  cabeçalho + 1 linha real de exemplo, pra servir de referência de formato — e depois passou a
  baixar só a tabela escolhida no mesmo seletor do import (antes baixava sempre todas de uma
  vez). Corrigido no processo: um erro numa tabela (config de import desatualizada de
  `contr_execucao_leitura`, já conhecida) não trava mais o exemplo das demais tabelas. Ver
  Adendos 3 e 4 da [ADR 0021](docs/adr/0021-tabela-coordenadas-ucs-mineradas.md).

- Nova tabela `coordenadas_ucs_mineradas` (20 colunas de UC/endereço/coordenadas), com RLS
  multi-tenant idêntico ao das demais tabelas de negócio. PostGIS instalado no banco;
  `geom`/`geom_area` migradas de texto pra `geometry(Point, 4326)`/`geometry(Polygon, 4326)`
  de verdade (com índices GIST), já que o dado real (4,1 milhões de linhas importadas de
  `coordenadas_ligacoes_copel_fimm.csv`) é EWKB genuíno — `varchar(255)` nem cabia o polígono
  inteiro. `COUNT(*) = 4.120.347`, RLS testado e confirmado fail-closed no dado real. Sem
  código de aplicação ainda — só a tabela populada. Ver
  [ADR 0021](docs/adr/0021-tabela-coordenadas-ucs-mineradas.md).

- Aba Trilho: o calendário de data (antes travado só em hoje) agora permite navegar pra dias de
  execução passados — Realizados/Não realizados/Impedimentos/lista de livros/cards do
  colaborador atualizam pra refletir o dia selecionado. Timeline UC-a-UC do painel de livro
  passou a mostrar também as UCs ainda não realizadas, com ponto cinza e "Ainda não realizada"
  no lugar da data. Ver Adendo 20 da
  [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).

### Alterado

- Scraper de Acompanhamento (`copelScraperService.js`): revisão geral de velocidade/robustez,
  testada ao vivo contra o portal real (pedido explícito do usuário). Bloqueio de imagem/CSS/
  fonte/mídia via `context.route()`; novo teto de duração do ciclo (`COPEL_TIMEOUT_CICLO_MIN`,
  default 45min, evita que um ciclo travado prenda o job Massivas indefinidamente —
  `copelSessaoLock.js`); dedup por `osId` na montagem da fila (`contr_execucao_leitura` não tem
  nenhuma constraint além do `id`, nada barraria a mesma OS entrando duas vezes); `SAVEPOINT`
  por lote na importação (um lote com erro não perde mais os demais lotes já inseridos com
  sucesso no mesmo ciclo). Tentativa de remover o `slowMo` de 100ms em modo headless foi
  **revertida**: testada ao vivo, a taxa de "sessão perdida" disparou — o atraso, mesmo sem
  intenção, parecia espaçar as 5 abas o suficiente pra evitar o problema de corrupção de estado
  de sessão no servidor já documentado nesta ADR. Verificado ao vivo: ciclo completo com 425
  livros, 401 processados (94,4%), 13.520 UCs importadas, zero duplicata real. Investigação de
  rede (script descartável, apagado depois) confirmou que o gargalo real é a instabilidade de
  sessão compartilhada no servidor, não peso de página — bloqueio de scripts de calendário
  (`/tags/calendar/`) aplicado como ganho adicional seguro (corta ~metade das requisições por
  livro aberto, extração continua correta). Tentativa de espaçamento cirúrgico só no disparo de
  abertura de livro (em vez de atrasar toda ação) testada ao vivo e **revertida** — mesma taxa
  ruim de sessão perdida do `slowMo` zerado, a colisão de sessão não está concentrada nesse
  instante específico. `slowMo` passou a ser **adaptativo entre ciclos** (não dá pra mudar
  dentro de um ciclo, o Playwright fixa isso no lançamento do browser): cada ciclo mede sua
  própria taxa de falha (sessão perdida + falha ao abrir OS, toda tentativa) e ajusta o valor do
  PRÓXIMO ciclo — sobe 50% se a taxa passar de 15%, desce 20% se ficar abaixo de 5%, começando
  no valor comprovado (100ms, `COPEL_SLOWMO_INICIAL_MS`). Ideia inspirada no `AutoThrottle` do
  Scrapy/Scrapling, adaptada pro nosso caso (Playwright não permite trocar `slowMo` em tempo de
  execução, então o ajuste vale só a partir do ciclo seguinte). Ver últimos Adendos da
  [ADR 0020](docs/adr/0020-paralelizacao-scraper-acompanhamento.md).

- Scraper de Acompanhamento (`copelScraperService.js`): fila de trabalho compartilhada entre
  as abas passou a ser **por livro**, não mais por etapa inteira. Usuário mostrou o HTML real
  da página depois da busca: todas as etapas e todos os livros de cada uma já vêm no DOM de
  uma vez (o clique em "ETAPA N - (M)" só alterna visibilidade de uma tabela que já existe,
  não busca dado novo). Antes, uma etapa grande (128 livros) e uma pequena (4 livros) contavam
  como "1 item" cada na fila, prendendo a aba que pegava a grande enquanto as outras ficavam
  ociosas — causa raiz do desbalanceamento relatado no adendo "abas pareciam se revezar".
  Agora a fila é montada lendo os livros de todas as etapas de uma vez (`extrairLivrosDaEtapa`,
  sem precisar clicar/expandir cada etapa) e cada aba consome um livro por vez
  (`processarLivro`, identificado pelo id da OS extraído do link — `extrairDadosOs` — não pelo
  número do livro, que não é garantidamente único entre etapas). Cada livro só existe uma vez
  no array da fila, então nenhum pode ser processado duas vezes por abas diferentes. Ver
  Adendo "fila por LIVRO em vez de fila por ETAPA" da
  [ADR 0020](docs/adr/0020-paralelizacao-scraper-acompanhamento.md).
- Scraper de Acompanhamento: abrir a OS de um livro passou a chamar direto a função JS
  `update(osId, url)` que o site define (`page.evaluate`), em vez de clicar no link "número da
  OS". Validado ao vivo que a fila por livro sozinha ainda deixava uma aba presa em ciclos de
  "etapa recolhida — reabrindo" (o `.click()` do Playwright exige a linha visível, e cada troca
  de etapa entre livros consecutivos da fila reexigia expandir a tabela) — numa rodada de 590
  livros, uma das 5 abas processou só 5 enquanto as outras processavam 16-28. Chamar `update()`
  direto não exige visibilidade nenhuma (é a mesma função que o clique chamaria). Resultado
  validado com 552 livros: **0 linhas de "recolhida — reabrindo"**, distribuição quase perfeita
  entre abas (108/114/113/115/102), 552/552 livros e 21.608 UCs coletadas, 0 desistidos —
  conferido também direto no banco (`COUNT(*)`/`COUNT(DISTINCT livro)` em
  `contr_execucao_leitura`), não só no log da aplicação. A URL de destino passada pra
  `update()` também deixou de ser uma constante fixa e passou a ser extraída do `href` de cada
  linha (`extrairDadosOs`), eliminando a suposição de que todo tipo de OS usa a mesma URL — sem
  custo adicional (o `href` já era lido pra extrair o osId). Ver adendos "validado ao vivo... a
  correção" e "URL de destino também extraída por linha" da
  [ADR 0020](docs/adr/0020-paralelizacao-scraper-acompanhamento.md).
- Monitoramento de Livros (leitura/releitura) adaptado para `contr_execucao_leitura` com 1
  linha por UC: coluna "Executados/Pendentes" renomeada para "Realizados/Não realizados"
  (`codigo IS NOT NULL` = realizada), agregação por `livro` via window function, cards
  "Agentes em campo" e "Progresso de atividades" voltaram a refletir colaboradores de
  leitura/releitura. Modal "Histórico do livro" passou a listar também as UCs individuais do
  livro, e o painel de livro da aba Trilho passou a mostrar uma timeline UC-a-UC (primeira
  realizada até a última execução) via novo endpoint `GET /massivas/livro-ucs`. "Último
  sincronismo" do colaborador ficou sempre visível na lista lateral da aba Trilho (antes só no
  card expandido). Ver Adendo 15 da
  [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).
- Timeline UC-a-UC do painel de livro (aba Trilho) simplificada para mostrar só o número da
  UC e a hora de execução, sem o código repetido ao lado. Card "Impedimentos" (antes
  placeholder "Em breve") passou a mostrar a contagem real de UCs com código diferente de
  `000`/`099` (leitura normal / sem leitura). Mapa de bases regionais (`app-mapa-bases`, aba
  Trilho) ganhou seletor de camadas — Ruas, Satélite, Satélite c/ rótulos e Topográfico. Ver
  Adendo 16 da [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).
- Card "Impedimentos" do colaborador (lista lateral da aba Trilho, antes placeholder "--")
  passou a somar impedimentos de todos os livros dele no dia, não só de um livro específico —
  novo `totalImpedimentos` em `GET /colaboradores/atividade-hoje`. Timeline UC-a-UC do painel
  de livro agora destaca em âmbar as UCs com impedimento (com o código ao lado) e mostra só o
  número da UC, em formato de linha do tempo com pontos (mesmo padrão visual do modal
  "Histórico do livro" de Massivas). Ver Adendo 17 da
  [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).

### Corrigido

- Painel de livro da aba Trilho podia mostrar total de impedimentos diferente do card do
  colaborador mesmo quando ele só tinha 1 livro. Causa: o painel buscava as UCs do livro uma
  única vez e cacheava pra sempre, enquanto o card do colaborador recalcula a cada 60s — como a
  coleta roda 24h contínua, o painel ficava com dado congelado do momento em que foi aberto.
  Removido o cache indefinido (mesmo bug também existia, sem sintoma reportado ainda, no modal
  "Histórico do livro" de Massivas); painel da aba Trilho agora também atualiza sozinho a cada
  60s enquanto estiver aberto. Ver Adendo 18 da
  [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).
- **Causa raiz real do Adendo 18**: uma exceção dentro de um `finally` (fechar a tela de detalhe
  da OS podia falhar sob várias abas competindo pela mesma sessão) descartava silenciosamente um
  `return` de sucesso já decidido em `copelScraperService.js`, fazendo o worker reprocessar um
  livro que já tinha extraído com êxito — duplicando UCs no mesmo lote (visto em produção: os
  360 livros do dia tinham 21% de linhas duplicadas). Corrigido o `finally` para nunca deixar
  esse tipo de falha derrubar uma extração já bem-sucedida. Estendida a deduplicação (por UC,
  desempatando por `id` em vez de `data_import`/`hora_import` — que só tem granularidade de
  segundo) pras queries principais de Realizados/Não realizados/Progresso (Monitoramento de
  Livros) e do painel de Leitura Urbana, que somavam linhas cruas sem deduplicar. Limpas 20.144
  linhas duplicadas já gravadas no banco. Ver Adendo 19 da
  [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).
- "Último sincronismo" (card do colaborador e do painel de livro, aba Trilho) podia avançar sem
  nenhuma UC realizada — uma mudança de situação sozinha (ex.: "Atribuída" → "Em Execução", sem
  nenhuma leitura ainda) já contava como sincronismo. Agora só avança quando `digitados`
  realmente aumenta. Corrigida também uma lacuna: UCs realizadas antes do primeiro lote de
  coleta do dia (a coleta roda 24h contínua) ficavam invisíveis sem um ponto de comparação
  anterior ao dia — nova consulta de baseline resolve isso. Ver Adendo 21 da
  [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).
- O fix do "Último sincronismo" (Adendo 21) tinha ficado incompleto: colaborador só-massiva
  continuava com a semântica antiga (hora do último lote, não de execução real) — usuário
  reportou o caso invertido (0 realizadas com sincronismo preenchido, 87% realizado com "--").
  Estendida a mesma lógica pra massiva. No processo, corrigido também um problema de
  performance real: a consulta nova, sem restringir os pares (leiturista, livro) antes de
  ordenar, tentava ordenar as 732 mil linhas de `em_execucao_im` (sem índice de suporte) —
  10,9s por chamada. Corrigido pra 2,8s restringindo a busca aos pares do dia. Ver Adendo 22 da
  [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).

- Resumo da aba Massivas (`GET /massivas/resumo`) falhava com `column reference "id" is
  ambiguous` — `contarFonteContr()` junta `contr_execucao_leitura`, `cidades_localidades` e
  `calendario_leitura` (todas com coluna `id`) e o `ORDER BY` não qualificava por alias.
  Corrigido para `ORDER BY c.livro, c.id ASC`. Ver Adendo 14 da
  [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).
- Progresso do Monitoramento de Livros mostrava percentuais impossíveis (ex.: "169/12"
  exibindo "1%"). Causa: `SUM(...) OVER (...)` do Postgres devolve `bigint`, que o driver `pg`
  entrega como string em JS; sem `::int`, `digitados + nao_digitados` no frontend virava
  concatenação de string, não soma. Corrigido envolvendo as duas constantes de agregação em
  `(...)::int`. Ver Adendo 15 da
  [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).
- Scraper de Acompanhamento: a coleta terminava "com sucesso" cedo demais, sem processar
  todas as etapas — a lista de etapas não é paginada, mas carrega no DOM aos poucos
  conforme a página rola pra baixo (confirmado com o usuário: mesmo processo manual de
  antes do scraper existir); o loop achava que tinha acabado assim que esgotava a primeira
  leva já renderizada. Nova `aguardarTodasEtapasCarregadas()` rola a página até o fim,
  parando quando a contagem de etapas estabiliza — chamada no setup inicial e sempre que o
  loop parece ter chegado ao fim, antes de confirmar de verdade. Ver Adendo 13 da
  [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).
- Scraper de Acompanhamento: um erro fatal numa etapa (ex.: o clique de recolher no final)
  derrubava a coleta **inteira**, perdendo etapas seguintes que ainda nem tinham sido
  tentadas — visto ao vivo na ETAPA 18 (187 livros): degradou no meio depois de uma falha
  `All promises were rejected` ao abrir um livro, e o timeout fatal seguinte reiniciou o
  ciclo do zero. Causa raiz encadeada: quando nem popup nem "DADOS DE EXECUÇÃO" respondem a
  tempo, a tela de detalhe podia ficar aberta sem ninguém fechar (a navegação real às vezes
  só completa *depois* do timeout de 10s), prendendo a etapa nas tentativas seguintes de
  reabrir. Timeout aumentado para 20s, checagem ativa de tela tardia no `catch` do livro, e
  — a correção principal — todo o processamento de uma etapa agora está dentro de um
  try/catch próprio: uma etapa irrecuperável só perde ela mesma, o código segue tentando as
  seguintes. Ver Adendo 12 da
  [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).
- Scraper de Acompanhamento: `fecharTelaDetalheMesmaPagina()` esperava até 15s (silenciado
  por `.catch`, sem log) que a tabela de livros "ficasse visível sozinha" depois de clicar
  "CANCELAR" — mas o próprio Adendo 7 já tinha provado que isso não acontece sozinho, só
  reclicando na etapa (o que `garantirEtapaVisivel()` já fazia corretamente no início de
  cada livro). Era um buraco de até 15s morto por livro processado via "mesma página" (caso
  mais comum), sem nenhum sinal de erro no log. Removida essa espera redundante — a
  reabertura ativa continua sendo feita, só que exclusivamente por
  `garantirEtapaVisivel()`. Ver Adendo 11 da
  [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).
- Scraper de Massivas (`copelMassivasScraperService.js`): removidos 9 `waitForTimeout` fixos
  (login, troca de aba, cascata de filtros dependentes, pós-busca) que somavam >30s de
  espera garantida por ciclo mesmo com a página já carregada — mesma causa do "tempo
  desnecessário parado" já corrigido no scraper de Acompanhamento (Adendo 9 da
  [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md)), mas esse
  arquivo tinha ficado de fora daquela limpeza. Trocados por esperas reais: `aguardarOpcao()`
  (espera a `<option>` do próximo select em cascata existir, em vez de tempo fixo depois de
  cada `selectOption`), `aguardarFormularioFiltros()` (espera o select de concessionária
  ficar visível ao trocar de aba) e `aguardarEstabilizar()` (poll na contagem de linhas da
  tabela até estabilizar, mesmo padrão do `aguardarTabelaEstabilizar` já usado no outro
  scraper). Restam só 2 `waitForTimeout`: o próprio poll de `aguardarEstabilizar` e o
  intervalo entre tentativas de busca (retry backoff, não espera de carregamento). Não
  validado ao vivo nesta sessão.
- Jobs `coletaJob.js` (Coleta Acomp) e `coletaMassivasJob.js` (Massivas) crashavam e
  reiniciavam do zero no meio de uma etapa (`locator.click: Timeout 30000ms exceeded`
  esperando `a.color:has-text("ETAPA")`) — causa raiz: os dois rodam concorrentemente o dia
  inteiro e fazem login na MESMA conta Copel; o portal aparenta usar sessão única por
  usuário, então o login de um derrubava a sessão do outro no meio da operação. Nova fila de
  exclusão mútua (`copelSessaoLock.js`) serializa as duas coletas — nunca mais logam ao
  mesmo tempo. Ver [ADR 0019](docs/adr/0019-lock-sessao-copel-entre-jobs.md).

### Corrigido

- Recuperação de aba "cega" no scraper de Acompanhamento: o `page.goto()` isolado (correção
  anterior) às vezes navegava pra URL certa mas o servidor não devolvia a página completa
  (formulário de filtro ausente, mesmo depois dos 30s de auto-wait) — diagnóstico confirmou
  que não era mais "aba presa em outra tela", era sobrecarga momentânea do servidor.
  Extraída para `recuperarAba()`, que agora tenta `goto()` + refazer busca até 3 vezes com
  folga entre tentativas antes de desistir. Ver Adendo da
  [ADR 0020](docs/adr/0020-paralelizacao-scraper-acompanhamento.md).

### Alterado

- `COPEL_PARALELISMO_ACOMP` reduzido de 8 para 5 no `.env` local — mesmo com as correções de
  recuperação, um ciclo real de ~10 minutos com 8 abas teve praticamente todas passando por
  "All promises were rejected" numa janela curta (sobrecarga real da sessão compartilhada
  sob 8 conexões simultâneas), resultando em muita perda parcial (etapas grandes com só 1
  livro coletado de dezenas/centenas esperados, apesar de nenhuma etapa ter sido totalmente
  perdida). Sugestão do usuário, aplicada como teste empírico — o default do código
  (`.env.example`) continua 8. Ver Adendo da
  [ADR 0020](docs/adr/0020-paralelizacao-scraper-acompanhamento.md).

### Corrigido

- Scraper de Acompanhamento paralelizado: a correção anterior (refazer busca quando a lista
  fica vazia) também falhava ao vivo — `page.selectOption: Timeout` — porque a causa real era
  mais específica: a aba ficava presa na tela de **detalhe de uma OS**
  (`editarTarefasLeituraAction.do`, "DADOS DA OS"/"DADOS DE EXECUÇÃO"), não numa tela de
  Acompanhamento sem busca. Origem: a checagem de "a tela apareceu tarde" (depois de "All
  promises were rejected") era instantânea — sob 8 abas competindo pela sessão, a navegação
  real podia demorar mais que isso, e a tela ficava presa aberta pra sempre sem que ninguém
  soubesse. Corrigido: checagem virou um poll de até 10s; e a recuperação no `worker()` agora
  usa `page.goto()` direto para a URL de Acompanhamento antes de refazer a busca, em vez de
  depender do formulário de filtro existir na tela atual. Ver Adendo da
  [ADR 0020](docs/adr/0020-paralelizacao-scraper-acompanhamento.md).
- Scraper de Acompanhamento paralelizado: rodando ao vivo com os timestamps instrumentados,
  8 das 16 etapas de um ciclo foram completamente perdidas — 5 das 8 abas ficaram
  permanentemente incapazes de localizar qualquer etapa depois de um evento simultâneo.
  Diagnóstico automático revelou a causa: não é a sessão caindo nem a etapa recolhendo, é a
  **busca inteira se perdendo** nessa aba (usuário continua logado, menu completo visível,
  mas o corpo da página fica sem nenhuma etapa) — provavelmente o servidor guarda o
  resultado da busca como estado de sessão compartilhado, e uma ação de outra aba pode
  sobrescrevê-lo. Corrigido: quando a lista de etapas está totalmente vazia (não só "ainda
  não carregou"), o worker refaz filtro + busca do zero antes de desistir, recuperando a aba
  em vez de deixá-la cega pelo resto da execução. Limitação que permanece: a etapa em
  andamento no momento da perda ainda fica parcialmente coletada. Ver Adendo da
  [ADR 0020](docs/adr/0020-paralelizacao-scraper-acompanhamento.md).
- `logTempo.js`: os timestamps `[hh:mm:ss.mmm]` estavam em UTC (`toISOString()`), 3h à frente
  do horário real de Brasília — usuário notou a discrepância no log ("que registros de tempo
  são esses"). Corrigido para usar `getHours()`/`getMinutes()`/etc., que já refletem o fuso
  local do sistema.

### Alterado

- Fluxo de coleta (login → scraping → importação): TODA linha de log ganhou timestamp
  `[hh:mm:ss.mmm]` no terminal — novo `BACKEND/src/utils/logTempo.js`
  (`log`/`logWarn`/`logErro`, substitutos de `console.log/warn/error`), usado em
  `copelScraperService.js`, `copelImportService.js` (+ log por lote inserido) e
  `coletaCopelService.js` (+ tempo decorrido desde o início do ciclo em 3 marcos: fim do
  scraping, fim da importação, fim do ciclo inteiro). Permite contabilizar o tempo de
  execução direto no terminal, sem cronometrar por fora. Ver Adendo da
  [ADR 0020](docs/adr/0020-paralelizacao-scraper-acompanhamento.md).
- Scraper de Acompanhamento: timestamps de início/fim (com duração) instrumentados ao redor
  do clique que abre a OS de cada livro e ao abrir cada etapa — usuário reportou uma aba
  parecendo "esperar a vez" de outra em vez de rodar em paralelo de verdade (hipótese: as 8
  abas compartilham a mesma sessão HTTP, e o servidor Java/Struts pode estar processando
  requisições da mesma sessão de forma serializada). Instrumentação permite confirmar, no
  próximo log real, se há sobreposição de intervalos entre abas diferentes antes de decidir
  se vale o risco de sessões separadas por aba. Ver Adendo da
  [ADR 0020](docs/adr/0020-paralelizacao-scraper-acompanhamento.md).

### Corrigido

- Scraper de Acompanhamento paralelizado (ADR 0020): rodando ao vivo, só abriu 2 abas em vez
  das 8 configuradas — a fila de etapas era montada antes da lista terminar de carregar via
  scroll (a função de espera só rodava 1 vez, com intervalo curto demais entre tentativas, e
  pulava direto pro fim da página em vez de rolar em passos, o que pode não disparar o
  carregamento do próximo lote). Corrigido: `scrollBy` incremental em vez de `scrollTo`
  direto, mais tempo entre passos, mais leituras estáveis exigidas. Segunda camada de
  proteção no `worker()`: se uma aba não encontrar a etapa sorteada da fila, tenta rolar mais
  antes de desistir e devolve o número à fila em vez de descartá-lo (com limite de tentativas
  pra não travar em loop). Ver Adendo da
  [ADR 0020](docs/adr/0020-paralelizacao-scraper-acompanhamento.md).

### Alterado

- Scraper de Acompanhamento (`copelScraperService.js`) paralelizado: em vez de processar as
  etapas uma de cada vez, abre várias abas (padrão 8, `COPEL_PARALELISMO_ACOMP`) dentro do
  MESMO `browserContext` — compartilham a sessão (login único), sem risco de derrubar uma à
  outra. Cada aba consome de uma fila compartilhada de etapas pendentes (coordenada por
  número de etapa, não por texto completo nem índice — o texto muda de aba pra aba porque
  cada uma carrega sua própria cópia da lista) e processa uma etapa por vez, nunca duas abas
  na mesma etapa. Diagnóstico de erro passou a ser por aba, não mais global, pra não
  esconder problemas de abas diferentes atrás do primeiro screenshot salvo. Ver
  [ADR 0020](docs/adr/0020-paralelizacao-scraper-acompanhamento.md).
- Jobs de coleta (`coletaJob.js`/`coletaMassivasJob.js`): removida a janela de horário
  (07h-19h) a pedido do usuário — agora rodam continuamente enquanto a API estiver no ar,
  sem pausar à noite. `node-cron` deixou de ser usado nesses arquivos; o watchdog continua
  como rede de segurança, agora só checando "o loop parou?" em vez de "deveria estar dentro
  da janela mas não está". Removido também o estado "Fora do horário" do indicador de
  status no header (`Home`) — não existe mais esse cenário. Ver Adendo da
  [ADR 0017](docs/adr/0017-watchdog-loop-coleta.md).
- Scraper de acompanhamento: log de progresso por livro coletado (`📖 Livro 'X' — N UCs
  (M/Total)`), não só um resumo no final da etapa inteira — dava a impressão de "travado"
  em etapas com dezenas/centenas de livros. Mensagem de "etapa recolheu, reabrindo" (o site
  recolhe a cada `CANCELAR`, comportamento normal) trocada de aviso para log informativo.
  Ver Adendo 8 da [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).
- Nova variável `COPEL_HEADLESS` (`.env`) — `false` abre o Chromium do scraper de
  acompanhamento com janela visível, útil pra acompanhar ao vivo o que o portal está fazendo;
  default `true` (sem janela), certo para produção (o job roda sozinho o dia inteiro). Ver
  Adendo 3 da [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).
- Scraper de acompanhamento (`copelScraperService.js`) reestruturado: antes coletava 1 linha
  por livro direto da tabela de cada etapa; agora, para cada livro, clica no link "número da
  OS" (abre popup com a tabela de UCs/medidores daquele livro) e gera 1 registro por UC,
  repetindo os dados do livro (etapa/localidade/livro/empreiteira/datas/situação/
  colaborador) em cada um. Alimenta as colunas `uc`/`codigo`/`equipamento`/
  `tipo_especificacao`/`faturamento`/`leitura_atual` de `contr_execucao_leitura`, até então
  sem scraping. `copelImportService.js` ganhou `parseSituacaoColaborador()` (separa "Em
  Execução (CPO-NOME)" em situação + colaborador) e batching do INSERT em lotes de 300 linhas
  (um livro agora pode gerar dezenas de linhas). Testado isoladamente (mock + rollback) contra
  o banco real — não testado ao vivo contra o portal Copel nesta sessão, só no próximo ciclo
  automático de coleta. Ver Adendo 2 da
  [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).
- `contr_execucao_leitura` reestruturada: removidas `tipo_oss`, `subtipo_os`, `numero_os`,
  `data_ultima_atualizacao`, `qtd_digitados_nao_digitados`, `qtd_com_leitura_sem_leitura`,
  `percentual_sem_leitura`, `qtd_fora_de_faixa_foto`; adicionadas `uc`, `colaborador`,
  `codigo`, `equipamento`, `tipo_especificacao`, `faturamento`, `leitura_atual`, `smart`.
  **Efeito colateral temporário**: progresso/percentual de execução de leitura/releitura
  (Monitoramento de Livros e Trilho) fica zerado até a nova lógica ser definida com as
  colunas novas — massiva não é afetada. Ver
  [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).

### Adicionado

- Toggle "Afastados" na barra de filtros do Trilho (5º, ao lado de Parado/Sem serviço/
  Ativo/Sem sincronismo): mostra só quem está sem serviço e tem justificativa (atestado,
  licença ou suspensão cobrindo hoje). "Sem serviço" passou a mostrar só quem está de fato
  sem nenhuma justificativa — os dois grupos, antes misturados, agora são mutuamente
  exclusivos. Nova terceira fonte de justificativa, tabela `suspensao` (além de `atestados`
  e `ativos_inativos.situacao` já existentes). Ver Adendo da
  [ADR 0016](docs/adr/0016-justificativa-ausencia-colaborador-sem-servico.md).
- Modal "sem comunicar há mais de 30 min" na barra de resumo das abas Massivas/Monitoramento
  de Livros — clique no texto vermelho abre a lista de colaboradores em campo sem transmitir
  dados, com etapas (agregadas, sem repetição) e quantidade a realizar de cada um, ordenada
  por mais tempo parado primeiro. Ver Adendo 10 da
  [ADR 0012](docs/adr/0012-resumo-operacional-massivas-livros.md).
- Watchdog nos loops de coleta (`coletaJob.js`/`coletaMassivasJob.js`): checa a cada 2min
  se deveria estar rodando (dentro da janela 07h–19h) mas não está, e reinicia sozinho.
  Cobre o caso de `node-cron` perder o disparo agendado das 07h (sem retry nativo — visto
  ao vivo: reinícios do processo coincidindo com o minuto exato do agendamento faziam a
  coleta ficar parada o dia inteiro sem ninguém notar). Ver
  [ADR 0017](docs/adr/0017-watchdog-loop-coleta.md).
- Cards "Realizadas" (verde) e "A realizar" (vermelho) na aba Trilho (lista de
  colaboradores e painel de detalhe do livro), destacados dos demais cards que continuam
  azuis; gradiente ainda mais discreto (opacidade 10%, era 20%).
- Indicador de ausência justificada na lista do Trilho: colaborador "sem serviço" com
  justificativa (atestado ou licença de `ativos_inativos.situacao`, formato "A2 -
  DD/MM/YYYY") ganha um ícone ao lado do nome, visível sem precisar expandir — roxo quando
  é afastamento pelo INSS, azul nos demais casos. Colaboradores afastados por licença
  passam a aparecer na lista do Trilho (antes eram excluídos por completo). Ver
  [ADR 0016](docs/adr/0016-justificativa-ausencia-colaborador-sem-servico.md).
- Barra de % de execução abaixo do nome de cada colaborador na lista do Trilho; a lista
  passa a ordenar por 3 tiers, valendo em todos os filtros e na lista sem filtro nenhum: 1)
  colaborador com livro em prazo regulatório extremo (`>33` dias em qualquer status, ou
  `<27` dias num livro já "Em Execução") primeiro, não importa se está parado/ativo/sem
  sincronismo; 2) resto com atividade hoje, por % de execução ascendente (parado/ativo/sem
  sincronismo tratados como um grupo só pra ordenação); 3) sem serviço, sempre por último.
  Coluna
  "Progresso" (barra + %) nova na tabela "Detalhe por livro" das duas abas. Coluna "Prazo
  regulatório" (dias efetivos frente a `prazo_reg_livros`) nova na tabela de Monitoramento de
  Livros e badge "Nd" na lista "Livros de hoje" do Trilho — vale só pra leitura urbana
  (etapas 01-19); releitura e etapa rural (21-38) ficam de fora do cálculo, mesmo quando o
  número do livro bate com a planilha; destaque de cor nos extremos (`>33` dias vermelho,
  `<27` dias verde; `27–33` neutro). Coluna "Recebido em" nova nas duas tabelas de detalhe.
  Tabela "Detalhe por livro" passa a ordenar pelos mais críticos por padrão (dias em atraso
  desc, % de execução asc como desempate), em qualquer filtro, nas duas abas — até o usuário
  clicar num cabeçalho de coluna. Ver
  [ADR 0015](docs/adr/0015-percentual-execucao-e-prazo-regulatorio-por-livro.md).
- Coluna "Situação" da tabela "Detalhe por livro" ganhou badge colorido (âmbar/Pendente,
  azul/Atribuída, verde/Em Execução) — mesmas cores já usadas nos badges de status da barra
  de resumo, nas duas abas.
- Paginação na tabela "Detalhe por livro" (Massivas e Monitoramento de Livros), com campo
  livre pra escolher linhas por página (até 250) e atalhos rápidos (25/50/100/250).
  Client-side, isolada por aba; reseta pra página 1 ao trocar filtro, mas não no polling
  automático de 60s. Ver [ADR 0014](docs/adr/0014-paginacao-tabela-detalhe.md).
- Filtro "Prazo regulatório" na barra de filtros (topo da tela) de Monitoramento de Livros —
  &lt;27/33/34+ dias. Liga no mesmo signal do badge clicável da barra de resumo, então
  dropdown e badge ficam sempre sincronizados. (Chegou a existir um equivalente na aba
  Massivas — removido a pedido do usuário; os badges No prazo/Prazo final/Atraso da barra de
  resumo continuam funcionando normalmente lá.) Ver Adendo 6/7 da
  [ADR 0012](docs/adr/0012-resumo-operacional-massivas-livros.md).
- Faixas &lt;27/33/34+ dias (aba Monitoramento de Livros) agora são clicáveis e filtram a
  tabela de detalhe abaixo, igual aos outros badges da barra de resumo — antes eram só
  display. Aba Massivas já tinha o equivalente (No Prazo/Prazo Final/Atraso), reconfirmado
  funcionando. Ver Adendo 5 da [ADR 0012](docs/adr/0012-resumo-operacional-massivas-livros.md).
- Colaboradores com massiva atribuída/em execução hoje, mas sem nenhuma leitura/releitura,
  deixam de aparecer como "sem serviço" na lista do Trilho — passam a contar com os mesmos
  detalhes de "Livros de hoje" (badge roxo "massiva") que leitura/releitura já tinham. Ver
  [ADR 0013](docs/adr/0013-colaboradores-massiva-no-trilho.md).
- Badge de cargo (Motoqueiro/Pedestre/Monitor) ao lado da regional quando um colaborador é
  expandido na lista do Trilho.

### Alterado

- Filtros de Massivas e Monitoramento de Livros passam a persistir por aba ao trocar de aba
  (antes reiniciavam toda vez que a aba era reaberta, porque o componente era destruído e
  recriado — trocado `*ngIf` por `[hidden]` mantendo a instância viva). Ver Adendo 3 da
  [ADR 0012](docs/adr/0012-resumo-operacional-massivas-livros.md).
- Aba Massivas passa a usar o mesmo visual de barra de resumo (uma linha só) que
  Monitoramento de Livros, mostrando seus próprios dados (os 7 contadores clássicos
  Pendentes/Atribuídas/Em Execução/Total/No Prazo/Prazo Final/Atraso) nesse layout — ver
  Adendo 3 da ADR 0012 (substitui a decisão do Adendo 2, que tinha revertido a aba pro
  layout antigo em grid; o título "Resumo de Massivas" saiu de vez).
- Barra de resumo operacional (ADR 0012): título/subtítulo ("Resumo de Massivas" / "Dados
  de... às...") removido; Agentes em campo/Comunicação/Progresso e os contadores de
  status/faixas de dias voltaram a ficar numa linha só, em vez de duas seções separadas.
  Passa a se atualizar sozinha a cada 60s (`MassivasService` ganhou polling, mesmo padrão
  já usado em `ColaboradoresService`) e o toggle Livros/Leituras agora também vale pras
  faixas &lt;27/33/34+ dias (`obterFaixasDias` passou a somar `volume_de_leituras`, não só
  contar linhas).
- Abas Massivas e Monitoramento de Livros: os 7 cards (Pendentes/Atribuídas/Em Execução/
  Total/No Prazo/Prazo Final/Atraso) foram substituídos por uma barra de resumo
  operacional — Agentes em campo (Moto/A pé/Na base), Comunicação · 30 min, Progresso de
  atividades, e contadores Pendentes/Atribuídos/Em Execução/Em Atraso/&lt;27 dias/33 dias/
  34+ dias. As faixas de dias vêm de `prazo_reg_livros` (nova query, `dias_finais` ajustado
  pela diferença entre hoje e `prazo_calendario`); o resto reaproveita dado que já existia.
  Ver [ADR 0012](docs/adr/0012-resumo-operacional-massivas-livros.md).
- "Livros de hoje" na lista de colaboradores (aba Trilho) ganhou um badge indicando o tipo
  do livro — leitura, releitura (ADR 0006/0011) ou massiva (ADR 0013), agora exposto em
  `atividadeColaboradoresService.js` e `LivroAtividade.tipoServico`.

### Corrigido

- Scraper de acompanhamento: removidas 5 chamadas de `page.waitForLoadState('networkidle',
  ...)` que atrasavam sem necessidade — usuário reportou "a página nitidamente já carregou e
  ainda fica esperando um tempo a mais desnecessário" ao entrar na aba e ao voltar dela após
  coletar UCs. `networkidle` só resolve quando não há requisição de rede por um tempo; se o
  portal tem qualquer atividade de fundo, isso nunca acontece e o código esperava o timeout
  inteiro (15-20s) mesmo com a página já pronta. O `waitForSelector`/`waitFor` de
  visibilidade que já existia em paralelo é suficiente sozinho. Ver Adendo 9 da
  [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).
- Scraper de acompanhamento: depois de fechar a tela de detalhe da OS, a etapa podia voltar
  **recolhida** (não só "lista vazia") — o link do próximo livro continuava existindo no DOM
  mas ficava invisível, e `locator.click` ficava 30s tentando em vão. Nova checagem por
  visibilidade da tabela (não só contagem de linhas) no início de cada volta do loop,
  reabrindo a etapa quando necessário. Ver Adendo 7 da
  [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).
- Scraper de acompanhamento: **crash real do processo** (`nodemon: app crashed`) por
  unhandled rejection no `Promise.any` que decide popup vs. mesma página — se o clique no
  link da OS demorasse mais que o timeout de 10s de qualquer uma das duas esperas, ela
  rejeitava sozinha antes do `Promise.any` ter handler anexado. `.catch(() => {})`
  preventivo adicionado em todos os níveis da cadeia de promises (originais, derivadas do
  `.then()`, e o `Promise.any` combinado) — validado com teste isolado reproduzindo o
  cenário exato. Ver Adendo 6 da
  [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).
- Scraper de acompanhamento: causa raiz real de só processar 1 livro por etapa — cada etapa
  expandida mostra sua própria tabela de livros, mas **todas compartilham o mesmo
  `id="item"`** (confirmado por print do usuário); um seletor CSS `#item` sempre resolve pra
  primeira ocorrência no documento, então depois de abrir a etapa 16 o código continuava
  mirando na tabela da etapa 15. Trocado por busca via XPath relativo ao link de cada etapa
  (`tabelaDaEtapa`), escopando a tabela certa em vez de um seletor global. Ver Adendo 5 da
  [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).
- Scraper de acompanhamento: só processava o **primeiro livro de cada etapa**, pulando o
  resto em silêncio (sem nenhum log de erro) — confirmado ao vivo (`1/76`, `1/259`, `1/376`
  livros...) e visualmente pelo usuário. Causa: `page.goBack()` não restaura o estado AJAX da
  lista de livros; o loop reaproveitava um locator capturado uma única vez, que ficava
  inconsistente depois do primeiro livro. Trocado `goBack()` por clicar em "CANCELAR"
  (mecanismo do próprio site); loop de livros reescrito para reler a lista do zero a cada
  item, rastreando por número do livro em vez de posição; tempos fixos de espera trocados
  por esperas de carregamento reais. Ver Adendo 4 da
  [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).
- Scraper de acompanhamento: usava `#tabFixedHeader` (id de um plugin JS genérico, talvez
  reaproveitado na lista de livros) como sinal de "abriu a tela de UCs" — coletava só 1
  registro por livro em vez de todas as UCs (reportado ao vivo: livro com 200+ UCs reais
  virou 1 linha no banco). Trocado por um texto exclusivo da tela de detalhe ("DADOS DE
  EXECUÇÃO"); adicionada espera até a tabela de UCs parar de crescer antes de extrair (podia
  popular linhas de forma assíncrona). Ver Correção 2 da Adendo 2 da
  [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).
- Scraper de acompanhamento: clique no link "número da OS" nunca gerava o evento `popup` do
  Playwright (timeout em 100% dos livros no primeiro ciclo real pós-mudança) — a tela de UCs
  abre como modal/iframe na mesma página, não janela nova, apesar de ter sido descrita como
  popup. Corrigido para aguardar os dois casos em paralelo (`Promise.any`) e usar o que vier;
  diagnóstico (screenshot) salvo automaticamente na primeira falha da execução. Ver Adendo 2
  da [ADR 0018](docs/adr/0018-restruturacao-colunas-contr-execucao-leitura.md).
- Card "Agentes em campo" (Massivas/Monitoramento de Livros) tratava todo colaborador com
  cargo MONITOR como "na base" incondicionalmente, mesmo com atividade registrada hoje.
  Agora usa a mesma checagem de atividade já usada para leituristas: MONITOR com atividade
  hoje conta em "Agentes em campo" (badge próprio "Monitor"). Badge "Na base" removido a
  pedido do usuário. Ver Adendo 11 da
  [ADR 0012](docs/adr/0012-resumo-operacional-massivas-livros.md).
- Classificação leitura/releitura usava `<=`/`>` (recebido até o próprio dia do prazo
  contava como leitura) — usuário confirmou que `data_recebimento >= data_prevista_limite`
  já é releitura. Corrigido em `massivasService.js` (Monitoramento de Livros) e
  `atividadeColaboradoresService.js` (aba Trilho), os dois lugares que replicam a regra.
  Livros que escapavam da exclusão de releitura no cálculo de "dias do prazo regulatório"
  devem parar de contar dias nas duas telas. Ver Adendo 9 da
  [ADR 0012](docs/adr/0012-resumo-operacional-massivas-livros.md).
- Monitoramento de Livros levando ~26s pra carregar (`/massivas/resumo` e
  `/massivas/detalhe`): `prazo_reg_livros` não tinha índice em `livro`, forçando um nested
  loop de ~2.032 × 13.880 comparações no JOIN incondicional introduzido no Adendo 4 da ADR
  0012. Criado índice funcional `((livro::int), mes_ref)`. No caminho, achado e corrigido um
  segundo bug real: `anexarContextoTenant` (`authMiddleware.js`) só fechava a transação em
  `res.on('finish', ...)`, que não dispara se o cliente desconecta antes da resposta
  terminar (ex.: timeout de um request lento) — deixava a transação presa em "idle in
  transaction" indefinidamente, o que por sua vez travou a criação do índice acima. Trocado
  para `res.on('close', ...)`. Ver Adendo 8 da
  [ADR 0012](docs/adr/0012-resumo-operacional-massivas-livros.md).
- `abrirContextoTenant()` fora do `try/catch` em `executarUmCiclo()` (`coletaJob.js`/
  `coletaMassivasJob.js`): se lançasse, travava o loop de coleta pro resto do dia sem nunca
  resetar `loopAtivo`. Corrigido junto com o watchdog acima. Ver
  [ADR 0017](docs/adr/0017-watchdog-loop-coleta.md).
- Ordenação por percentual da lista do Trilho "reiniciava" ao trocar de categoria (ex.: de
  "ativo" pra "sem sincronismo") — causa real: o desempate por `minutosParado` (tempo sem
  sincronizar, tipicamente centenas de minutos pra quem está "sem sincronismo") tinha peso
  grande o bastante pra inverter a ordem correta por %. Removido — o critério agora é só
  percentual, como pedido. Ícones e cores por categoria (parado/sem serviço/sem sincronismo)
  também saíram da lista colapsada — só a barra de % (cor por faixa de percentual, não por
  categoria) continua. Ver Adendo 5 da
  [ADR 0015](docs/adr/0015-percentual-execucao-e-prazo-regulatorio-por-livro.md).
- Ordenação por criticidade da lista do Trilho só valia dentro do filtro "Ativo" — "Sem
  sincronismo" e a lista sem filtro nenhum continuavam ordenados só por tempo parado, sem o
  percentual de execução. Unificado num único cálculo de criticidade reaproveitado pelos 3
  tiers. Ver Adendo 3 da
  [ADR 0015](docs/adr/0015-percentual-execucao-e-prazo-regulatorio-por-livro.md).
- Colaborador com massiva atribuída/em execução mas 0 executadas hoje (ADR 0013) aparecia
  como "ativo" na lista do Trilho — o ramo que cria a entrada tinha `parado`/`ativo` fixos,
  sem checar a quantidade digitada. Agora usa a mesma regra já validada pra
  leitura/releitura (`parado = totalRealizadas === 0`). Ver Adendo 2 da
  [ADR 0015](docs/adr/0015-percentual-execucao-e-prazo-regulatorio-por-livro.md).
- Faixas &lt;27/33/34+ dias (barra de resumo, ADR 0012) contavam **toda** linha de
  `prazo_reg_livros` do mês, mesmo livro sem nenhuma correspondência viva em
  `contr_execucao_leitura` — `prazo_reg_livros` é só uma tabela de consulta, não deve gerar
  linha por conta própria. Reescrito pra partir do livro de `contr_execucao_leitura` e só
  contar quando há correspondência real (`p.livro::int = c.livro::int`, os dois lados
  gravam o número em formatos diferentes — com/sem zero à esquerda). Sem filtro, os totais
  caíram de 161/663/10680 pra 14/143/56. Ver Adendo 4 da
  [ADR 0012](docs/adr/0012-resumo-operacional-massivas-livros.md).
- "Progresso de atividades" (barra de resumo, ADR 0012) somava leitura+releitura+massiva
  juntos em ambas as abas — efeito colateral de mesclar massiva na atividade do colaborador
  (ADR 0013). Aba Massivas chegou a mostrar 94526/206649 (um total incompatível com só
  massiva). Corrigido somando livro a livro, filtrado por `tipoServico` conforme o escopo
  da aba; Agentes em campo/Comunicação continuam globais, de propósito. Ver adendo da
  [ADR 0013](docs/adr/0013-colaboradores-massiva-no-trilho.md).
- Regressão da ADR 0011: comparar "dias em atraso"/cor da linha por timestamp completo
  (em vez de por dia) fazia todo item de **massiva** com vencimento hoje aparecer vermelho
  e "1 dia em atraso", mesmo o card "Atraso" batendo 0 — o prazo de massiva
  (`calendario_leitura.prazo_massiva`) é sempre meia-noite, sem hora, então qualquer
  comparação contra a hora real do scrape dava atrasado. Revertido: cor da linha e "dias em
  atraso" voltam a comparar só por dia (igual antes da ADR 0011) pros dois tipos de fonte;
  o cálculo hora-a-hora da releitura continua valendo nos cards (backend).

- `copelImportService.js` gravava a coluna `etapa` de `contr_execucao_leitura` como veio
  do portal da Copel — texto tipo `"ETAPA 18 - (528)"` (o número entre parênteses é uma
  contagem que muda a cada ciclo, não é parte da etapa). Agora limpa pro mesmo formato do
  resto do banco (`"18"`, `"09"` — sempre 2 dígitos) antes de inserir. As ~320 mil linhas
  já gravadas sujas foram corrigidas com um `UPDATE` retroativo (a pedido do usuário).

- Prazo/atraso de leitura e releitura na aba "Monitoramento de Livros" estava usando
  `data_prevista_limite` da própria linha, comparado por dia — não era a regra real.
  Agora: leitura usa `calendario_leitura.prazo_leitura` por etapa (01–19 urbana, 21–38
  rural); releitura usa `data_recebimento` + 24h (urbana) ou 48h (rural), por hora. De
  quebra, corrigido um bug de fuso horário do driver `pg` (`timestamp` sem timezone virava
  +3h no JSON) achado ao testar o valor real, não só se a query rodava. Ver
  [ADR 0011](docs/adr/0011-prazo-real-leitura-releitura.md).

### Alterado

- Abas reorganizadas: "Massivas" volta a ser uma aba própria (comportamento de antes da
  ADR 0006 — só dado de massiva, sem seletor de tipo). "Monitoramento de Livros" passa a
  mostrar só leitura/releitura — massiva não aparece mais lá. Ver
  [ADR 0010](docs/adr/0010-aba-massivas-dedicada.md).
- Cards da aba Trilho (lista de colaboradores + painel de detalhe do livro): cor única
  (azul) em vez de uma cor por indicador; degradê ainda mais discreto (opacidade 20%, era
  40%).

- Cards de indicador (balões) na lista de colaboradores e no painel de detalhe do livro
  trocaram o fundo de cor sólida por um degradê discreto (canto superior esquerdo mais
  saturado, esmaecendo até o tom claro de sempre) — opacidade reduzida (40%) pra ficar
  ainda mais sutil. Placeholders "Em breve" continuam com fundo neutro, sem degradê.
- Logo A2L no cabeçalho: os 3 traços que eram azul-marinho escuro (`#0B2E59`) viraram
  branco — ficavam invisíveis contra o fundo escuro do header.

### Adicionado

- Logo A2L (SVG) no lugar do título em texto no cabeçalho.
- Painel de detalhe do livro fecha ao clicar fora dele (mapa, sidebar, qualquer lugar);
  continua abrindo/trocando normalmente sem fechar-e-reabrir quando o clique é em outro
  livro da lista.
- Balões do painel de detalhe do livro trocados para o conjunto pedido: Leituras/min, Em
  Execução, Improdutivo, Km percorrido, Último sincronismo, Realizadas, A realizar,
  Impedimentos. `Km percorrido` e `Impedimentos` aparecem como "Em breve" — não existe
  fonte de dado pra nenhum dos dois hoje (sem rastreamento de GPS/distância, e a coluna
  `situacao` só tem Pendente/Atribuída/Em Execução). `Leituras/min` e `Improdutivo` também
  viraram "Em breve" a pedido do usuário — o cálculo antigo media o livro (tempo total
  visto / produtividade por intervalo do histórico), não o colaborador, e não refletia
  corretamente o que o balão promete; funções removidas de `colaboradores.service.ts`
  (`mediaLeiturasPorMinuto`, `produtividade`, `formatarDuracao` e helpers) por ficarem sem
  uso.

### Corrigido

- Mapa de bases regionais (aba "Trilho") tinha um respiro de 16px (`p-4`) ao redor —
  aparecia como uma borda clara enquadrando o mapa em vez de ocupar toda a área
  disponível. Removido; o mapa agora vai de ponta a ponta, igual ao painel de
  detalhe do livro que já ficava sem essa folga.
- Import de planilha com muitas linhas (~1.600, ex: `prazo_reg_livros`) quebrava com
  `bind message has N parameter formats but 0 parameters` — bug conhecido do driver `pg`
  (node-postgres [#2579](https://github.com/brianc/node-postgres/issues/2579)) que corrompe
  o `INSERT` multi-linha a partir de certa combinação de quantidade/conteúdo de parâmetros
  (o limiar não é previsível). `importacaoService.js` agora insere em lotes de 300 linhas em
  vez de um único `INSERT` gigante — sidestepping o bug em vez de tentar prever o limiar.
  Testado com reimportação de ~1.600 linhas sem erro.

### Alterado

- `calendario_leitura`, `cidades_localidades` e `tab_ligacao_coordenadas` deixaram de ser
  referência compartilhada entre empresas — ganharam `empresa_id` + RLS igual às demais 13
  tabelas de negócio. Cada empresa pode atender contrato/região diferente, logo tem seu
  próprio calendário de prazos, lista de localidades e coordenadas de UC; importar deixou de
  afetar todo mundo de uma vez. `ROOT` agora escolhe `?empresaId=` também pra essas 3 (mesmo
  padrão do ADR 0008). Ver [ADR 0009](docs/adr/0009-empresa_id-nas-tabelas-de-referencia.md).

### Corrigido

- Importação como `ROOT` quebrava com `null value in column "empresa_id"` — `ROOT` não tem
  empresa própria e a rota de import não dava a opção de escolher, ao contrário de
  `/usuarios`/`/coleta`. Agora `ROOT` informa `?empresaId=` (novo `GET /empresas` alimenta
  o seletor no FRONTEND, visível só quando faz sentido). Ver
  [ADR 0008](docs/adr/0008-empresa-alvo-importacao-root.md).

### Adicionado

- `tab_ligacao_coordenadas` restaurada no banco local (referência compartilhada, sem
  `empresa_id`) e habilitada na importação por planilha — upsert por `UC`. Ganhou depois um
  `id bigserial primary key`, consistente com o resto das tabelas. Ver
  [ADR 0007](docs/adr/0007-restaura-tab-ligacao-coordenadas.md).
- Filtro "Tipo · leitura/releitura/massiva" em Monitoramento de Livros — leitura/releitura
  vêm de `contr_execucao_leitura` (data_recebimento vs data_prevista_limite decide qual é
  qual), status vem da coluna `situacao`. Coluna "Tipo" nova na tabela de detalhe. Ver
  [ADR 0006](docs/adr/0006-filtro-tipo-servico-leitura-releitura.md).

### Corrigido

- `dtPrevLimite` no histórico do livro aparecia como "Thu" (um `Date` do Postgres virando
  string errada no JS) quando a linha vinha de leitura/releitura — corrigido formatando a
  data no Postgres (`to_char`) em vez de no Node.

### Alterado

- Título do painel: "Painel de Monitoramento / Olho de Deus · FIMM" → "A2l" (placeholder até
  entrar a logo).
- Aba "MONITORAMENTO" → "TRILHO"; aba "MASSIVAS" → "MONITORAMENTO DE LIVROS" (só o rótulo
  visível — chave interna da aba não mudou).

### Corrigido

- Token JWT expirado (12h) fazia o FRONTEND mostrar "API Offline" mesmo com o backend no
  ar — qualquer 401/403 numa rota autenticada era tratado como falha de rede. Agora o
  interceptor detecta sessão vencida, limpa o storage e manda pra `/login` em vez de deixar
  o app preso num estado enganoso.

## [0.3.0] - 2026-08-25

### Adicionado

- Importação de planilha (`.xlsx`) por tabela — `POST /importacao/:tabela`, restrito a
  `ADMINISTRADOR`/`ROOT`, 11 tabelas de negócio. Modo `substituir` ou `upsert` por chave
  composta, definido por tabela conforme pedido do usuário. Aba "Importação" nova no
  FRONTEND. Ver [ADR 0005](docs/adr/0005-importacao-de-planilha.md).

### Removido (banco local)

- 43 tabelas não usadas pelo app (herdadas do `pg_dump` inteiro da produção) removidas do
  Postgres **local** — só produção lá continua com todas. Restam as 12 que o app usa de
  fato mais as 3 do RBAC (`empresas`, `tenant_features`, `audit_log`). Ver
  [ADR 0004](docs/adr/0004-poda-de-tabelas-nao-usadas.md).

## [0.2.0] - 2026-08-24

### Adicionado

- Estrutura de documentação e governança do repositório (README, CONTRIBUTING, SECURITY,
  PRD, ARQUITETURA, RBAC, MODULOS, CHECKLIST, ADR, painel de acompanhamento).
- `.gitignore` na raiz cobrindo segredos, `node_modules`, build e artefatos do scraper.
- CI (`.github/workflows/ci.yml`) com lint/build/test para BACKEND e FRONTEND.
- Varredura de segredo no pre-commit e no CI via `gitleaks`.
- Postgres local self-hosted via Supabase (WSL2 + Docker), com schema copiado da produção.
- **Multi-empresa (SaaS) de verdade**: tabela `empresas`, `empresa_id` + RLS forçada em
  ~48 tabelas de negócio, 4 papéis (`ROOT`/`ADMINISTRADOR`/`SUPERVISOR`/`USUARIO`),
  `tenant_features` (catálogo de módulo por empresa), `audit_log`. Ver
  [ADR 0003](docs/adr/0003-rbac-multi-tenant.md).
- **Autenticação JWT de verdade**: login passou a emitir token (antes não emitia
  nenhum) e toda rota de negócio passou a exigi-lo — antes o middleware existia mas não
  era usado em rota nenhuma, ou seja, a API inteira estava aberta.
- `POST /usuarios` (só `ADMINISTRADOR`/`ROOT` criam usuário) e `PATCH /usuarios/me`
  (autoatendimento — só foto de perfil e preferências visuais).
- Suíte de teste provando o isolamento entre empresas
  (`BACKEND/test/isolamento_tenant.test.js`, `node --test`).
- Interceptor HTTP no FRONTEND anexando o token em toda requisição.

### Alterado

- **Removido o Prisma do BACKEND.** Acesso ao Postgres passou a ser direto via `pg`
  (node-postgres) — a lógica das ~11 consultas SQL complexas não mudou, só o driver. Ver
  [ADR 0002](docs/adr/0002-postgres-local-via-supabase-sem-prisma.md).
- `DATABASE_URL` de desenvolvimento passou a apontar para o Postgres local, não mais para o
  banco de produção compartilhado (`10.60.0.9/FIMM_COPEL`), que continua intocado.
- Código de erro de e-mail duplicado no cadastro: `P2002` (Prisma) → `23505` (Postgres).
- Perfil do projeto reclassificado de `app-single-tenant` para `saas-multi-cliente`.
- `dashboardCacheService` corrigido: era uma variável global só (vazava dashboard entre
  empresas assim que ficasse multi-tenant) — virou `Map` por `empresa_id`.

### Removido

- Endpoint público `POST /auth/registrar` (autocadastro) — substituído por
  `POST /usuarios`, restrito a `ADMINISTRADOR`/`ROOT`. Não havia uso no FRONTEND.

## [0.1.0] - histórico anterior

- Backend Express + Prisma com autenticação JWT, scraping Copel (Playwright) e jobs
  agendados de coleta.
- Frontend Angular com login, dashboard e telas de colaboradores/massivas.
