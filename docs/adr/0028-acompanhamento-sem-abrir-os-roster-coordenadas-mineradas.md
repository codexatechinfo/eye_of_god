# ADR 0028 — Acompanhamento para de abrir OS; roster de UC vem de `coordenadas_ucs_mineradas` + `base_dados_leitura`

## Contexto

Sessão anterior (ADR sobre múltiplas contas, não numerada formalmente) tentou resolver a
lentidão do scraper de Acompanhamento (35-50min por ciclo) paralelizando com até 10 contas
Copel dedicadas, uma sessão por conta, todas puxando de uma fila compartilhada de livros. Dois
testes ao vivo — 9 contas × 1 aba e 9 contas × 4 abas — mostraram que a taxa de "sessão
perdida" (o site resetando sozinho o estado da busca) ficou tão alta quanto, ou pior, que o
regime antigo de 1 conta só (1,85 e depois 2,3 colisões por livro concluído, contra ~1:1
histórico com 1 conta). Como as contas eram 100% isoladas entre si (browsers/logins distintos,
fila com `.shift()` garantindo que nenhum livro é processado por duas contas ao mesmo tempo), a
premissa "contas diferentes não colidem" caiu — o problema nunca foi sessão compartilhada, é o
site ficando instável sob chamadas repetidas de `update()` (a função que abre cada OS),
independente de quantas identidades de login estão em uso.

Usuário percebeu a saída real: a lista de livros de cada etapa (situação, colaborador, datas)
já vem inteira no DOM depois de UM clique em Buscar — não precisa abrir OS nenhuma pra saber
isso. E pra saber QUAIS UCs cada livro tem (o motivo de abrir OS até agora), já existe
`coordenadas_ucs_mineradas` (ADR 0021), minerada à parte, com `unidade_consumidora` por livro e
coordenadas geográficas. Cruzando esse roster fixo com `base_dados_leitura` (ADR 0024, dados
reais de execução com data/hora de leitura, alimentada pela extração "Controle de
Empreiteiras" — ADR 0027) dá exatamente "quais UCs desse livro foram executadas e quais não" —
sem nunca abrir uma OS. Esse padrão (`coordenadas_ucs_mineradas` pro roster + `base_dados_leitura`
pra execução real) já existia e estava provado em produção em
`obterUltimaUcRealizadaPorColaborador`/`obterJornadaColaborador` (posição no mapa, timeline de
deslocamento — ADR 0025); só precisava ser estendido aos lugares que ainda dependiam do jeito
antigo.

## Decisão

### Scraper: login + 1 busca + leitura da lista, sem fila/retry/paralelismo

`copelScraperService.js` perdeu toda a máquina construída em torno de abrir OS: `worker`,
`processarLivro`, `abrirEExtrairOs`, `extrairLinhasDetalheOs`, `recuperarAba`,
`paginaUtilizavel`, `aguardarTabelaEstabilizar`, `slowMoAdaptativo`, timeout de ciclo, e toda a
arquitetura multi-conta (`listarContasAcompanhamento`, `abrirSessaoConta`, `ABAS_POR_CONTA`).
`coletarDadosAcompanhamento()` agora é linear: login (voltou a usar `COPEL_USERNAME`/
`COPEL_PASSWORD` — a mesma conta de Massivas/Controle de Empreiteiras, já que não há mais
motivo pra contas dedicadas) → busca → itera as etapas já carregadas no DOM lendo os livros
(`extrairLivrosDaEtapa`, sem clicar/expandir nada) → retorna. Resultado real medido: **ciclo
completo em 28-58s** (contra 35-50min do regime anterior), 1000-2000 livros por ciclo.

Como Acompanhamento voltou a logar com a mesma conta de Massivas, `coletaCopelService.js`
voltou a usar `comSessaoExclusiva` (`copelSessaoLock.js`, ADR 0019) — a fila que evita dois
jobs derrubando a sessão um do outro, desnecessária durante a fase de contas dedicadas.

### `contr_execucao_leitura`: 1 linha por livro por ciclo, sem `uc`/`codigo`

`copelImportService.js` não precisou mudar — `registros` chega no mesmo shape de sempre, só
que nunca mais traz `uc/codigo/equipamento/tipo_especificacao/faturamento/leitura_atual`
(campos que só existiam vindos da abertura de OS); o código já grava `NULL` quando o campo
está ausente. Volume por ciclo caiu de dezenas de milhares de linhas (1 por UC) pra ~1-2 mil (1
por livro).

### Todo consumidor de `contr_execucao_leitura.uc`/`.codigo` migrado pro padrão roster+evento

Levantamento (não previsto no pedido original, achado ao implementar) encontrou 6 pontos
dependendo dos campos por-UC que deixaram de existir:

- `monitoramentoService.js#consultarUcsBrutasDoLivro` (painel de detalhe do livro, aba Trilho)
  e `#obterEventosPorLivrosAteData` (roster usado pela barra lateral/`listarAtividadeHoje`) —
  UC do livro agora vem de `coordenadas_ucs_mineradas` (casamento numérico `livro::int`, já que
  o formato diverge só por zero à esquerda — mesmo achado da ADR 0021).
- `monitoramentoService.js#historicoContrLivro` — evolução por lote reescrita: pontos no tempo
  vêm de `contr_execucao_leitura` (1 por ciclo agora, sem GROUP BY por UC), `digitados` de cada
  ponto é a contagem de UCs do roster com primeira leitura (`buscarEventosLeitura`/
  `escolherPorUc`, já existentes) até aquele instante.
- `monitoramentoService.js#contarFonteContr`/`#obterFaixasDias`/`#detalheContr` — os três
  pontos centrais da tela "Monitoramento de Livros" (cards de resumo, faixas de dias 27/33/34+,
  tabela de detalhe). Nova função compartilhada `obterProgressoPorLivro(db, livros,
  dataImport)` reaproveita `obterEventosPorLivrosAteData` (já cacheado) pra devolver
  `Map<livro, {digitados, naoDigitados}>`; os três consumidores simplificaram a query SQL
  (sem `DISTINCT ON`/window function — `contr_execucao_leitura` já tem 1 linha por livro) e
  passaram a mesclar os totais em JS.
- `leituraUrbanaService.js#calcularLeituraUrbana` (painel por etapa/regional, recalculado a
  cada ciclo) — mesmo padrão: fetch livro-a-livro simplificado, `obterProgressoPorLivro`,
  agregação por etapa+base em JS.
- `monitoramentoService.js#obterRegimeSucessivo` (popup de impedimento consecutivo por UC) —
  código mensal agora vem de `base_dados_leitura.mensagem` via `extrairCodigoDeMensagem`, não
  mais de `contr_execucao_leitura.codigo`.

Código morto removido depois da migração: `contrDedupSql`, `CONTR_REALIZADO_LINHA_SQL`,
`CONTR_NAO_REALIZADO_LINHA_SQL`, `CONTR_REALIZADO_LIVRO_SQL`, `CONTR_NAO_REALIZADO_LIVRO_SQL` —
existiam só pra deduplicar/agregar UC dentro de um livro, sem sentido com 1 linha por livro.

### Índice novo

`idx_coordenadas_ucs_mineradas_livro_int` em `coordenadas_ucs_mineradas ((livro::integer))
WHERE livro ~ '^[0-9]+$'` — tabela com 4,1 milhões de linhas, sem índice em `livro` antes;
todo o roster novo depende de filtrar por livro nessa tabela (mesmo padrão de
`idx_base_dados_leitura_livro_int`, ADR 0025).

## Consequências

- Ciclo de Acompanhamento **~40-80x mais rápido**, sem paralelismo nenhum — elimina de vez a
  fonte de "sessão perdida" (não sobra nenhuma chamada repetida de `update()` pra colidir).
- `contr_execucao_leitura` só serve mais pra situação do livro (Pendente/Atribuída/Em
  Execução) e colaborador — nunca mais fonte de dado por UC. Todo dado por UC (quais existem,
  quais foram executadas, quando, onde) vem de `coordenadas_ucs_mineradas` + `base_dados_leitura`.
- `.env`: `COPEL_ACOMP_USERNAME_N`/`COPEL_PARALELISMO_ACOMP`/`COPEL_ABAS_POR_CONTA`/
  `COPEL_TIMEOUT_CICLO_MIN`/`COPEL_SLOWMO_INICIAL_MS` sem uso — removidos do `.env.example`.
- Precisão marginalmente mais grosseira em dois pontos aceitos como troca razoável: (1) o
  progresso digitados/naoDigitados usa corte por **dia** (`data_import`, não `hora_import`) —
  suficiente já que `base_dados_leitura` só recebe carga em importação diária; (2) o roster de
  UC por livro depende de `coordenadas_ucs_mineradas` estar atualizada — um livro reatribuído
  recentemente que ainda não foi re-minerado pode mostrar roster desatualizado (mesma limitação
  que a ADR 0021 já assumia pra essa tabela em outros usos).

## Verificação

`npm test` (12/12) e `node --check` em todos os arquivos alterados. Ciclo ao vivo real: 1975
livros coletados e importados em ~3min; `contr_execucao_leitura` confirmada com 1 linha por
livro, `uc`/`codigo` em branco. Chamadas diretas contra o banco (fora do navegador, sem
credencial de login pro app) confirmaram consistência cruzada: `obterUcsDoLivro` e
`obterHistoricoLivro` concordando no total de UCs realizadas pro mesmo livro; `obterResumo`/
`obterDetalhe` com contagens não-zero e variadas por livro; coordenadas/distância/velocidade de
deslocamento calculadas corretamente no painel do livro. Um bug real achado e corrigido durante
o teste: `obterEventosPorLivrosAteData` ficou com um parâmetro (`$1`, a lista de livros em
texto) sem nenhuma referência na query depois da reescrita do roster — Postgres não consegue
inferir o tipo de um parâmetro nunca usado ("could not determine data type of parameter $1"),
erro reproduzido ao vivo (falha no recálculo do painel Leitura Urbana) e corrigido removendo o
parâmetro morto e renumerando.

## Adendo 1 (2026-09-03) — lista de ETAPAs travando em 2; logs dos 3 jobs sem separação visual

Depois da decisão principal em produção, dois problemas achados ao vivo na mesma sessão:

### Lista de ETAPAs carregava só 2, mesmo existindo mais com dado real

`aguardarTodasEtapasCarregadas` ([copelScraperService.js](../../BACKEND/src/services/copelScraperService.js))
rola a página em passos até a contagem de links `ETAPA` estabilizar — mecanismo correto (não
depende de calendário nenhum, só do que a página carrega). Duas causas, achadas com debug ao
vivo e confirmadas com print do portal (ETAPA01-(261) batendo exato com o scraper, mas
ETAPA03/04/21+ nunca aparecendo):

1. **`stylesheet` bloqueado** no `context.route()` fazia a página, sem CSS, colapsar pra caber
   na altura da viewport (`document.body.scrollHeight == window.innerHeight`) — `scrollBy()`
   ficava sem nada pra rolar. Tirado do bloqueio (continua bloqueando `image`/`font`/`media`).
2. **Ciclos voltando a cada 5s** (intervalo herdado de quando o ciclo levava 35-50min, ADR 0028
   principal) não davam folga pro site terminar de montar a lista antes do próximo login. Pausa
   entre ciclos subiu pra 3min (`coletaJob.js`).

Verificação: dois ciclos ao vivo consecutivos depois do fix encontraram 1949 e depois 2028
livros em 12 etapas (antes: travava consistentemente em 2 etapas). Confirmação exaustiva de que
12 é o total exato pro filtro concessionária/empreiteira em uso fica pendente de conferência
manual no portal — o que já está comprovado é que a lista deixou de travar cedo.

### Logs dos 3 jobs concorrentes (`Massivas`, `Coleta Acomp`, `Controle Empreiteiras`) sem separação visual

Os 3 loops rodam concorrentes e escrevem no mesmo terminal, intercalando linha a linha — usuário
reportou confusão ao vivo ("está colocando todo mundo no mesmo bolo"). Duas causas:

1. Nem todo log passava por `log()`/`logWarn()`/`logErro()` de `logTempo.js` (timestamp
   `hh:mm:ss.mmm`) — os wrappers de job (`coletaJob.js`, `coletaMassivasJob.js`,
   `coletaMassivasService.js`) e o scraper de Massivas/Controle de Empreiteiras usavam
   `console.log`/`warn`/`error` direto, sem hora, dificultando correlacionar a ordem real entre
   jobs. Unificado: todo log de job agora passa por `logTempo.js`.
2. Nada distinguia visualmente de qual job veio cada linha além do texto do prefixo. `logTempo.js`
   agora colore automaticamente o prefixo `[Nome do Job]` de cada linha (ciano pra Massivas,
   verde pra Coleta Acomp, amarelo pra Controle de Empreiteiras) — sem precisar mudar nada nos
   pontos de chamada além de trocar `console.*` por `log`/`logWarn`/`logErro`. Mensagem
   `[Massivas] ✅ Coleta de massivas finalizada.` também renomeada pra deixar explícito que cobre
   o Controle de Empreiteiras encadeado, não só a parte de massivas.
