# ADR 0018 — Reestruturação de colunas de `contr_execucao_leitura`

## Contexto

Usuário pediu para alterar a estrutura de `contr_execucao_leitura` (a tabela de leitura/
releitura alimentada pelo scraper de acompanhamento Copel, fonte da aba Monitoramento de
Livros e de boa parte da aba Trilho):

**Colunas removidas**: `tipo_oss`, `subtipo_os`, `numero_os`, `data_ultima_atualizacao`,
`qtd_digitados_nao_digitados`, `qtd_com_leitura_sem_leitura`, `percentual_sem_leitura`,
`qtd_fora_de_faixa_foto`.

**Colunas mantidas**: `etapa`, `localidade`, `livro`, `empreiteira`, `data_recebimento`,
`hora_recebimento`, `data_prevista_limite`, `situacao` — mais `data_import`/`hora_import`
(confirmado com o usuário que continuam existindo; ele só não as citou porque são metadados
carimbados na importação, não vêm do scraping em si) e `id`/`empresa_id` (chave e RLS).

**Colunas novas**: `uc`, `colaborador`, `codigo`, `equipamento`, `tipo_especificacao`,
`faturamento`, `leitura_atual` — todas `varchar(255)`, mesmo padrão das demais. Usuário
confirmou que vêm de **outra aba do portal Copel**, ainda não indicada — o scraping dessas
colunas fica pendente de instrução futura.

A tabela já estava vazia no momento da mudança (truncada a pedido do usuário momentos antes,
neste mesmo ciclo de trabalho), então não houve perda de dado real na alteração de schema em
si.

## Decisão

### DDL

```sql
ALTER TABLE public.contr_execucao_leitura
  DROP COLUMN tipo_oss,
  DROP COLUMN subtipo_os,
  DROP COLUMN numero_os,
  DROP COLUMN data_ultima_atualizacao,
  DROP COLUMN qtd_digitados_nao_digitados,
  DROP COLUMN qtd_com_leitura_sem_leitura,
  DROP COLUMN percentual_sem_leitura,
  DROP COLUMN qtd_fora_de_faixa_foto,
  ADD COLUMN uc character varying(255),
  ADD COLUMN colaborador character varying(255),
  ADD COLUMN codigo character varying(255),
  ADD COLUMN equipamento character varying(255),
  ADD COLUMN tipo_especificacao character varying(255),
  ADD COLUMN faturamento character varying(255),
  ADD COLUMN leitura_atual character varying(255);
```

Rodado como `postgres` dentro do container `supabase-db` (`app_user` não é dono da tabela —
mesmo padrão de todo DDL neste projeto). RLS/FK/PK preservados (`ALTER TABLE ... DROP/ADD
COLUMN` não mexe neles).

### `copelImportService.js`: scraping posicional continua intacto, gravação muda

O scraper (`copelScraperService.js`) lê a tabela `#item` do portal **por posição de
célula**, sem nome — a ordem das 16 colunas originais (`CAMPOS`, agora renomeado
`CAMPOS_SCRAPER`) tinha que continuar batendo com o HTML da página, senão o parse inteiro
desalinha. Como o usuário não indicou mudança no layout dessa tabela específica (só disse
que as colunas novas vêm de **outra** aba), `CAMPOS_SCRAPER` foi mantido do jeito que estava.

Separado um segundo array, `CAMPOS_TABELA` (`etapa, localidade, livro, empreiteira,
data_recebimento, hora_recebimento, data_prevista_limite, situacao`), usado só para montar o
`INSERT` — o parse continua extraindo as 16 posições originais para um objeto (`obj`), mas só
os 8 campos de `CAMPOS_TABELA` são de fato escritos no banco. As 7 colunas novas ficam de fora
do `INSERT` por enquanto (default `NULL`, todas nullable) até o scraping da aba nova ser
implementado.

### Código dependente de `qtd_digitados_nao_digitados` (fonte `contr_execucao_leitura`)

Usuário autorizou explicitamente remover mesmo sabendo que quebraria código ("pode apagar o
código da api vai ser alterado tbm pra essas novas mudanças"). Antes de fazer a alteração,
levantado todo o uso real da coluna no código para não deixar a coleta automática ou as telas
quebradas com erro SQL (`column does not exist`) enquanto a nova lógica de progresso não é
definida:

- **`leituraUrbanaService.js`** (`calcularLeituraUrbana`) — roda a **cada ciclo de coleta**
  (chamado por `coletaCopelService.executarColetaCopel`, não só quando alguém abre uma tela).
  Se ficasse quebrado, a coleta automática inteira falharia a cada ciclo, não só a API.
  `digitados`/`nao_digitados` trocados por `0::int` fixo, com comentário explicando o motivo.
- **`atividadeColaboradoresService.js`** (`listarAtividadeHoje`) — `qtd_digitados_nao_digitados`
  removida do `SELECT`; `parseQtd(linha.qtd_digitados_nao_digitados)` trocado por
  `digitados = 0; naoDigitados = 0` direto.
- **`massivasService.js`** — 4 pontos usavam `condicaoQuantidade('c.qtd_digitados_nao_digitados')`/
  `condicaoQuantidadeNao(...)` (`contarFonteContr`, `obterFaixasDias`, `detalheContr`,
  `historicoContrLivro`), todos com o alias `c` = `contr_execucao_leitura`. Trocados por duas
  constantes novas, `CONTR_DIGITADOS_SQL`/`CONTR_NAO_DIGITADOS_SQL` (ambas `'0'`), documentadas
  no topo do arquivo. **Não tocado**: os pontos que usam `t.qtd_digitados_nao_digitados`
  (`contarTabela`, `detalheMassiva`, `historicoMassivaLivro`) — `t` ali é uma tabela de
  massiva (`pendentes_im`/`atribuidas_im`/`em_execucao_im`), que não muda nesta ADR.

Em `contarFonteContr` e `obterFaixasDias`, o `ORDER BY ... (${digitados} + ${naoDigitados})
ASC` que antes desempatava por "linha de menor quantidade restante" virou, na prática,
`ORDER BY c.livro, (0 + 0) ASC` — SQL válido, mas sem efeito de desempate real; trocado por
`ORDER BY c.livro, id ASC` em `contarFonteContr` (mais determinístico que uma constante).

### O que fica temporariamente zerado/incompleto

Com `digitados`/`nao_digitados` fixos em `0` para a fonte leitura/releitura:

- Coluna "Progresso" e "Executados/Pendentes" na tabela de Monitoramento de Livros mostram
  `0/0` / `0%` para todo livro de leitura/releitura.
- Contagem "leituras" nos cards de resumo (Pendentes/Atribuídas/Em Execução/faixas de dias)
  fica sempre `0`, embora a contagem de "livros" continue correta (`COUNT(*)` não depende da
  coluna removida).
- Percentual de execução e status parado/ativo do Trilho, para colaboradores de leitura/
  releitura, ficam sempre "0% executado hoje" — `digitados`/`naoDigitados` zerados em
  `listarAtividadeHoje` alimentam `percentualExecucao()`/`pontuacaoDestaque()` no FRONTEND.
  Massiva não é afetada (fonte separada).

Isso é esperado e temporário — fica assim até o usuário indicar de onde vêm as 7 colunas
novas e como a nova lógica de progresso deve ser calculada a partir delas.

## Adendo — coluna `smart`

Usuário pediu mais uma coluna: `smart` (`varchar(255)`, mesmo padrão das demais). Adicionada
com `ALTER TABLE public.contr_execucao_leitura ADD COLUMN smart character varying(255);`,
mesmo processo (como `postgres` dentro do `supabase-db`). Confirmada via
`information_schema.columns`.

Mesma situação das 7 colunas do Adendo original: não populada pelo scraper ainda (nenhum
código toca nela), origem/uso não especificados no pedido — fica pendente de instrução.

## Adendo 2 — scraping das 7 colunas novas: clique em cada OS abre uma tela por UC

Usuário indicou de onde vêm `uc`/`colaborador`/`codigo`/`equipamento`/`tipo_especificacao`/
`faturamento`/`leitura_atual` (as colunas que ficaram pendentes no Adendo original): a tabela
de livros de cada etapa (já raspada antes) tem, na coluna "número da OS", um link
(`<a href="javascript:update('ID','editarTarefasLeituraAction.do?acompanhamento=S')">...`)
que abre — confirmado com o usuário via pergunta direta — um **popup/nova aba** com uma
tabela por UC/medidor daquele livro (`#tabFixedHeader`).

### Mudança de arquitetura do scraper

Antes: 1 livro = 1 linha (`table#item`, extraída toda de uma vez via `page.evaluate` em
lote). Agora: 1 livro = N linhas, uma por UC — o cabeçalho (etapa/localidade/livro/
empreiteira/datas/situação/colaborador) vem da lista de livros e se repete em cada UC; o
detalhe (uc/codigo/equipamento/tipo_especificacao/faturamento/leitura_atual) vem da tabela
que abre ao clicar.

`copelScraperService.js` reescrito: para cada linha da tabela de livros da etapa, clica no
link da célula de índice 3 (contando o checkbox — mesma posição de `numero_os` no parser
antigo), captura o popup via `page.waitForEvent('popup')` em paralelo ao clique, extrai
`#tabFixedHeader` de dentro do popup, fecha o popup, e segue pro próximo livro sem precisar
de `goBack()` (usuário confirmou que a lista de livros continua intacta ao fundo). Cada
livro sem UC nenhuma ou com falha ao abrir a OS é logado e pulado (`try/catch` por livro),
sem travar o resto da etapa — dado o volume (uma etapa chegou a mostrar 274 livros no print
do usuário), uma falha isolada não pode derrubar a coleta inteira.

Índices confirmados contra o HTML real fornecido pelo usuário (`<table id="tabFixedHeader">`
completa, várias linhas de exemplo): `1`=UC, `2`=equip., `3`=tipo espec., `5`=faturar?,
`7`=leit. atual, `8`=mensagem 1 (`codigo`). As duas últimas são `<input readonly value="...">`
— o valor visível está no atributo `value`, não no `innerText` da célula (diferente das
outras, que são texto puro).

O scraper agora retorna um **array de objetos** (um por UC), não mais array de arrays
posicionais — `copelImportService.js` foi ajustado para não depender mais de
`CAMPOS_SCRAPER`/parse posicional: recebe os campos já nomeados e só aplica `limparEtapa()`
(igual antes) e uma função nova, `parseSituacaoColaborador()`, que separa a coluna crua
"Em Execução (CPO-NOME DO COLABORADOR)" em `situacao` (só a palavra) e `colaborador` (só o
nome, sem prefixo tipo "CPO-") — mesma regex de `SITUACAO_REGEX` já usada em
`atividadeColaboradoresService.js`. "Pendente" nunca tem colaborador (não bate no regex, cai
no fallback: `situacao` = texto bruto, `colaborador` = `null`).

### Batching do INSERT

Um livro pode gerar dezenas de linhas agora (uma por UC), então o volume por lote de coleta
cresceu bastante em relação a quando era uma linha por livro. Adicionado `LOTE_MAX_LINHAS =
300` em `copelImportService.js` — o `INSERT` é dividido em lotes de até 300 linhas para não
estourar o limite de 65535 parâmetros por query do Postgres (15 colunas × linha).

### Verificação

Testado `importarParaPostgres` isoladamente com 2 registros mockados (2 UCs do mesmo livro,
dados baseados no print e no HTML reais fornecidos pelo usuário) — dentro de uma transação
com rollback, sem persistir dado de teste. Resultado bateu exatamente: `etapa` limpo para
`'17'`, `situacao` = `'Em Execução'`, `colaborador` = `'WELTON RICARDO VEIGA VIEIRA'` (prefixo
"CPO-" removido corretamente), `uc`/`codigo`/`equipamento`/`tipo_especificacao`/`faturamento`/
`leitura_atual` todos corretos. `npm test` (12 testes de isolamento de tenant) continua
passando.

**Não testado ao vivo contra o portal Copel real** nesta sessão — a extração em si
(`coletarDadosAcompanhamento`, o clique real no link e a leitura do popup) só roda de fato no
próximo ciclo do job de coleta automática (`coletaJob.js`, dentro da janela 07h–19h) ou numa
execução manual deliberada; não foi disparada aqui para não gerar carga extra e repetida no
sistema de terceiros fora do ciclo já agendado. Vale acompanhar os logs do primeiro ciclo real
após esta mudança (`[Coleta Acomp] ✅ Etapa 'X': N/M livros com OS aberta, T UCs coletadas`) —
se o popup não abrir como esperado, ou os índices de coluna estiverem errados, essa linha vai
mostrar `0 UCs` mesmo com livros presentes, ou os logs de erro por livro (`⚠️ Falha ao abrir
OS...`) vão aparecer em volume.

### Correção pós-primeiro-ciclo-real: popup nunca abre, era "mesma página"

O primeiro ciclo automático depois desta mudança rodou contra o portal real e confirmou
exatamente o cenário de risco acima: `Etapa 'ETAPA 15 - (6)': 0/6 livros com OS aberta, 0 UCs
coletadas`, com `⚠️ Falha ao abrir OS do livro '021674'... Timeout 15000ms exceeded while
waiting for event "popup"` repetido nos 6 livros. O clique acontecia (sem erro no `.click()`
em si), mas o evento `popup` do Playwright nunca disparava — sinal de que a "nova tela" que o
usuário via na prática é um modal/iframe carregado via AJAX **na mesma página** (padrão comum
em telas Struts como esta, apesar da resposta anterior do usuário ter descrito como popup/
nova aba), não uma janela de verdade.

Corrigido para cobrir os dois casos ao mesmo tempo: dispara `page.waitForEvent('popup', {timeout:
10000})` e `page.waitForSelector('#tabFixedHeader', {timeout: 10000, state: 'visible'})` em
paralelo, e usa `Promise.any` (não `Promise.race`) — resolve assim que **qualquer uma** tiver
sucesso, só rejeita se as duas falharem (com `Promise.race`, a que expira primeiro derrubaria
a tentativa mesmo que a outra estivesse a caminho de funcionar). Se veio de `#tabFixedHeader`
na mesma página, extrai de `page` em vez de `popup`, e faz `page.goBack()` depois (o caso
popup só fecha a popup, sem precisar voltar). Se nenhuma das duas vier, salva um diagnóstico
(screenshot + texto — `salvarDiagnostico`, já existente para falha de login) **só na primeira
falha da execução inteira**, não uma captura por livro, para não gerar centenas de arquivos se
o problema for sistêmico.

Não validado ao vivo de novo depois desta correção — fica para o próximo ciclo automático.
Se o diagnóstico salvo em `BACKEND/diagnosticos/acomp_os_<livro>_falhou_*.png/.txt` mostrar
algo diferente do esperado (ex.: nem popup nem `#tabFixedHeader` — talvez a função `update()`
dependa de outro estado, ou o índice da célula do link esteja errado), é o próximo ponto a
investigar.

### Correção 2 pós-segundo-ciclo-real: `#tabFixedHeader` estava lendo a tabela errada, e/ou cedo demais

Usuário reportou (segundo ciclo real, já com a correção acima): etapa 29 tinha 3 livros, um
deles com mais de 200 UCs reais, mas o banco só ficou com **3 registros no total** — ou seja,
exatamente 1 registro por livro, não uma UC de cada. A hipótese "só segue pra próxima etapa
depois de terminar a atual" foi descartada por inspeção do código: o `for` que percorre
`totalLivros` já roda por completo antes de `etapaIndex++` — isso nunca foi o problema; o
problema estava dentro da extração de cada livro.

Causa mais provável: usar `#tabFixedHeader` como sinal de "a mesma página mudou de fato" era
frágil demais. Esse id pertence a um plugin JS genérico de tabela com cabeçalho fixo (classe
CSS `fixedheader fht-table`, vista no HTML fornecido pelo usuário) — plausivelmente
reaproveitado em mais de uma tela do sistema, possivelmente até na própria lista de livros
(que também tem centenas de linhas e se beneficiaria de cabeçalho fixo ao rolar). Se for esse
o caso, `page.waitForSelector('#tabFixedHeader', {state:'visible'})` podia resolver quase
instantaneamente após o clique — **antes** da navegação real acontecer, ou contra a tabela
errada — explicando por que a extração pegava só 1 linha (ou a linha errada) por livro. Uma
segunda causa, complementar e também plausível, é a tabela popular linhas de forma
assíncrona/incremental depois do elemento já existir no DOM — extrair cedo demais pegaria só
a 1ª linha mesmo com o seletor certo.

Corrigido nas duas frentes:

1. **Sinal de "mudou de tela" mais específico**: trocado `#tabFixedHeader` por
   `page.getByText('DADOS DE EXECUÇÃO', { exact: false }).first().waitFor({state:'visible'})`
   — esse texto é o cabeçalho da segunda seção da tela de detalhe da OS (visto no print do
   usuário: "📁 DADOS DE EXECUÇÃO", com os campos leiturista/data de leitura logo abaixo),
   improvável de existir na lista de livros. `#tabFixedHeader` continua sendo usado só depois
   de já ter certeza (via popup ou via esse texto) de que a tela certa carregou — nesse ponto,
   `page.waitForSelector('#tabFixedHeader', ...)` é seguro porque já se sabe que a tabela
   presente é a de UCs, não outra.
2. **Espera a tabela estabilizar antes de extrair**: `aguardarTabelaEstabilizar()` (nova,
   `copelScraperService.js`) — poll a cada 500ms (até 10s) contando `#tabFixedHeader tbody tr`,
   só retorna quando a contagem para de crescer entre duas checagens consecutivas. Cobre o
   caso de a tabela ser montada incrementalmente via JS.

Também adicionado um `console.warn` por livro que abre a OS mas extrai 0 UCs (antes só o
total agregado por etapa aparecia no log, dificultando saber qual livro específico falhou
silenciosamente).

**Validado ao vivo depois desta correção**: usuário pediu pra apagar os 879 registros
incompletos (produto da versão com o bug do `#tabFixedHeader`) — `TRUNCATE` rodado, tabela
zerada. Acompanhado o ciclo seguinte direto pelo banco (contagem de linhas por livro, sem
depender dos logs do terminal do usuário): distribuição de UCs por livro passou a variar de
verdade — `2` a `257` UCs no mesmo lote (`018405`→99, `019362`→70, `042154`→257, etc.), contra
o `1` fixo de antes. Confirma que a extração está pegando a tabela certa e completa.

## Adendo 3 — Chromium visível para debug (`COPEL_HEADLESS`)

Usuário pediu para poder ver o navegador rodando ao vivo durante a coleta, pra identificar
visualmente qualquer problema futuro sem depender só de logs/diagnóstico. Adicionada
`COPEL_HEADLESS` (`.env`) — `false` abre o Chromium com janela (`headless: false`,
`slowMo: 300` em vez de `100`, mais fácil de acompanhar); default `true` (sem janela), que é
o comportamento certo em produção já que o job roda sozinho o dia inteiro dentro da janela
07h–19h — uma janela de navegador abrindo repetidamente sem necessidade seria desperdício de
recursos gráficos. `.env.example` documentado; `.env` real do usuário já ativado
(`COPEL_HEADLESS=false`) para a próxima investigação.

## Adendo 4 — correção da causa raiz real: só processava o 1º livro de cada etapa

A "validação" registrada no fim da Correção 2 (UCs variando `2` a `257` no mesmo lote)
**estava mal interpretada** — não era uma coleta completa de um único ciclo, era a soma de
vários ciclos diferentes, cada um processando só o primeiro livro de cada etapa antes de
pular pra próxima (o job de coleta reinicia do zero — login incluso — a cada novo ciclo).

Confirmado ao vivo por dois caminhos: 1) usuário reiniciou o backend com `COPEL_HEADLESS=false`
e observou visualmente o navegador abrindo a etapa seguinte sem terminar a anterior, e
reabrindo o **mesmo** "número da OS" ao clicar de novo; 2) os logs reais bateram exatamente
com isso — `1/76 livros`, `1/259 livros`, `1/376 livros`, `1/546 livros`, `1/432 livros`
etc., **sem nenhum** log de `⚠️ Falha ao abrir OS` para os demais. A ausência total desses
logs de erro foi o sinal decisivo: se fosse timeout/exceção capturada, cada livro pulado
teria gerado uma linha de log; como não gerou nenhuma, o resto do loop estava caindo num
`continue` silencioso, rápido demais pra serem tentativas reais de clique.

### Causa raiz

`page.goBack()` (usado pra fechar a tela de detalhe quando abria na mesma página, ver
Correção 2) **não restaura o estado JS/AJAX da lista de livros da etapa** (filtro e
paginação aplicados via AJAX pelo site, não por navegação de URL). Depois do primeiro livro
processado dessa forma, a lista ficava num estado inconsistente — o locator reaproveitado
(`linhasEtapa`, criado uma vez fora do loop) continuava apontando pra posições que agora
tinham células vazias ou dados diferentes, e a checagem `if (!Object.values(cabecalho)...)
continue` (linha então numerada 167) descartava silenciosamente todo o resto da etapa, item
por item, sem nenhuma chamada de rede real — daí a impressão de "fecha muito rápido" que o
usuário relatou visualmente.

### Correção

Duas mudanças complementares em `copelScraperService.js`:

1. **`goBack()` trocado por clicar em "CANCELAR"** (`fecharTelaDetalheMesmaPagina`) — o
   mecanismo que o próprio site oferece pra fechar a tela de detalhe, que devolve a lista de
   livros no estado JS correto (em vez de depender do histórico do navegador). Fallback pra
   `goBack()` só se o botão não for encontrado.
2. **Loop de livros reescrito para não depender de índice de posição.** Antes: `for (let i =
   0; i < totalLivros; i++)` sobre um locator capturado uma única vez no início da etapa —
   frágil, porque a posição `i` só é confiável se a lista nunca mudar de ordem/conteúdo entre
   uma leitura e outra (não é o caso aqui). Agora: um `while(true)` que **relê a lista do
   zero a cada livro** (`page.locator('table#item:visible tbody tr')`, nova consulta), varre
   as linhas procurando a primeira cujo **número do livro** ainda não esteja no `Set`
   `livrosProcessados`, processa essa, marca como processada, e repete — até não sobrar
   nenhum livro pendente na lista atual. O número do livro (não a posição) é a única
   identidade confiável entre re-leituras. Trava de segurança (`limiteLivros =
   totalLivrosInicial + 50`) evita loop infinito se a lista nunca convergir.
3. **Removidos os tempos fixos de espera** (`page.waitForTimeout(8000)` depois de abrir uma
   etapa, `2000` antes do loop de etapas e depois de fechar uma, `1000` depois de cancelar) —
   trocados por esperas de carregamento reais: `page.waitForSelector(...)` pro elemento que
   precisa existir, mais `page.waitForLoadState('networkidle', ...)` pra esperar o AJAX da
   ação realmente terminar, em vez de assumir um tempo arbitrário. Usuário pediu
   explicitamente essa mudança ("os tempo não são predefinidos, é esperar a página
   carregar").

Não validado ao vivo de novo depois desta correção (usuário pediu pra parar a execução em
andamento antes de eu poder acompanhar um ciclo completo) — fica pra próxima execução.
`npm test` (12 testes) continua passando.

## Adendo 5 — causa raiz real: `#item` é um id repetido, uma tabela por etapa

A Correção do Adendo 4 reduziu o sintoma (de "1/76, 1/259..." pra "1/1" — o `while` interno
processava exatamente 1 livro e saía limpo, sem log de erro), mas o problema de fundo
continuava: só 1 livro por etapa. Usuário reiniciou o backend com `COPEL_HEADLESS=false`,
observou visualmente e mandou um print da tabela `#item` **real**, que revelou a causa:
cada etapa expandida (clique em "ETAPA N - (M)") mostra sua própria tabela de livros logo
abaixo do cabeçalho, e **todas essas tabelas ficam empilhadas na mesma página com o mesmo
`id="item"`** (etapa 15 e etapa 16 visíveis ao mesmo tempo no print, cada uma com sua
própria `<table id="item">`).

Isso é HTML tecnicamente inválido (id deveria ser único), mas o navegador tolera — e um
seletor CSS `#item` **sempre resolve pra primeira ocorrência no documento**. Depois de
processar a etapa 15 e abrir a etapa 16, todo `page.locator('table#item:visible tbody
tr')`/`page.waitForSelector('table#item:visible', ...)` continuava mirando na tabela da
etapa 15 (a primeira do DOM) — o que também explica o "1/1" da correção anterior: o código
processava (com sucesso, sem erro) o único livro da etapa 15 que ainda não estava no
`livrosProcessados`, mesmo pensando estar na etapa 16, e depois via a lista "esgotada"
(todos os livros da 15 já marcados) mesmo a etapa 16 ter centenas de livros nunca tocados.
Usuário confirmou exatamente isso: "abriu a etapa seguinte sem nem ter terminado a
anterior... quando clicou de novo na etapa atual clicou no mesmo número os novamente".

O print também confirmou o índice usado para o link "número da OS" (célula 3, contando o
checkbox) — isso já estava certo; o problema nunca foi ali.

### Correção

Nova função `tabelaDaEtapa(etapaLink)`, que usa XPath relativo ao link da etapa —
`etapaLink.locator('xpath=following::table[@id="item"][1]')` — a **primeira** tabela
`#item` que aparece **depois** do link daquela etapa específica no documento, em vez de um
seletor `#item` global. Essa referência (`tabelaAtual`) é capturada uma vez ao abrir a etapa
e reutilizada em todo o processamento dela: contagem inicial de livros, releitura do loop
`while`, espera de carregamento, e a lógica de "reabrir se a lista sumir" (Adendo 4) — que
provavelmente nunca vai mais disparar na prática (não era o problema real), mas fica como
salvaguarda. `fecharTelaDetalheMesmaPagina` passou a receber `tabelaAtual` como parâmetro
pelo mesmo motivo, em vez de esperar por qualquer `#item` visível na página.

Não validado ao vivo de novo — fica pra próxima execução. `npm test` (12 testes) continua
passando.

## Adendo 6 — crash real: unhandled rejection no `Promise.any` de popup/mesma página

Usuário rodou o backend no próprio terminal (pra ver a janela do Chromium de verdade — meu
processo, iniciado por outra via, não roda na sessão gráfica dele, então a janela nunca
aparecia; ver nota de comunicação abaixo) e o processo **crashou** de verdade — não uma
falha tratada, um `nodemon: app crashed`:

```
page.waitForEvent: Timeout 10000ms exceeded while waiting for event "popup"
...
Node.js v24.14.1
[nodemon] app crashed - waiting for file changes before starting...
```

### Causa raiz

`promPopup`/`promMesmaPagina` (Adendo 4/5) eram criadas **antes** de `await linkOs.click()`
— necessário para `waitForEvent('popup')` (que precisa estar escutando antes do clique, ou
perde o evento se o popup abrir rápido demais). O problema: se o `click()` demorasse mais
que os 10s de timeout de qualquer uma das duas, ela **rejeitava sozinha enquanto o código
ainda estava no `await linkOs.click()`**, antes do `Promise.any` (só chamado depois do
click) ter qualquer handler anexado — o V8 marca isso como *unhandled rejection*, que em
Node é fatal por padrão (derruba o processo).

Um `.catch(() => {})` preventivo só na promise original (tentativa anterior, mesmo commit
anterior) **não bastou** — confirmado com um teste isolado (fora do projeto, script
descartável): o V8 trata cada nível derivado da cadeia (`.then()`, e o resultado do
`Promise.any` em si) como uma promise própria, e qualquer uma delas rejeitando sem handler
anexado a tempo dispara o mesmo problema, independente de a promise-mãe já estar "tratada".

### Correção

`.catch(() => {})` preventivo adicionado em **todos** os níveis da cadeia: `promPopup`,
`promMesmaPagina` (originais), `esperaPopup`, `esperaMesmaPagina` (derivadas do `.then()`),
e `combinada` (o `Promise.any([...])` em si) — cada um logo após ser criado, antes de
qualquer `await`. A referência real usada no fluxo (`combinada`, consumida via `await
combinada` depois do clique) continua funcionando normalmente; os `.catch()` extras só
"drenam" a rejeição pros handlers descartados, sem afetar o resultado usado.

Validado com um teste isolado reproduzindo exatamente o cenário (duas promises com timeout
curto, um "clique" mais lento que o timeout, antes/depois da correção) — sem a correção,
`unhandledRejection` dispara sempre; com ela, o `catch` normal do código captura
corretamente em ambos os casos (falha total das duas, ou sucesso de uma). Testado também o
caminho de sucesso (uma das duas resolve antes da outra rejeitar) pra garantir que a
correção não mudou o comportamento funcional, só eliminou o crash.

### Nota — por que a janela do Chromium não aparecia

Antes deste crash, o usuário reportou "não abriu a página pra eu ver" quando eu reiniciei o
backend pela minha própria ferramenta (mesmo com `COPEL_HEADLESS=false` no `.env`). Causa:
meu processo não roda na mesma sessão gráfica interativa do desktop do usuário — `headless:
false` abre uma janela real do SO, mas ela só é visível em quem está na sessão onde o
processo roda. Rodar `npm run dev` diretamente no terminal do próprio usuário (não pela
minha ferramenta) é o que permite a janela aparecer pra ele — foi assim que ele conseguiu
ver o comportamento real que levou às correções deste Adendo e dos anteriores.

`npm test` (12 testes) continua passando. Não validado ao vivo de novo contra o portal real
depois desta correção — fica pra próxima execução do usuário.

## Adendo 7 — a correção do Adendo 6 já funcionou; achado um segundo bug (etapa recolhe sozinha)

Usuário rodou `npm run dev` no próprio terminal de novo — **confirmado que o crash do
Adendo 6 não aconteceu mais**: o erro apareceu como `⚠️ Falha ao abrir OS do livro
'021676'... locator.click: Timeout 30000ms exceeded` capturado normalmente pelo `catch`,
sem derrubar o processo; a coleta seguiu para a etapa seguinte normalmente.

O erro em si, porém, revelou outra causa real: `locator.click` ficou 30s tentando (Playwright
já tenta scroll/espera automática antes de clicar) porque o elemento **existe no DOM mas
está invisível**. O diagnóstico salvo automaticamente (`salvarDiagnostico`, já existente)
capturou um screenshot da tela exata no momento da falha — mostrando a **etapa inteira
recolhida** (só o cabeçalho "ETAPA 15 - (2)" visível, sem a tabela de livros abaixo), não
uma "lista vazia" como a checagem do Adendo 4/5 pressupunha.

### Por que a checagem anterior não pegava isso

A lógica de recuperação anterior (`totalAtual === 0`) checava a **contagem** de `tbody tr`
— mas quando a etapa recolhe, a linha do livro pendente ainda existe no DOM (só fica
`display:none` ou equivalente via CSS), então `count()` não é zero e a checagem nunca
disparava. Só verificar **visibilidade** da tabela (`tabelaAtual.isVisible()`) detecta esse
caso.

### Correção

Nova função `garantirEtapaVisivel()`, chamada no **início de cada volta** do loop `while`
(antes de procurar o próximo livro pendente, não só quando a busca já falhou) — se
`tabelaAtual.isVisible()` for `false`, re-clica em `etapaLink` até 3 vezes, aguardando
carregamento entre tentativas. Substitui a lógica anterior (que só reagia depois de já não
achar nenhuma linha válida, e usava contagem em vez de visibilidade).

Não validado ao vivo de novo — fica pra próxima execução do usuário. `npm test` (12 testes)
continua passando.

## Adendo 8 — confirmado funcionando; logs melhorados (parecia travado, não estava)

Usuário rodou de novo: a etapa 15 (2 livros) processou **2/2 com sucesso, 14 UCs** — a
correção do Adendo 7 funcionou. Na etapa 16 (66 livros), porém, o log mostrou a mensagem
"tabela não está visível... reabrindo" **repetida a cada livro** (1/66, 2/66, 3/66...),
sempre resolvendo na 1ª tentativa — comportamento esperado (o site recolhe a etapa a cada
`CANCELAR`, confirmado no Adendo 7), mas sem nenhuma confirmação de sucesso entre um aviso e
outro. Usuário reportou: "visualmente estava abrindo corretamente... mas pelo console parece
que não estava coletando" — o código estava funcionando, só a falta de log por livro dava
essa impressão numa etapa de dezenas/centenas de livros (só havia 1 linha de resumo no
**final** da etapa inteira).

Duas melhorias em `copelScraperService.js`, sem mudar comportamento:

1. Log por livro processado com sucesso — `📖 Livro 'X' — N UCs (M/Total da etapa 'Y')` —
   logo após incrementar `livrosComUc`/`totalUcs`.
2. A mensagem de "reabrindo a etapa" trocada de `console.warn` (⚠️) para `console.log` (🔄),
   com texto explicando que é comportamento normal do site — antes soava como uma falha
   repetida, quando na prática é esperado a cada livro.

`npm test` (12 testes) continua passando.

## Adendo 9 — `waitForLoadState('networkidle')` estava atrasando à toa

Usuário reportou (mesma sessão de teste): "a página nitidamente já carregou e ainda fica
esperando um tempo a mais desnecessário... assim que entra na aba acompanhamento e assim
que volta pra ela depois de coletar as ucs" — ambos os pontos exatos onde o Adendo 4
(remoção dos `waitForTimeout` fixos) tinha adicionado `page.waitForLoadState('networkidle',
{timeout: N})` **depois** de já esperar o elemento certo (`waitForSelector`/`waitFor`)
ficar visível.

`networkidle` só resolve quando não há nenhuma requisição de rede por um período — se o
portal tiver qualquer atividade de fundo (polling, heartbeat, analytics) que nunca some de
verdade, essa espera nunca resolve antes do próprio *timeout*, e como estava com `.catch(()
=> {})`, o código ficava preso o tempo **inteiro** do timeout (15s, 20s) mesmo com a página
já pronta e o elemento relevante já visível havia tempo. Um sinal mais específico
(visibilidade do elemento que realmente importa) já estava sendo usado em paralelo e é
suficiente por si só — o `networkidle` era estritamente redundante em todo lugar onde
aparecia.

Removidas as 5 ocorrências de `waitForLoadState('networkidle', ...)` em
`copelScraperService.js`: depois do login/busca inicial, depois de abrir uma etapa, dentro
de `garantirEtapaVisivel()` (Adendo 7), dentro de `fecharTelaDetalheMesmaPagina()`, e no
fim do loop de etapas (esse último nem tinha um `waitFor` de elemento antes — a próxima
volta do loop externo já espera a tabela da etapa seguinte). Em todos os casos o
`waitForSelector`/`waitFor({state:'visible'})` que já existia continua como único sinal de
"pronto pra continuar".

`npm test` (12 testes) continua passando. Não validado ao vivo de novo — fica pra próxima
execução do usuário.

## Adendo 10 — a mesma limpeza tinha ficado de fora do scraper de Massivas

Usuário reportou de novo, em ciclo posterior, "a página está nitidamente carregada mas
ainda fica um tempo desnecessário parado" — dessa vez não no scraper de Acompanhamento (já
limpo nos Adendos 4 e 9), mas em `copelMassivasScraperService.js`, que nunca tinha passado
por essa limpeza: 13 `waitForTimeout` fixos (login, troca de aba, cascata de selects de
filtro dependentes, pós-busca), somando mais de 30s de espera garantida por ciclo completo,
independente de quão rápido o portal realmente respondesse.

Cada um foi trocado pela condição real que ele deveria estar esperando:

- **Cascata de filtros** (`selectOption` de concessionária → empreiteira → tipo de tarefa,
  cada select popula as `<option>` do próximo via AJAX): `aguardarOpcao()` faz
  `page.waitForFunction` até a `<option>` que será escolhida existir no select seguinte, em
  vez de um tempo fixo que ou sobrava (formulário já pronto) ou faltava (AJAX mais lento que
  o normal).
- **Pós-login**: o `waitForTimeout(3000)` depois do `goto` era redundante — `page.fill()` já
  auto-espera o campo existir e ficar acionável. O `waitForTimeout(8000)` depois do clique em
  submit também era redundante — o código já tinha, logo depois, um
  `waitForSelector("a[href='pendentesAction.do']")` real (com diagnóstico automático se
  falhar), que é a espera de "login concluído" de verdade.
- **Troca de aba** (pendentes/atribuídas/em execução): `aguardarFormularioFiltros()` espera o
  select de concessionária ficar visível, em vez de tempo fixo depois do `goto`.
- **Pós-busca**: `aguardarEstabilizar()` faz poll na contagem de linhas da tabela até
  estabilizar (2 leituras iguais seguidas) — mesmo padrão do `aguardarTabelaEstabilizar()` já
  usado no scraper de Acompanhamento, adaptado aqui pros dois formatos de tabela (`table#item`
  direto, ou aninhada dentro de cada bloco `table.tableQuebraEquipe` por leiturista).

Restam só 2 `waitForTimeout` no arquivo: o próprio intervalo de poll dentro de
`aguardarEstabilizar()` (parte do mecanismo, não uma espera arbitrária) e o intervalo entre
tentativas de busca em `buscarComTentativas()` (retry backoff — não é espera de
carregamento, é folga proposital entre uma tentativa e outra).

`npm test` (12 testes) continua passando. Não validado ao vivo nesta sessão — fica pra
próxima execução do usuário.

## Adendo 11 — a demora real estava no Acompanhamento: 15s mortos por livro, contradizendo o próprio Adendo 7

Usuário corrigiu o alvo: o scraper de Massivas (Adendo 10) já estava bom — quem continuava
"com a página nitidamente carregada mas ainda parado" era o de Acompanhamento.

Revisão completa de `copelScraperService.js` não achou mais nenhum `waitForTimeout` fixo nem
`waitForLoadState('networkidle')` (já removidos nos Adendos 4 e 9). A causa real era outra:
uma contradição entre dois pontos do próprio código. O Adendo 7 tinha confirmado, com
diagnóstico real (screenshot), que depois de clicar "CANCELAR" a etapa quase sempre volta
**recolhida sozinha** — só reaparece quando alguém reclica no link da etapa, nunca por conta
própria. Mas `fecharTelaDetalheMesmaPagina()` (a função que clica em CANCELAR) continuava
terminando com `tabelaAtual.waitFor({state:'visible', timeout:15000}).catch(() => {})` —
esperando exatamente a coisa que o Adendo 7 já tinha provado não acontecer sozinha. Como o
erro era engolido por um `.catch` silencioso, isso nunca aparecia como falha no log: era só
um buraco de até 15s de nada, repetido a cada livro processado via "mesma página" (o caso
mais comum, segundo o Adendo 2) — numa etapa com 66 livros, mais de dez minutos perdidos
sem nenhum sinal de erro.

A responsabilidade de reabrir a etapa e esperar ativamente já existia e já era a certa:
`garantirEtapaVisivel()`, chamada no início de cada volta do loop de livros (Adendo 7), que
checa visibilidade e reclica em `etapaLink` se preciso. `fecharTelaDetalheMesmaPagina()`
não precisa (e não deve) tentar adivinhar se a tabela vai reaparecer sozinha — só clica em
CANCELAR e segue; quem garante o resto é a próxima chamada de `garantirEtapaVisivel()`, que
já fazia isso de forma ativa (reclicando), não passiva (esperando acontecer).

Removido o `waitFor` de dentro de `fecharTelaDetalheMesmaPagina()` (que também deixou de
receber o parâmetro `tabelaAtual`, agora sem uso). Nenhuma mudança de comportamento
funcional — só elimina uma espera que nunca resolvia de verdade.

`npm test` (12 testes) continua passando. Não validado ao vivo nesta sessão — fica pra
próxima execução do usuário.

## Adendo 12 — erro fatal numa etapa derrubava a coleta inteira, perdendo as etapas seguintes

Usuário colou log real: na ETAPA 18 (187 livros), depois de coletar 7 livros com sucesso, o
livro seguinte falhou com `All promises were rejected` (nem popup nem "DADOS DE EXECUÇÃO"
apareceram dentro do timeout de 10s). Na sequência, 3 tentativas de reabrir a etapa
fracassaram, a etapa encerrou com só 8/187 livros processados, e o clique de recolher a
etapa (fim do loop) deu `Timeout 30000ms exceeded` esperando `a.color:has-text("ETAPA")`. Sem
nenhum try/catch no nível da etapa, esse erro propagou e derrubou `coletarDadosAcompanhamento`
inteira — o ciclo inteiro reiniciou do zero, perdendo inclusive etapas que ainda nem tinham
sido tentadas.

### Duas causas encadeadas

1. **"All promises were rejected" deixava a tela de detalhe aberta sem ninguém fechar.** O
   `finally` do try/catch de cada livro só fecha a tela se `popup` ou `usouMesmaPagina`
   estiverem marcados — mas quando AMBAS as esperas (popup e "DADOS DE EXECUÇÃO") estouram o
   timeout, nenhuma das duas é marcada, mesmo que o clique tenha disparado a navegação de
   verdade e ela só tenha completado *depois* do timeout (rede lenta). A etapa ficava presa
   numa tela de detalhe que ninguém sabia que existia, e as tentativas seguintes de "reabrir
   a etapa" fracassavam porque a página real não era mais a lista de livros.
2. **Nenhum try/catch protegia o processamento de uma etapa inteira.** Um erro fatal em
   qualquer ponto — incluindo o próprio clique de recolher a etapa no final — propagava até
   o topo da função e abortava a coleta inteira, mesmo que as etapas seguintes fossem
   processar normalmente se tentadas.

### Correções

- Timeout de espera por popup/"DADOS DE EXECUÇÃO" aumentado de 10s para 20s — reduz falsos
  negativos por lentidão momentânea do portal.
- No `catch` de falha ao abrir OS, checagem ativa: se nem popup nem "mesma página" foram
  detectados dentro do timeout, verifica se a tela de detalhe apareceu tarde (`isVisible()`
  no texto "DADOS DE EXECUÇÃO") e, se sim, marca `usouMesmaPagina = true` — o `finally` já
  existente então fecha a tela normalmente, evitando que a etapa fique presa.
- Todo o processamento de uma etapa (abertura, loop de livros, recolhimento) agora está
  dentro de um try/catch de nível de etapa. Se algo falhar de forma irrecuperável, loga um
  erro claro, salva diagnóstico (flag própria `diagnosticoEtapaSalvo`, separada de
  `diagnosticoOsSalvo` — categorias diferentes de falha, uma não deve impedir a outra de
  gerar screenshot) e segue para a próxima etapa em vez de abortar a função inteira.
  `etapasProcessadas.add(etapa)` e `etapaIndex++` ficam fora do try/catch — rodam sempre,
  sucesso ou falha, pra nunca ficar preso reprocessando a mesma etapa quebrada.

`npm test` (12 testes) continua passando. Não validado ao vivo nesta sessão — fica pra
próxima execução do usuário.

## Adendo 13 — a coleta parava cedo: lista de etapas carrega aos poucos conforme rola a página

Usuário reportou: a coleta terminou "com sucesso" na ETAPA 18 (`✅ Extração concluída`, dados
inseridos no banco), mas "ainda tinham muitas outras" etapas que nunca foram nem tentadas.

Confirmado com o usuário: a lista de etapas não é paginada nem tem botão "carregar mais" —
todas já estão disponíveis, mas só aparecem no DOM conforme a página rola pra baixo (mesmo
processo manual de antes do scraper existir, quando ele mesmo rolava a tela pra encontrar as
etapas seguintes). `page.locator('a.color:has-text("ETAPA")').count()` só enxerga o que já
foi renderizado — o loop `while (etapaIndex >= count) break` estava contando como "acabou"
assim que esgotava a primeira leva renderizada, sem nunca ter rolado a página pra revelar o
resto.

Nova função `aguardarTodasEtapasCarregadas(page)`: rola a página até o fim em passos
(`window.scrollTo(0, document.body.scrollHeight)`), medindo a contagem de links "ETAPA" a
cada passo — para quando a contagem estabiliza (2 leituras iguais seguidas), não por um
número de rolagens fixo. Chamada em dois pontos: uma vez no setup inicial (logo após a busca,
antes de começar a processar a primeira etapa) e, principalmente, sempre que o loop parece
ter chegado ao fim (`etapaIndex >= count`) — só decide que acabou de verdade depois de
confirmar que rolar até o fim não revela nenhuma etapa nova.

`npm test` (12 testes) continua passando. Não validado ao vivo nesta sessão — fica pra
próxima execução do usuário.

## Adendo 14 — `ORDER BY ... id` ambíguo derrubava o resumo de Massivas durante a coleta

Erro real no log de produção, capturado enquanto a coleta corrigida (Adendo 13) rodava:

```
❌ Erro ao obter resumo de massivas: error: column reference "id" is ambiguous
    at contarFonteContr (massivasService.js:334:29)
```

`contarFonteContr()` faz `SELECT DISTINCT ON (c.livro) ... FROM contr_execucao_leitura c LEFT
JOIN cidades_localidades cl ... [+ joinCalendarioContr(), que junta calendario_leitura cal]`
terminando com `ORDER BY c.livro, id ASC` — três tabelas no JOIN (`c`, `cl`, `cal`), todas
com coluna `id` (padrão bigserial de toda tabela do projeto), e o `id` do `ORDER BY` sem
qualificar por alias. Postgres não consegue decidir de qual tabela é — erro `42702`. As duas
outras queries do arquivo com a mesma forma (`obterFaixasDias`, `historicoContrLivro`) já
ordenavam por uma expressão calculada, não por `id` puro, então não sofriam disso.

Corrigido qualificando: `ORDER BY c.livro, c.id ASC`. Validado direto no banco local com os
mesmos LEFT JOINs da query real. `npm test` (12 testes) continua passando.

## Adendo 15 — Monitoramento de Livros adaptado para "1 linha por UC": Realizados/Não realizados, cards de agentes, e 4 pedidos de UC-por-UC

Com o scraper já reestruturado (Adendo 2 em diante) e a fila por livro (ADR 0020) validada ao
vivo, `contr_execucao_leitura` passou definitivamente a ter N linhas por livro (uma por UC), e
o código de leitura dessas telas — que tinha ficado com `digitados`/`nao_digitados` zerados de
propósito (ver "O que fica temporariamente zerado/incompleto" acima) — foi atualizado com as 6
regras de negócio que o usuário definiu.

### As 6 regras

1. Mesma lógica de agregação de antes, agora agrupando por `livro` (uma UC deixou de ser "a
   linha", o livro voltou a ser a unidade).
2. `situacao` guarda só o status; `colaborador` (coluna separada, já existente desde o Adendo 2)
   é o executor — vazio quando não há.
3. Prazo regulatório mantém a mesma lógica, só reagrupando por `livro`.
4. "Executados/Pendentes" → "Realizados/Não realizados": `codigo IS NOT NULL` = realizada,
   `codigo IS NULL` = não realizada.
5. "Progresso" usa a mesma fórmula, com os termos novos: `realizados / (realizados +
   não_realizados) * 100`.
6. `colaborador` alimenta tanto os cards "Agentes em campo" quanto os totais de
   realizadas/não-realizadas do progresso.

### Implementação

- **`massivasService.js`**: `LEITURISTA_CONTR_SQL` trocado de um `regexp_replace` (tentava
  extrair nome de dentro de `situacao`, que não existe mais ali) para referência direta a
  `c.colaborador`. As antigas `CONTR_DIGITADOS_SQL`/`CONTR_NAO_DIGITADOS_SQL` (`'0'` fixo)
  viraram 4 constantes: duas "cruas" por linha/UC (`CONTR_REALIZADO_LINHA_SQL`/
  `CONTR_NAO_REALIZADO_LINHA_SQL`, `CASE WHEN c.codigo IS NOT NULL/IS NULL THEN 1 ELSE 0 END`)
  e duas agregadas por livro via window function (`CONTR_REALIZADO_LIVRO_SQL`/
  `CONTR_NAO_REALIZADO_LIVRO_SQL`, `SUM(...) OVER (PARTITION BY c.livro)`) — pares separados
  porque `contarFonteContr`/`obterFaixasDias`/`detalheContr` usam `SELECT DISTINCT ON
  (c.livro)` (precisam da versão-janela, que enxerga todas as UCs do livro mesmo colapsando
  pra 1 linha), enquanto `historicoContrLivro` já tem um `GROUP BY` real (precisa da versão
  crua, senão aninha agregação dentro de window function — erro de sintaxe do Postgres).
- **`atividadeColaboradoresService.js`** (`listarAtividadeHoje`, alimenta os cards "Agentes em
  campo"/"Progresso de atividades"): removido `SITUACAO_REGEX` (a extração de nome que ele
  fazia não tem mais sentido — `colaborador` já vem limpo); query reescrita com `GROUP BY
  livro, etapa, situacao, colaborador, ...` e `SUM(CASE WHEN codigo IS NOT NULL/IS NULL ...)`
  reais; linha sem `colaborador` é ignorada (livro "Pendente", sem executor).
- **`leituraUrbanaService.js`** (`calcularLeituraUrbana`, roda a cada ciclo de coleta): 3
  correções — `COUNT(*)` (contava UCs) → `COUNT(DISTINCT c.livro)`; `digitados`/`nao_digitados`
  fixos em `0` → `SUM(CASE WHEN c.codigo IS NOT NULL/IS NULL ...)`; `leituristas_ativos` (regex
  quebrado, sempre ≤1) → `COUNT(DISTINCT CASE WHEN c.situacao = 'Em Execução' THEN c.colaborador
  END)`.
- **`massivas-view.html`**: rótulo da coluna condicional por `escopo` — "Realizados/Não
  realizados" em `leiturarelitura`, "Executados/Pendentes" em `massiva` (mesmo padrão já usado
  nas colunas "Tipo"/"Prazo regulatório").

### Bug real encontrado e corrigido: `bigint` como string quebrava o percentual

Usuário reportou (print) progresso "169/12" mostrando "1%" — matematicamente impossível.
Causa: `SUM(...)` do Postgres em coluna inteira devolve `bigint`; o driver `pg` retorna
`bigint` como **string** em JS (evita perda de precisão), a menos que seja explicitamente
convertido. `CONTR_REALIZADO_LIVRO_SQL`/`CONTR_NAO_REALIZADO_LIVRO_SQL` não tinham `::int`, e
`massivas-view.ts` fazia `linha.digitados + linha.nao_digitados` — `+` em duas strings é
concatenação, não soma (`"169"+"12"` = `"16912"`, não `181`), daí `169/16912 ≈ 1%`. Corrigido
envolvendo as duas constantes num `(...)::int` externo. Validado direto no banco:
`typeof realizados === 'number'` e percentuais plausíveis (80,1%, 98,8%, 52,5%, 36,4%, 87,4%)
para livros reais. Usuário confirmou: "progresso bateu".

### 4 pedidos adicionais (verificação por 4 prints da tela real)

1. **"Último sincronismo" sempre visível** — `lista-colaboradores.html`: antes só aparecia no
   card expandido do colaborador; agora tem uma linha própria sempre visível logo abaixo do
   nome, na lista lateral da aba Trilho (mesmo campo, `atividadeDe(...).ultimaMudancaHora`).
2. **UCs do livro no modal "Histórico do livro"** (Monitoramento de Livros) — o modal mostrava
   só a timeline de eventos agregados por lote; agora também lista, numa tabela abaixo da
   timeline, cada UC do livro com código/situação/colaborador/último import.
3. **Bug do progresso** — já coberto acima (fix do `::int`).
4. **Timeline UC-a-UC no painel de livro da aba Trilho** — a seção "Histórico" do painel
   (`livro-detalhe.html`, aberto ao clicar num livro do colaborador na lista lateral) mostrava
   eventos por lote (mudança de situação/colaborador); trocada por uma timeline UC-a-UC — pra
   cada UC do livro, a data/hora em que ela apareceu com `codigo` preenchido pela primeira vez,
   ordenada da mais antiga pra mais recente (primeira realizada → última execução).

Pedidos 2 e 4 compartilham a mesma fonte de dado nova, `GET /massivas/livro-ucs?livro=X`
(`obterUcsDoLivro`, `massivasService.js`) — não havia, até então, nenhuma consulta que
devolvesse UC individual (tudo já vinha agregado por livro). A função lê todas as linhas cruas
do livro (`consultarUcsBrutasDoLivro`) e deriva dois recortes em memória (não em SQL, porque
cada recorte precisa de uma regra de "qual linha vence" diferente por UC):

- `atuais` (pedido 2): para cada UC, a linha do lote **mais recente** (`data_import`+
  `hora_import` mais alto) — "como está o livro agora, UC por UC".
- `timeline` (pedido 4): para cada UC que já teve `codigo` preenchido em algum lote, a
  **primeira** ocorrência disso (lote mais antigo com `codigo` não nulo) — "quando cada UC
  virou realizada", ordenado cronologicamente. UC nunca realizada fica de fora (não tem
  "quando" para algo que não aconteceu).

Endpoint novo: `GET /massivas/livro-ucs?livro=X` → `{ sucesso, livro, atuais, timeline }`
(`massivasController.js`/`massivasRoutes.js`). Frontend: `MassivasService.ucsLivro` (consumido
pelo modal de Monitoramento de Livros) e `ColaboradoresService.timelineLivro` (consumido pelo
painel da aba Trilho) — dois signals separados, mesma origem HTTP, cada um cacheado por livro
no seu próprio service.

Verificado por teste direto contra dado real (livro `004489`): 272 UCs em `atuais`, 237 em
`timeline`. `npm test` (12 testes de isolamento de tenant) continua passando — mudança não
mexe em RLS/tenant. Frontend recarregado via HMR ao longo de toda a edição sem erro de
compilação/console.

## Adendo 16 — ajustes na timeline UC-a-UC e card "Impedimentos" (aba Trilho)

Usuário viu a timeline do Adendo 15 ao vivo (print da tela) e pediu 2 ajustes, mais um pedido
separado sobre o mapa:

1. **A timeline devia mostrar só o número da UC e a hora de execução** — a versão anterior
   também mostrava o valor de `codigo` (badge verde) ao lado, redundante com o que já estava
   implícito ("hora de execução" já É a hora em que `codigo` apareceu preenchido pela primeira
   vez — ver Adendo 15). Removida a exibição do `codigo` em
   `livro-detalhe.html`, mantendo só `UC {uc}` e `{data_import} {hora_import}`.
2. **Card "Impedimentos" (antes um placeholder "Em breve")**: usuário definiu a regra —
   `codigo` diferente de `'000'` (leitura normal) e `'099'` (sem leitura, não é problema de
   campo) conta como impedimento real (ex.: portão trancado, cão solto). Card trocado de
   cinza/tracejado para o estilo âmbar (mesmo padrão visual dos outros cards preenchidos —
   `Realizadas` em verde, `A realizar` em vermelho), mostrando a contagem real.

   Fonte do dado: `atuais` (estado **atual** de cada UC, não a timeline de quando ela foi
   realizada — impedimento é sobre o código de agora, não sobre histórico). `ColaboradoresService`
   ganhou `atuaisLivro` (armazena o array `atuais` da mesma resposta de `/massivas/livro-ucs`
   já buscada pra timeline — nenhuma chamada HTTP extra) e um `computed` `impedimentosLivro`
   que filtra por `ehCodigoDeImpedimento(codigo)` (`codigo && codigo !== '000' && codigo !==
   '099'`). Cache trocado de `Map<livro, timeline[]>` para `Map<livro, {atuais, timeline}>`
   pra guardar as duas listas de uma vez.
3. **Tipos de mapa (satélite, topográfico etc.)** — pedido à parte, sobre `app-mapa-bases.ts`
   (mapa de bases regionais da aba Trilho, Leaflet com só uma camada OSM fixa até então).
   Adicionado `L.control.layers` com 4 opções: `Ruas` (OSM, a mesma de antes), `Satélite` (Esri
   World Imagery — escolhida por não exigir chave de API, ao contrário do Google Maps),
   `Satélite c/ rótulos` (a mesma camada de satélite + uma camada de referência de
   estradas/cidades da Esri por cima, num `L.layerGroup`) e `Topográfico` (OpenTopoMap). Cada
   opção do controle usa sua própria instância de `L.tileLayer` (mesmo a satélite "pura" e a
   satélite dentro do `layerGroup` da versão "c/ rótulos" são instâncias separadas, com a
   mesma URL) — evita o comportamento inconsistente de reaproveitar a mesma instância de
   camada em duas entradas do controle ao trocar entre elas. Controle posicionado em
   `topleft` (não no canto padrão `topright`) porque o painel `app-livro-detalhe` cobre o lado
   direito da tela quando um livro está aberto, o que esconderia o controle ali.

Sem mudança de backend. Frontend recarregado via HMR sem erro de console/compilação durante
toda a edição. `npm test` (12 testes de isolamento de tenant) continua passando.

## Adendo 17 — card "Impedimentos" do colaborador (total geral) + timeline visual com destaque de impedimento

Usuário viu o card "Impedimentos" do Adendo 16 (por livro, no painel da aba Trilho) e pediu 3
ajustes, agora envolvendo também o card expandido do colaborador (`lista-colaboradores.html`):

1. **Card "Impedimentos" do colaborador (antes placeholder "--") passa a somar todos os livros
   dele, não só um livro específico.** Diferente do card do Adendo 16 (escopo: um livro), este
   fica na lista lateral da aba Trilho, no card expandido de cada colaborador, ao lado de
   "Leituras"/"Realizadas"/"A realizar"/"Livros"/"Livros em execução" — todos esses já eram
   totais agregados de **todos os livros do colaborador no dia**, e "Impedimentos" devia seguir
   o mesmo padrão.

   Implementado em `atividadeColaboradoresService.js#listarAtividadeHoje`: a query agregada por
   snapshot de livro (já teria `digitados`/`nao_digitados`) ganhou uma terceira coluna,
   `SUM(CASE WHEN codigo IS NOT NULL AND codigo NOT IN ('000','099') THEN 1 ELSE 0 END)::int AS
   impedimentos` — mesma regra do Adendo 16. Cada `livro` da lista de um colaborador carrega seu
   `impedimentos` (valor do snapshot mais recente daquele livro, mesmo padrão de
   `digitados`/`naoDigitados`), e um novo `totalImpedimentos = livros.reduce(...)` soma todos.
   Colaborador só-massiva (sem `contr_execucao_leitura`, ver `listarColaboradoresMassivaHoje`)
   recebe `totalImpedimentos: 0` — massiva não tem coluna `codigo`, esse conceito não existe lá.

2. **UCs com impedimento devem ficar em evidência na timeline, com o código ao lado.** A
   timeline do Adendo 16 (painel de livro, aba Trilho) tratava toda UC igual (mesma cor, sem
   mostrar o código). Agora cada item usa `ehCodigoDeImpedimento()` (exportada de
   `colaboradores.service.ts`, reaproveitada — mesma regra do card, um único lugar de verdade)
   pra decidir o estilo: UC normal continua discreta (ponto verde, texto cinza); UC com
   impedimento vira ponto e texto âmbar, com um badge extra mostrando `Código {codigo}` ao lado
   do número — só aparece pras UCs que realmente têm impedimento, não polui as demais.

3. **Formato da timeline: só o número da UC (sem o prefixo "UC"), com pontos de linha do
   tempo.** Trocado o `<div class="space-y-0.5">` (linhas simples separadas por borda) por um
   `<ol class="relative border-l-2 ...">`/`<li>` com um ponto (`div.absolute.rounded-full`) por
   item — mesmo padrão visual já usado no modal "Histórico do livro" de Massivas
   (`massivas-view.html`, já existente antes desta sessão), reaproveitado aqui por consistência
   visual entre as duas telas.

Verificado diretamente no banco (sem passar pela API, que estava desligada a pedido do usuário
— ver seção de operação): a query de impedimentos roda sem erro e devolve números plausíveis.
Achado que vale registrar: o código `'094'` é o segundo mais frequente na tabela inteira (5.375
ocorrências, atrás só de `'000'` com 8.101) — bem mais comum que qualquer outro código não-
`000`/`099`. Como não é `000` nem `099`, conta como impedimento pela regra definida pelo
usuário; não foi feita nenhuma exceção pra ele porque o pedido foi explícito e sem menção a
`'094'` como caso especial — sinalizado ao usuário pra confirmar se é isso mesmo que ele quer.

`npm test` (12 testes) continua passando. Frontend recarregado via HMR sem erro de console
durante toda a edição.

## Adendo 18 — bug real: painel do livro ficava com "atuais"/impedimentos congelados (cache indefinido)

Usuário reportou, com print, uma inconsistência que não podia estar certa: colaborador com
**apenas 1 livro** mostrava "Impedimentos: 41" no card da lista lateral (Trilho) mas
"Impedimentos: 40" no painel de detalhe daquele mesmo livro — com 1 livro só, os dois números
são a mesma soma e têm que bater sempre.

### Causa raiz

`ColaboradoresService.buscarTimelineLivro()` (Adendo 15) buscava `atuais`/`timeline` de
`/massivas/livro-ucs` **uma única vez**, ao abrir o painel, e guardava num `Map` (`cacheUcsLivro`)
pra sempre — reaproveitando o mesmo padrão de cache já usado para "histórico" (`cacheHistorico`
em `MassivasService`), que faz sentido para dado histórico (eventos passados não mudam), mas é
**errado para `atuais`**: por definição é o estado **atual** de cada UC (Adendo 15), e a coleta
roda em loop contínuo 24h (ver ADR 0020). O card do colaborador, por outro lado, recalcula
`totalImpedimentos` a cada 60s (`carregarAtividadeHoje`, já existente). Resultado: se uma UC
mudasse de código entre o momento em que o painel foi aberto e agora, o card (recém-atualizado)
e o painel (preso no cache da primeira busca) divergiam — exatamente o sintoma reportado. Nada
de errado com a lógica de contagem em si (as duas usam a mesma regra `ehCodigoDeImpedimento`);
era puramente uma questão de um lado atualizar sozinho e o outro nunca atualizar.

O mesmo padrão de cache indefinido existia, idêntico, em `MassivasService.buscarUcsLivro()`
(pedido 2 do Adendo 15 — modal "Histórico do livro" da tela Monitoramento de Livros), com o
mesmo risco (não reportado pelo usuário até agora, mas mesma causa raiz).

### Correção

- `ColaboradoresService`: removido `cacheUcsLivro`. `buscarUcsLivro(livro, mostrarCarregando)`
  agora sempre busca fresco; `mostrarCarregando: true` só na abertura manual (reseta as listas e
  mostra "Carregando..."), `false` nas atualizações automáticas em segundo plano (não apaga a
  lista nem pisca loading a cada refresh — mesmo cuidado do `resetarPagina` em
  `MassivasService.buscarTudo`). `abrirLivro()` agora arma um `setInterval` de 60s (mesma
  constante `INTERVALO_ATIVIDADE_MS` já usada pro polling de atividade) que só roda enquanto o
  painel está aberto; `fecharLivro()` limpa o intervalo. Reabrir um livro diferente (sem fechar
  antes) também limpa o intervalo anterior antes de armar o novo.
- `MassivasService`: removido `cacheUcsLivro` da mesma forma (`buscarUcsLivro` sempre busca
  fresco). Sem polling automático aqui — é um modal (fechado/reaberto pelo usuário a cada
  consulta), diferente do painel fixo da aba Trilho; reabrir o modal já busca de novo
  naturalmente.

`npm test` (12 testes) continua passando. Frontend recarregado via HMR sem erro de console.

## Adendo 19 — causa raiz real da divergência do Adendo 18: UC duplicada dentro do mesmo lote, em TODOS os livros

O fix do Adendo 18 (parar de cachear `atuais` indefinidamente) reduziria a divergência a zero
SE as duas fontes já concordassem quando ambas estão frescas — usuário reportou que **não**:
mesmo logo depois do fix, o card do colaborador (41) e o painel do livro (40) continuavam
diferentes pro mesmo livro único. Isso descartava cache como causa e apontava pra uma
divergência real entre os dois métodos de agregação.

### Investigação

Comparando as duas fontes linha a linha pro livro `004489`: a "última batch de hoje" (usada
pelo card do colaborador) tinha **348 linhas brutas**, mas só **273 UCs distintas** — 75 UCs
apareciam 2 ou 3 vezes no MESMO lote (mesmo `data_import`+`hora_import`), às vezes com `codigo`
diferente entre as cópias (ex.: UC `97187267` com `['000', '000', '099']`). Levantamento em toda
a tabela: **os 360 livros** do lote do dia tinham duplicata — 11.909 linhas brutas contra 9.820
UCs distintas (21% de inflação). Em toda a história da tabela: 133.057 linhas com UC, 18.415
delas duplicatas a mais (14%).

O card do colaborador (`SUM(...)` sobre linhas cruas, Adendo 17) contava cada cópia da UC
duplicada separadamente; o painel do livro (`listarUcsAtuaisDoLivro`, Adendo 15) já deduplicava
por UC, mas desempatava por `paraEpoch(data_import, hora_import)` — que só tem granularidade de
**segundo**, incapaz de distinguir duplicatas do MESMO lote (mesmo segundo exato) de forma
determinística. Duas contagens diferentes, cada uma com um problema diferente: uma não
deduplicava nada, a outra deduplicava com desempate ambíguo.

### Causa raiz real: exceção dentro de um `finally` descartava um retorno de sucesso

Em `copelScraperService.js#abrirEExtrairOs`, o bloco `finally` fecha a tela de detalhe da OS:

```js
} finally {
  if (popup) {
    await popup.close().catch(() => {});
  } else if (usouMesmaPagina) {
    await fecharTelaDetalheMesmaPagina(page);   // SEM .catch() — diferente do popup acima
  }
}
```

`fecharTelaDetalheMesmaPagina` clica no botão "CANCELAR"; sob várias abas competindo pela mesma
sessão (ver ADR 0020), esse clique podia falhar/dar timeout. Em JavaScript, uma exceção lançada
dentro de um `finally` **descarta silenciosamente** o `return` (ou exceção) do `try`/`catch`
associado — mesmo que o `try` já tivesse retornado `'ok'` com `linhasUc` já extraída e **já
empurrada em `registros`** (`for (const uc of linhasUc) registros.push({ ...alvo, ...uc })`,
executado ANTES do `finally`). O `worker()` então via essa chamada como `erro_inesperado` (não
como sucesso) e devolvia o livro pra fila (`filaLivros.push(alvo)`) pra retentativa — que, se bem
sucedida, extraía as MESMAS UCs de novo, duplicando-as em `registros`. Explica também o `codigo`
diferente entre cópias: minutos podem se passar entre a tentativa original e a retentativa (o
livro reentra no FIM da fila compartilhada), tempo suficiente pra um leiturista real lançar uma
leitura nesse meio-tempo.

### Correções

1. **`copelScraperService.js`**: `fecharTelaDetalheMesmaPagina(page)` no `finally` agora tem
   `.catch()` — uma falha ao fechar a tela nunca mais derruba um `return 'ok'` já decidido.
   Como recuperação, se o fechamento falhar, a aba renavega pra `URL_ACOMPANHAMENTO` e refaz
   filtro+busca (mesmo padrão de `recuperarAba`) — evita que essa aba fique presa na tela de
   detalhe pro próximo livro da fila.
2. **Desempate por `id` em vez de `data_import`+`hora_import`** — tanto na correção pontual do
   Adendo 18 quanto agora nas queries principais: `id` (bigserial, estritamente cronológico) tem
   resolução maior que a hora (só segundos) e desempata duplicatas do MESMO lote de forma
   determinística. Aplicado em `massivasService.js#listarUcsAtuaisDoLivro`/
   `listarTimelineUcsRealizadasDoLivro` (trocando `paraEpoch(...)` por `id`).
3. **Deduplicação nas queries principais do dashboard** — `contarFonteContr`, `obterFaixasDias`,
   `detalheContr`, `historicoContrLivro` (`massivasService.js`) e `calcularLeituraUrbana`
   (`leituraUrbanaService.js`) somavam linhas cruas de `contr_execucao_leitura` sem deduplicar
   por UC — mesmo bug do card do colaborador, só que afetando Realizados/Não realizados/
   Progresso/Leituras da tabela principal de Monitoramento de Livros e do painel de Leitura
   Urbana, pra TODO livro, não só o do print do usuário. Nova função `contrDedupSql(condicaoEscopo)`
   (exportada de `massivasService.js`, reaproveitada em `leituraUrbanaService.js`): recebe a
   condição de escopo que o chamador já aplicaria de qualquer forma (por lote específico, ou por
   livro inteiro pra `historicoContrLivro`) e devolve uma subquery `DISTINCT ON (livro,
   data_import, hora_import, uc) ... ORDER BY ..., id DESC` — dedup **restrito ao escopo já
   filtrado** (não a tabela inteira), barato o bastante pra não precisar de índice novo (~30
   linhas por livro por lote). Trocado `FROM contr_execucao_leitura c` por
   `FROM ${contrDedupSql(...)} c` nos 5 pontos, sem tocar em `SELECT`/`JOIN`/`WHERE`/parâmetros
   existentes — o filtro redundante que sobra no `WHERE` externo (`c.data_import = $1 AND
   c.hora_import = $2`, já coberto pela subquery) foi deixado como está, inofensivo.
4. **Limpeza dos dados já duplicados**: `DELETE` (com verificação prévia e `COMMIT` só se os
   números batessem) mantendo, por `(livro, data_import, hora_import, uc)`, só a linha de maior
   `id`. Removidas **20.144 linhas** (tabela cresceu durante a investigação por causa da coleta
   rodando em paralelo — a duplicidade a mais reflete ciclos adicionais coletados nesse meio-
   tempo, ainda com o scraper antigo/sem o fix rodando até o momento do restart). Confirmado
   zero grupos duplicados após o `COMMIT`.

### Verificação

- Funções corrigidas testadas diretamente contra o banco real (fora da camada HTTP,
  `obterResumo`/`obterDetalhe`/`obterHistoricoLivro`/`calcularLeituraUrbana`): todas rodam sem
  erro de SQL. `detalheContr` pro livro `004489` retornou `digitados: 237, nao_digitados: 36` —
  batendo exatamente com a contagem deduplicada calculada manualmente antes da correção (237+36
  = 273 UCs distintas, não mais as 348 linhas brutas infladas).
- O processo de coleta já estava rodando com o fix do scraper carregado (nodemon reiniciou
  sozinho ao detectar a mudança no arquivo, confirmado comparando o horário de início do
  processo com o horário do `git`/edição do arquivo). Verificado direto no banco: **zero**
  grupos duplicados entre os ~30.000 registros inseridos pelos ciclos de coleta rodados DEPOIS
  da limpeza — confirma que a correção do scraper está funcionando de verdade em produção, não
  só em teoria.
- `npm test` (12 testes de isolamento de tenant) continua passando.

## Adendo 20 — calendário de datas passadas, UCs pendentes na timeline, e confirmação do sintoma do Adendo 19

Três pedidos do usuário, o último confirmando ao vivo que o Adendo 19 já tinha resolvido um
sintoma que ele via como suspeito:

### 1. Calendário da aba Trilho: navegar pra dias de execução passados

O campo de data (`filtros-colaboradores.html`) já existia, mas travado só em hoje (`[min]`/
`[max]="hoje"`, tooltip "por enquanto só é possível consultar o dia de hoje") — `filtroData` era
setado mas nunca chegava a influenciar a busca de atividade.

`atividadeColaboradoresService.js#listarAtividadeHoje(db, dataIso)` ganhou um segundo parâmetro
opcional (`"YYYY-MM-DD"`, mesmo formato do `<input type="date">`; `undefined` continua
consultando hoje). Threading completo da data por todas as sub-consultas que antes assumiam
"hoje" implicitamente:

- `WHERE data_import = $1` (query principal) já usava uma variável local `hoje` — só precisou
  deixar de vir sempre de `new Date()` e passar a vir do parâmetro quando presente.
- `listarColaboradoresMassivaHoje(db, dataBr)`: antes pegava sempre o batch **mais recente de
  sempre** de `atribuidas_im`/`em_execucao_im` (`ORDER BY id DESC LIMIT 1`, sem filtro de data) —
  numa consulta de dia passado isso mostraria a massiva de HOJE misturada com a leitura/releitura
  do dia antigo. Adicionado `WHERE dt_import = $1` nas duas CTEs (`ultimo_atribuidas`/
  `ultimo_execucao`).
- `obterMapaPrazoRegulatorio(db, dataConsultaIso)`: usava `CURRENT_DATE` pra achar o mês de
  `prazo_reg_livros` — errado ao navegar pra um mês diferente do atual (ex.: virou o mês desde a
  execução consultada). Trocado por `date_trunc('month', $1::date)`.
- `obterAfastamentosHoje`/`obterLicencasAtivosInativosHoje`/`obterSuspensoesHoje`: cada uma
  computava seu próprio "hoje" via `new Date()` — pra afastamento/licença/suspensão refletirem o
  dia CONSULTADO (não o dia real), passaram a receber a mesma data ISO como parâmetro.

Rota (`GET /colaboradores/atividade-hoje?data=YYYY-MM-DD`) e frontend
(`ColaboradoresService.carregarAtividadeHoje` envia `filtroData()` como querystring;
`onFiltroDataChange(data)` seta o filtro e recarrega) atualizados. Removido o `[min]`/`[max]`
travando em hoje (só `[max]="hoje"` continua — não faz sentido consultar o futuro). O polling
automático de 60s (`INTERVALO_ATIVIDADE_MS`) só dispara quando `filtroData() === hojeIso()` —
consultar um dia passado não tem "dado novo chegando" pra esperar, refazer a mesma busca a cada
60s seria só desperdício. Rótulos "Livros de hoje"/"Nenhuma atividade registrada hoje" (lista
lateral) trocados por um `computed` (`rotuloDataAtividade`) que mostra "hoje" só quando a data
selecionada realmente é hoje, senão "em DD/MM/YYYY".

Verificado direto contra o banco (chamando `listarAtividadeHoje` fora da camada HTTP): hoje sem
parâmetro (dia novo, virou a data durante a sessão — 0 colaboradores, esperado); um dia passado
(`2026-08-28`) devolveu 214 colaboradores com dados plausíveis; uma data sem nenhum dado
(`2020-01-01`) devolveu lista vazia sem erro.

### 2. UCs ainda não realizadas na timeline (ponto cinza)

A timeline do painel de livro (Adendos 16/17) só listava UCs **realizadas** (com `codigo`
preenchido) — pedido do usuário: mostrar também as pendentes, pra a lista representar o livro
inteiro, não só o que já rodou. `LivroDetalhe.naoRealizadas()` filtra `atuaisLivro()` por
`!uc.codigo` (já buscado pra alimentar o card "Impedimentos", nenhuma chamada HTTP nova) e o
template (`livro-detalhe.html`) as lista depois das realizadas, no mesmo `<ol>`, com ponto
cinza (`bg-slate-300`) e "Ainda não realizada" no lugar da data/hora (não têm "quando" — nunca
aconteceu).

### 3. Confirmação: o "sincronismo" que parecia sempre avançar sem UC nova era o bug do Adendo 19

Usuário questionou se "Último sincronismo" estava sendo preenchido mesmo sem nenhuma UC
realizada naquele horário — print mostrava `23:39:36` avançando a cada ciclo. Verificado direto
no banco: ANTES do fix do Adendo 19 (duplicidade de UC no mesmo lote com `codigo` divergente
entre cópias), `digitados`/`naoDigitados` oscilavam de forma espúria entre lotes mesmo sem
nenhuma leitura nova — disparando falsamente a checagem `inalterado` de
`listarAtividadeHoje` (que só deveria marcar "mudou" quando `situacao`/`digitados`/
`naoDigitados` realmente diferem do lote anterior) e fazendo "Último sincronismo" avançar a
cada ciclo. Com o dedup do Adendo 19 já em produção, testado ao vivo pro mesmo colaborador/livro
do print (`AMILTON STELLI`, livro `004489`, dia `29/08/2026`): `digitados`/`naoDigitados` ficaram
estáveis em `237/36` em **todos os 10 lotes** do dia (`19:43:41` até `23:39:36`), e
`ultimaMudancaHora` corretamente parou em `19:43:41` (a única mudança real) — não mais
`23:39:36`. Confirma que o mecanismo já funciona como deveria; o sintoma que o usuário viu era
efeito direto do bug já corrigido, não um problema novo.

`npm test` (12 testes) continua passando. Frontend recarregado via HMR sem erro de console.

## Adendo 21 — "Último sincronismo" avançava sem UC realizada (mudança de situação sozinha bastava)

Usuário questionou diretamente: "esse sincronismo deve ser de acordo com as UC executadas então
se você me mostra sincronismo às 00h então teve leitura realizada nesse horário ou só trouxe o
último registro de hora importado?" — pergunta que expôs um bug real no Adendo 20/17.

### O bug

`ultimaMudancaColaborador` (campo `ultimaMudancaHora`, exibido como "Último sincronismo") vinha
do último item de `historico`, e `historico` registra qualquer mudança de `situacao`,
`digitados` ou `naoDigitados` — não só `digitados` aumentando. Achado um caso real do dia
29/08/2026: livro `024462` do colaborador Ronald Pereira Vernek mudou de situação
("Atribuída" → "Em Execução") às 23:17:36 com `digitados` continuando em `0` nos dois momentos —
zero UC realizada, e mesmo assim o sincronismo teria avançado pra 23:17:36.

### Correção 1 — separar "mudou o lote" de "UC virou realizada"

`historico` continua registrando qualquer mudança (situação inclusa — é informação real sobre a
evolução do livro). Mas o horário do "Último sincronismo" agora vem de uma variável própria,
`ultimaExecucaoLivro`, que só avança quando `digitados` do lote atual é MAIOR que o do lote
anterior dentro do mesmo dia. Novo campo `ultimaExecucao` exposto por livro (`null` = nenhuma UC
foi realizada naquele livro no dia consultado) — usado no card "Último sincronismo" do painel de
detalhe (`livro-detalhe.html`, antes usava `ultimaVez`, o horário do último lote não importa se
mudou algo). Card do colaborador (`ultimaMudancaHora`) passa a ser o maior `ultimaExecucaoLivro`
entre os livros dele, não mais o maior "algo mudou".

### Correção 2 — a lacuna do primeiro lote do dia

Comparar só dentro dos lotes de hoje (`anterior = null` no primeiro) tem um furo: a coleta roda
24h contínua (ADR 0020), então o primeiro lote de um livro num dia pode vir bem depois da
meia-noite, e o leiturista pode já ter realizado UCs **antes** desse primeiro lote — invisível
sem um ponto de comparação anterior a hoje. Nova função `obterBaselineDigitadosPorLivro(db,
hoje)`: busca, por livro, o `digitados` deduplicado do último lote **estritamente anterior** ao
dia consultado, usado como valor inicial de comparação pro primeiro lote de hoje.

Achado e corrigido um bug na primeira versão desta query: usar `data_import <> $1` pra dizer
"antes de hoje" está errado quando também existe dado de dias **seguintes** na tabela (o caso
real: a data virou em tempo real durante a sessão, já havia coleta do dia seguinte na tabela
no momento da consulta) — `<>` inclui o futuro, não só o passado. Corrigido usando `id` como
corte: `MIN(id)` do dia consultado define o corte, e o baseline só considera `id < corte`
(`id`, bigserial, é estritamente cronológico — não sofre da ambiguidade de comparar
`data_import` como texto).

Verificado com um caso real e independente: livro `002513` tinha `digitados=44` no fim de
28/08/2026 e `digitados=119` já no PRIMEIRO lote de 29/08/2026 (19:43:41) — sem o baseline,
essas 75 UCs realizadas ficariam invisíveis (`historico` só tinha 1 entrada, o próprio primeiro
lote). Com o baseline, `ultimaExecucao` corretamente aponta `19:43:41`. Antes da correção do
corte por `id`, o baseline (por engano) pegava um lote do dia SEGUINTE (30/08) e devolvia o
mesmo valor de hoje (nenhuma diferença detectável) — zero colaboradores tinham execução real
detectada no dia inteiro, claramente implausível pra 116 colaboradores ativos. Depois da
correção: 15 de 116 colaboradores com execução real detectada em 29/08/2026 — plausível pro
fim do dia de trabalho.

Consulta adicional (`obterBaselineDigitadosPorLivro`) mede ~180-800ms sem índice de suporte
(rodando como `app_user`, sem privilégio pra `CREATE INDEX` neste ambiente) — aceitável na
frequência atual (a cada 60s de polling, ou uma vez por troca de data), mas
`(livro, id DESC)` ajudaria se o volume crescer bastante.

`npm test` (12 testes) continua passando. Frontend recarregado via HMR sem erro de console.

## Adendo 22 — Adendo 21 ficou incompleto: massiva ainda usava a semântica antiga

Usuário mandou print comparando dois colaboradores lado a lado: Alexia Canever Rodrigues
(0 realizadas) mostrando "Último sincronismo: 01:32", e Amilton Stelli (237 realizadas, 87%)
mostrando "Último sincronismo: --" — exatamente invertido do que faz sentido.

### Causa

O Adendo 21 corrigiu `ultimaMudancaHora` só pro caminho de leitura/releitura
(`contr_execucao_leitura`). Colaboradores só-massiva (como a Alexia, cujo único livro tem
`tipoServico: "massiva"`) continuavam vindo de `listarColaboradoresMassivaHoje`, que ainda
usava `ultimaMudancaHora: livrosMassiva[0].ultimaVez` — a hora do último lote importado, sem
nenhuma detecção de execução real. Confirmado direto no banco: Amilton (leitura,
`ultimaMudancaHora: null`, correto — nada novo hoje) vs. Alexia (massiva,
`ultimaMudancaHora: "01:32:44"`, ainda o bug antigo).

### Correção

Estendida a mesma lógica (baseline do último lote ANTES do dia consultado, `digitados`
aumentando = execução real) pra massiva. Nova `obterBaselineDigitadosMassiva(db, dataBr,
pares)`: busca, por tabela (`atribuidas_im`/`em_execucao_im`), o `qtd_digitados_nao_digitados`
do último lote antes do dia — "Em Execução" vence "Atribuída" quando o par existe nas duas
(mesma prioridade já usada na query principal). `listarColaboradoresMassivaHoje` passa a expor
`ultimaExecucao` por livro de massiva, e `listarAtividadeHoje` usa isso — tanto pra colaborador
só-massiva quanto pra quem tem os dois tipos (leitura E massiva: `ultimaMudancaHora` vira o
maior entre os dois lados). `ativo`/`parado`/`semSincronismo` de colaborador só-massiva também
passaram a usar a mesma fórmula de `minutosParado` da leitura (antes fixo em
`ativo: !parado, semSincronismo: false` — outra inconsistência da mesma família, nunca
detectava "trabalhou de manhã, sumiu à tarde" em quem só tem massiva).

### Bug de performance descoberto no processo

Passar a fazer `DISTINCT ON (leiturista, livro)` em `em_execucao_im` sem restringir os pares
antes tentava ordenar a tabela inteira — **732.800 linhas**, sem nenhum índice em
`(leiturista, livro)` (só `id` e `empresa_id`). Medido ao vivo: 5,7s só nessa consulta,
10,9s no `listarAtividadeHoje` inteiro — inaceitável pra um endpoint com polling de 60s.
Corrigido restringindo a busca do baseline só aos pares (leiturista, livro) que aparecem no
dia consultado (extraídos de `linhas`, join via `UNNEST(...)` antes da ordenação) — o Postgres
descarta a esmagadora maioria das linhas antes de precisar ordenar qualquer coisa. Resultado:
10,9s → 2,8s. Ainda não é rápido (mesma limitação de falta de índice do Adendo 21 — sem
privilégio de `CREATE INDEX` neste ambiente), mas aceitável na frequência de 60s.
`(leiturista, livro, id DESC)` em `atribuidas_im`/`em_execucao_im` resolveria de vez, se algum
dia alguém com acesso de dono rodar o DDL.

Verificado direto no banco: Alexia (0 realizadas) e Amilton (237 realizadas, nada novo hoje)
agora mostram `ultimaMudancaHora: null` os dois — consistentes entre si, resolvendo a inversão
reportada. `npm test` (12 testes) continua passando.

## Consequências

- `contr_execucao_leitura` com o novo schema confirmado via `\d` (RLS/FK/PK intactos).
- `npm test` (suíte de isolamento de tenant, 12 testes) continua passando — mudança não mexe
  em RLS/tenant.
- Testado ao vivo, direto contra o banco (sem passar pela camada HTTP), exercitando os 4
  caminhos de código afetados: `calcularLeituraUrbana`, `listarAtividadeHoje`,
  `obterResumo`/`obterDetalhe` (escopo `leiturarelitura`) — todos rodaram sem erro de SQL. A
  coleta automática já tinha repopulado a tabela com o schema novo nesse meio-tempo (808
  pendentes, 1253 linhas de detalhe), confirmando que `copelImportService.js` grava
  corretamente com as colunas atuais.
- Progresso, Realizados/Não realizados e cards de agentes em campo (Adendo 15) já refletem o
  schema novo corretamente, incluindo o fix do bug `bigint`-como-string. UC individual
  (estado atual e timeline de realização) disponível via `/massivas/livro-ucs`, consumida nos
  4 pedidos de verificação do usuário.
