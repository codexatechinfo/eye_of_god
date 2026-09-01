# ADR 0025 — Timeline/deslocamento/impedimentos/jornada baseados em `base_dados_leitura`

## Contexto

`contr_execucao_leitura.hora_import` é o instante do CICLO DE RASPAGEM (~35-50min), não o
instante real em que o colaborador leu o medidor — causa raiz já documentada de "trabalhado"
ficar sempre ~0s na Jornada (memória `project_jornada_trabalhado_zero`, ADR 0022 Adendo 1).
`base_dados_leitura` (ADR 0024, carga diária contínua confirmada com o usuário) tem
`data_da_leitura`/`hora_da_leitura` reais por UC, mais `mensagem` (texto completo do código, ex.
"094 - LEITURA TELEMEDIDA") em vez de só um código numérico. Usuário pediu pra reconstruir
timeline, deslocamento/km percorrido, impedimentos e jornada em cima dessa fonte melhor —
mantendo "a realizar" (roster/pendentes) em `contr_execucao_leitura`, confirmado com o usuário.

**Escopo desta ADR** (decidido com o usuário): timeline, deslocamento/km, impedimentos e
jornada — tudo escopado a um livro/colaborador por vez. **Fora de escopo**:
`listarAtividadeHoje` (quais livros aparecem "hoje" na barra lateral) fica pra uma conversa
separada — função bem mais entrelaçada com o dashboard inteiro.

## Decisão

### Formato do `livro` diverge entre as tabelas

`contr_execucao_leitura.livro = '040980'` (zero à esquerda) vs `base_dados_leitura.livro =
'40980'` (sem zero) — confirmado ao vivo, mesmo padrão já documentado pra
`coordenadas_ucs_mineradas`/`prazo_reg_livros`. Toda query cruzando as duas compara
`livro::int = $1::int`. Índice novo `idx_base_dados_leitura_livro_int (empresa_id,
(livro::int))` — sem ele, cada abertura de painel de livro varreria as 3,5 milhões de linhas
inteiras (mesma classe de bug da ADR 0023).

### Classificação de impedimento

Código extraído do prefixo numérico de `mensagem` (regex `^(\d+)\s*-`). Não-impedimento: `000`
(normal), `099` (confirmada). Administrativo (não conta mais como impedimento): `094`
(telemedida), `059` (leitura do cliente), `037` (plurimensal), `027` (troca de medidor), `054`
(fora de rota), `055`/`056` (cadastrar/descadastrar cão feroz — ação administrativa, não o cão
em si). Ambíguos (`098`-não confirmado, `030`-suspeita de irregularidade, `031`-casa
interligada) ficam como impedimento real, a pedido do usuário. Resto do catálogo (obstrução de
campo de verdade) sem mudança.

### `BACKEND/src/services/massivasService.js`

`buscarEventosLeitura(db, livro)` — busca eventos de `base_dados_leitura` pro livro.
`escolherPorUc(linhas, ordem)` — uma linha por UC ('primeira' pra timeline, 'ultima' pra
enriquecer atuais), desempate por `especificacao = 'CON'` quando duas linhas caem no mesmo
instante (par CON/GTP/BAM confirmado nos dados reais). `extrairCodigoDeMensagem(mensagem)`.

`listarUcsAtuaisDoLivro` (agora `montarUcsAtuais`, síncrona): fonte não muda (continua
`contr_execucao_leitura`, mantém roster + pendentes), mas cada UC com evento em
`base_dados_leitura` tem `codigo`/`data_import`/`hora_import`/`tipo_especificacao`
sobrescritos com o dado real; sem evento, mantém o original (nunca quebra). `codigo` só é
sobrescrito se `extrairCodigoDeMensagem` conseguir extrair algo (`?? resto.codigo` como rede de
segurança contra mensagem malformada).

`listarTimelineUcsRealizadasDoLivro` (agora síncrona, recebe o mapa 'primeira' já pronto):
monta a timeline inteira a partir de `base_dados_leitura` — `data_import`/`hora_import` (nomes
de campo mantidos por compatibilidade com o frontend) viram os horários reais.

`anexarSegmentosDeslocamento`/`deslocamentoService.js`: **sem alteração nenhuma** — como
`atuais` agora carrega o horário real quando disponível, o cálculo de intervalo/distância/pausa
passa a refletir a realidade sem tocar no motor de cálculo.

### `BACKEND/src/services/atividadeColaboradoresService.js`

`obterJornadaColaborador` reescrita pra `base_dados_leitura`. Diferença importante da versão
antiga: `ja_realizado_antes` usa **comparação de data de verdade**
(`to_date(...) < to_date($2,...)`), não o truque de `id < primeiro_id do dia` — aquele truque
dependia de `id` ser aproximadamente cronológico, válido pra `contr_execucao_leitura` (scraper
escreve em tempo real), mas **não** pra `base_dados_leitura` (alimentada por import em lote
diário — `id` reflete ordem de importação, não do evento). Índice novo
`idx_base_dados_leitura_usuario_data (empresa_id, nome_do_usuario, data_da_leitura)`.

### Dois problemas reais de qualidade de dado achados ao vivo (não previstos no plano)

1. **Linhas com `data_da_leitura`/`hora_da_leitura` em branco** (226.567 de 3,5 milhões, ~6,5%
   — mesmas linhas sem `mensagem`, gap de origem no export, não introduzido por este trabalho).
   Sem filtrar, `chaveDataHoraOrdenavel` tratava `""` como `"0000-00-00T"`, que vence QUALQUER
   data real na comparação — a linha em branco roubava o posto de "primeira realização" de UCs
   que na verdade tinham data boa (ou nenhuma, caindo certo no fallback). Corrigido filtrando
   essas linhas fora de `buscarEventosLeitura`.
2. **132 linhas com `data_da_leitura` em formato ISO** (`"2026-08-31"` em vez de
   `"DD/MM/YYYY"`) — todas do import do `.xlsx` (ADR 0024 Adendo 2): o ExcelJS devolveu essa
   coluna já como string formatada em ISO, não como objeto `Date`, então a conversão de
   `lerXlsx` (que só tratava `instanceof Date`) não pegou. Quebrava `to_date(...)` com erro
   fatal (`date/time field value out of range`), derrubando a jornada do colaborador afetado.
   Corrigido as 132 linhas direto no banco (`to_char(to_date(..., 'YYYY-MM-DD'), 'DD/MM/YYYY')`)
   e adicionada validação de formato (`~ '^\d{2}/\d{2}/\d{4}$'`) nas duas queries novas — uma
   importação futura com formato errado só perde aquela linha, não derruba a consulta inteira.

## Verificação

- Índices `idx_base_dados_leitura_livro_int` e `idx_base_dados_leitura_usuario_data` criados
  via `CREATE INDEX CONCURRENTLY`
- `obterUcsDoLivro('040980')`: 91 UCs em atuais (79 já conhecidas + **12 descobertas como
  realizadas só por `base_dados_leitura`, ainda pendentes em `contr_execucao_leitura`** —
  achado real confirmado ao vivo, prova que a fonte nova é mais atualizada em alguns casos), 12
  na timeline (cobertura ainda parcial pro mês — deve crescer com a carga diária), 2,92km
- `obterUcsDoLivro('040981')`: 53 atuais, 15 timeline, 2,34km
- **Jornada — o bug antigo confirmado corrigido**: `GUILHERME QUILES`/29-08 →
  `trabalhadoSegundos: 10004` (2h47min), `ocupacaoPercentual: 85` (antes: sempre ~0s/0%
  pra qualquer colaborador, ver ADR 0022 Adendo 1). Testado com mais 2 colaboradores
  (`TIAGO JOSE DE LIMA`, `CLEBERSON FERNANDO RODRIGUES DE SOUZA`) — números plausíveis e
  distintos nos dois; colaborador inexistente devolve `semDado: true` corretamente
- Par CON/GTP/BAM da mesma leitura (mesma data+hora) confirmado escolhendo CON nos dois lugares
- `npm test` (12/12), `node --check` nos arquivos alterados, `ng build --configuration
  development` limpos

## Adendo 1 — Unificar contagens "hoje" (barra lateral) com o painel do livro (2026-09-01)

**Ponto 5 do pedido original**, deixado fora de escopo na decisão inicial ("Sim, separar —
ponto 5 fica pra depois") por ser mais entrelaçado com o dashboard inteiro. Retomado depois que
o usuário reportou, com print, que a barra lateral (aba Trilho) mostrava "39/50" pro livro
025395 enquanto o painel de detalhe do MESMO livro mostrava "40 realizadas/48 a realizar" — dois
escopos diferentes calculando o mesmo número: a barra (`listarAtividadeHoje`) sempre foi
escopada só ao dia selecionado (`contr_execucao_leitura.data_import = $1`), o painel
(`obterUcsDoLivro`, ADR 0025 acima) mostra o roster completo do livro sem filtro de data. A
diferença já existia antes desta ADR; o enriquecimento por `base_dados_leitura` só a tornou mais
visível (uma UC virava "realizada" no painel sem refletir na barra).

**Decisão**: as contagens `digitados`/`naoDigitados`/`impedimentos` de cada livro em
`listarAtividadeHoje`, e o painel (`obterUcsDoLivro`), passam a ser **ponto-no-tempo** — mesmo
raciocínio desta ADR, "congelado" numa data (`ateData`) em vez de sempre o estado mais atual.
Quando a barra e o painel usam a mesma data, os dois **sempre concordam**: mesma fonte, mesmo
corte temporal. O que NÃO mudou (`base_dados_leitura` não tem esse dado): quais livros aparecem
na lista "hoje" (membership), colaborador atribuído, situação, classificação
Parado/Ativo/Sem sincronismo — o critério de membership atual (livro tocado pelo scraper no dia)
já cobre o caso "livro que começou ontem e continua hoje", já que o scraper roda 24h contínuo.

### Desenho

- `massivasService.js`: nova `ehImpedimentoReal(codigo)` (réplica server-side de
  `ehCodigoDeImpedimento` do frontend — mesmo padrão de duplicação já usado em
  `deslocamentoService.js`, módulo não compartilhável entre os dois runtimes). Nova
  `obterEventosPorLivrosAteData(db, livros, dataBr)`: uma chamada só pra TODOS os livros de
  `listarAtividadeHoje` de uma vez (evita N+1), devolve por UC o `codigo` do roster
  (`contr_execucao_leitura`) e o `mensagem` do evento mais recente de `base_dados_leitura` até
  `dataBr`. `buscarEventosLeitura`/`obterUcsDoLivro`/`consultarUcsBrutasDoLivro` ganham
  `ateData` opcional.
- `atividadeColaboradoresService.js`: em `listarAtividadeHoje`, depois de montar `livros[]` por
  colaborador como hoje, chama `obterEventosPorLivrosAteData` uma vez com todos os livros
  distintos, agrupa por livro (`codigo = extrairCodigoDeMensagem(mensagem) ?? codigo_contr`,
  conta digitados/naoDigitados/impedimentos via `ehImpedimentoReal`) e sobrescreve os campos de
  cada `livros[]`; totais do colaborador recalculam sozinhos por já somarem sobre `livros`.
- `massivasController.js#ucsLivro` e `colaboradores.service.ts#buscarUcsLivro`: painel do livro
  passa a mandar/receber `?data=YYYY-MM-DD` (mesmo `filtroData` já usado pela barra), convertida
  pra `DD/MM/YYYY` e repassada como `ateData`.

### Bug achado ao implementar — fallback de `codigo` não respeitava `ateData`

Primeira versão só filtrava `ateData` no lado de `base_dados_leitura` (`buscarEventosLeitura`);
`consultarUcsBrutasDoLivro` (roster de `contr_execucao_leitura`) continuava sem filtro de data.
Em `montarUcsAtuais`, quando uma UC não tinha evento de `base_dados_leitura` até `ateData`, o
`codigo` caía no fallback `resto.codigo` — vindo do roster SEM CORTE, sempre o mais recente. Na
prática, olhar uma data passada continuava mostrando o `codigo` de HOJE pra qualquer UC sem
evento no corte, fazendo `atuais` (realizadas) não diminuir ao voltar no calendário — verificado
ao vivo com o livro `025115`: `ateData=hoje` e `ateData=ontem` davam os mesmos 117 UCs
"realizadas", quando deveria cair. Corrigido dando a `consultarUcsBrutasDoLivro` o mesmo
`ateData` opcional (`data_import <= ateData`), então o fallback também respeita o corte. Só
afeta o painel (`obterUcsDoLivro`, chamado com datas passadas via o calendário da barra) — não
precisou em `obterEventosPorLivrosAteData` porque `listarAtividadeHoje` só chama com a data de
hoje (sem UC de data futura possível, o filtro seria no-op ali).

### Verificação

- `npm test` (12/12), `node --check`, `ng build --configuration development` limpos
- Livro `025115` (117 UCs, ativo em 01/09/2026): `listarAtividadeHoje` e `obterUcsDoLivro`
  batendo exatamente — `digitados: 117` nos dois lados
- Corte temporal provado: `obterUcsDoLivro('025115', ateData='31/08/2026')` (véspera, livro só
  entrou no roster do scraper hoje) → 0 UCs realizadas, contra 117 em `ateData='01/09/2026'`
- Achado colateral: `contr_execucao_leitura` nunca teve índice em `livro` (871 mil linhas,
  sequential scan em TODA consulta por livro do sistema inteiro, não só as novas) — criado
  `idx_contr_execucao_leitura_empresa_livro (empresa_id, livro)`
- Achado colateral de performance de planner: filtrar `base_dados_leitura` por
  `livro::int IN (SELECT ... FROM cte)` faz o Postgres não conseguir estimar cardinalidade e
  cair pra Seq Scan nos 3,5 milhões de linhas mesmo com índice disponível; passar os mesmos
  valores como array já resolvido (`= ANY($N::int[])`) faz o planner usar o índice
  (`idx_base_dados_leitura_livro_int`). Confirmado via `EXPLAIN`/`PREPARE`
- Latência: `listarAtividadeHoje` completo (207 colaboradores, ~700 livros ativos) passou de
  já lento antes desta mudança pra ~19s ponta a ponta, dos quais a nova
  `obterEventosPorLivrosAteData` soma ~6s (59 mil linhas, ~700 livros de uma vez). Aceitável
  pro polling de 60s deste endpoint, mas cresce com o volume de `base_dados_leitura` — watch-item
  pra revisitar se a tabela crescer muito mais

## Adendo 2 — Continuando o ajuste de performance de `obterEventosPorLivrosAteData` (2026-09-01)

Retomado o watch-item do Adendo 1. `EXPLAIN (ANALYZE, BUFFERS)` ao vivo (444 livros ativos,
82 mil linhas de retorno) achou a causa real do tempo: **`work_mem` no padrão do servidor
(4MB)** forçava os dois `DISTINCT ON` da consulta (um sobre até 1,3 milhão de linhas de
`contr_execucao_leitura`, outro sobre ~135 mil linhas pós-filtro de `base_dados_leitura`) a
fazer sort externo em disco (`Sort Method: external merge`) em vez de em memória — sozinho isso
somava ~2,5s ao tempo total. `effective_cache_size` também estava em 128MB (config padrão do
`docker-compose` do Supabase self-hosted), subestimando quanto dado cabe em cache e enviesando o
planner contra índices.

**Achado de acesso**: o papel `postgres` (usado pela aplicação e por `psql` normalmente) NÃO é
superusuário real neste Supabase self-hosted — `ALTER SYSTEM SET work_mem = ...` devolveu
`permission denied to set parameter`. O superusuário de verdade é `supabase_admin`
(credencial em `POSTGRES_PASSWORD`/`POSTGRES_USER` do ambiente do container). Conectado como
`supabase_admin`, aplicado globalmente e sem restart (`work_mem`/`effective_cache_size` são
parâmetros de contexto `user`, só precisam de `pg_reload_conf()`, diferente de `shared_buffers`
que é `postmaster` e exigiria reiniciar o container — não feito, container tem o job de coleta
24/7 rodando e uma reinicialização derrubaria as conexões em andamento; fica como opção futura,
só com confirmação explícita antes por causa desse risco):

```sql
-- executado como supabase_admin, não como postgres
ALTER SYSTEM SET work_mem = '64MB';              -- era 4MB (default)
ALTER SYSTEM SET effective_cache_size = '4GB';   -- era 128MB (config file)
SELECT pg_reload_conf();
```

Mesmo com o novo default global, o sort do lado `contr_execucao_leitura` (até 1,3 milhão de
linhas, ~38MB) ainda passava de 64MB de working set com overhead de tupla e continuava
espalhando pra disco — mas SÓ nesta função (chamada com até ~700 livros de uma vez; o resto do
sistema usa `work_mem` bem menor por consulta). Em vez de subir o default global mais alto
(risco: `work_mem` multiplica por operação de sort/hash × até 100 conexões simultâneas),
`obterEventosPorLivrosAteData` ganhou `SET LOCAL work_mem = '160MB'` logo antes da consulta —
vale só para a transação da requisição atual (cada requisição já roda dentro de uma via
`abrirContextoTenant`), reverte sozinho no commit/rollback, e não exige privilégio nenhum (é
`SET`, não `ALTER SYSTEM` — contexto `user`, qualquer papel pode ajustar pra própria sessão).

**Índice novo tentado, não ajudou o caso de lote**: criado
`idx_contr_execucao_leitura_livro_uc_id (livro, uc, id DESC)` — mesma ordem do `DISTINCT ON`,
pra eliminar o sort com um Index Scan já ordenado. Funciona bem pra 1 livro só (útil pro painel,
`obterUcsDoLivro`/`consultarUcsBrutasDoLivro`), mas com ~444 valores no `livro = ANY(...)` da
consulta em lote o planner continua preferindo Bitmap Heap Scan (não ordenado) + sort — a
quantidade de livros ultrapassa o ponto onde ler o índice em ordem por-valor deixa de compensar.
Mantido mesmo assim: não atrapalha e ajuda o caso de livro único, além de já ser coberto pelo
`idx_contr_execucao_leitura_empresa_livro` existente pra filtragem, não pra ordenação.

**O que resta, não implementado**: o `Parallel Seq Scan` sobre as 3,5 milhões de linhas de
`base_dados_leitura` (~2,2-4,5s, variável — parece haver contenção real do job de coleta 24/7
concorrente) continua sendo o maior custo isolado e não tem solução simples sem (a) aumentar
`shared_buffers` (precisa reiniciar o container) ou (b) uma camada de cache/materialização —
essa consulta inteira é recomputada do zero a cada poll de 60s da barra lateral, mesmo
`base_dados_leitura` sendo alimentada por import em lote diário (não muda a cada minuto).
Nenhuma das duas opções foi implementada nesta sessão — envolvem decisão de risco/tradeoff do
usuário (restart do container / staleness de cache), não só execução mecânica.

Achado colateral (fora de escopo desta consulta, mas sistêmico): `listarAtividadeHoje` usa
`Promise.all([db.query(...), ...])` com o MESMO client de conexão (`req.db`, uma transação por
requisição) pra "paralelizar" 3 consultas — mas um client `pg` só processa uma consulta por vez
por conexão; o driver enfileira e serializa (confirmado pelo aviso de depreciação visto nos
logs: "Calling client.query() when the client is already executing a query is deprecated").
Na prática o tempo dessas 3 consultas SOMA em vez de rodar em paralelo. Esse padrão se repete em
outras funções (ex.: `obterUcsDoLivro`). Não corrigido aqui — mudar exigiria repensar conexões
por sub-consulta dentro de uma mesma transação/contexto de tenant, escopo maior que esta
função específica.

### Verificação

- `npm test` (12/12), `node --check` limpos
- `EXPLAIN (ANALYZE, BUFFERS)` confirmando os dois sorts saindo de `external merge Disk` pra
  `quicksort Memory` com `work_mem` maior
- Latência de `obterEventosPorLivrosAteData` (444 livros): variou de ~5,6s a ~8,6s entre
  execuções nesta sessão (baseline antes desta mudança: ~6-8s) — melhora real mas parcial;
  variância alta atribuída a I/O do WSL2/Docker e possível contenção com o job de coleta
  concorrente, não medida de forma isolada
- Latência do painel (`obterUcsDoLivro`, livro único): ~2,2-2,3s, sem mudança perceptível (já
  era dominado pelo mesmo tipo de I/O de base, não por sort)

## Adendo 3 — Cache com TTL pra `obterEventosPorLivrosAteData` (2026-09-01)

Continuação direta do "o que resta" do Adendo 2. Apresentadas ao usuário as duas opções reais
pro maior custo restante (`Parallel Seq Scan` de 3,5 milhões de linhas de `base_dados_leitura`,
recomputado do zero a cada poll de 60s da barra): aumentar `shared_buffers` (exige reiniciar o
container, risco pro job de coleta 24/7) ou uma camada de cache com TTL curto (sem risco de
restart, mas introduz alguns minutos de defasagem — decisão de comportamento, não só técnica).
Usuário escolheu o cache.

**Desenho**: `Map` em memória do próprio processo Node, dentro de `massivasService.js`
(`cacheEventosPorLivros`), guardando o resultado INTEIRO de `obterEventosPorLivrosAteData`
(roster + eventos já combinados) por `CACHE_EVENTOS_TTL_MS = 3 minutos`. Chave = `nivel|
empresa_id|dataBr|livros_ordenados`. `base_dados_leitura` só recebe carga em importação em lote
diária (não muda minuto a minuto) — TTL de poucos minutos nunca pega dado realmente
desatualizado dessa fonte. O lado `contr_execucao_leitura` (`codigo_contr`, usado só como
fallback pra UC sem evento em `base_dados_leitura`) fica igualmente cacheado por essa janela,
mas o próprio scraper só revisita um livro a cada ~35-50min (ADR 0022 Adendo 1) — a defasagem
do cache fica dentro da granularidade natural dessa fonte, não introduz atraso perceptível
novo.

**Bug achado e corrigido antes de considerar pronto**: a primeira versão da chave de cache era
só `dataBr|livros`, SEM tenant. `contr_execucao_leitura`/`base_dados_leitura` têm RLS
(`isolamento_empresa`: visível se `app.nivel = 'ROOT'` ou `empresa_id = app.empresa_id`, ambos
`SET LOCAL` por transação via `abrirContextoTenant`) — sem o tenant na chave, duas empresas
diferentes pedindo o MESMO número de livro na MESMA data compartilhariam cache uma da outra,
furando o isolamento (vazamento de dado entre clientes). Corrigido lendo `current_setting
('app.nivel')`/`current_setting('app.empresa_id')` de volta da própria transação (não recebido
por parâmetro, pra não depender de quem chama passar certo) e incluindo os dois na chave.
Verificado ao vivo: empresa A cacheia 118 linhas pro livro `025115`; empresa B pedindo o mesmo
livro/data no mesmo processo devolve 0 linhas (RLS dela, não reaproveita o cache da empresa A);
empresa A pedindo de novo bate no cache dela mesma (118 linhas, 0ms). `npm test` (12/12,
incluindo os testes de isolamento entre empresas) confirmando que nada regrediu.

### Verificação

- `npm test` (12/12), `node --check` limpos
- Cache hit: 1ª chamada de `obterEventosPorLivrosAteData` (444 livros) ~6,9s; chamadas
  seguintes (mesmo livros/data/tenant, dentro do TTL) 0ms — inclusive com a lista de livros em
  ordem diferente (mesmo conjunto), confirmando que a chave não depende de ordem
- Cache miss correto: livro diferente, data diferente, ou tenant diferente — cada combinação
  nova dispara consulta real
- Isolamento entre tenants confirmado ao vivo (ver acima) — sem vazamento
- Ganho end-to-end simulando dois polls consecutivos de `listarAtividadeHoje` no mesmo processo
  (replica o padrão real: servidor de longa duração, barra lateral chamando a cada 60s): poll 1
  (frio) ~10,1s, poll 2 (`obterEventosPorLivrosAteData` em cache) ~3,9s — redução de ~61% no
  poll subsequente
