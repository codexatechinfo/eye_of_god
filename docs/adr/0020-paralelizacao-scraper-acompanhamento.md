# ADR 0020 — Paralelização do scraper de Acompanhamento (múltiplas abas, uma etapa por vez)

## Contexto

Com as correções desta sessão (Adendos 1-14 da ADR 0018), o scraper de Acompanhamento passou
a processar corretamente todas as etapas — mas de forma inteiramente sequencial, uma etapa
depois da outra, cada uma com dezenas ou centenas de livros. Uma etapa grande (ex.: 309
livros) pode levar bastante tempo sozinha. Usuário pediu para acelerar o processo abrindo
várias abas do portal em paralelo — por exemplo 8 — cada uma processando uma etapa por vez, e
"o código deve conversar" para que, ao terminar uma etapa numa aba, ela continue com a
etapa seguinte disponível, sem duas abas se meterem na mesma etapa.

## Decisão

### Sessão compartilhada, não uma sessão por aba

Ponto técnico decisivo, resolvido sem precisar perguntar ao usuário: `browser.newPage()`
chamado diretamente cria, a cada chamada, um `browserContext` **novo e isolado** — sem
cookies compartilhados. Se cada aba tivesse sua própria sessão, cada uma precisaria logar
separadamente, e o portal Copel já demonstrou (ver [ADR 0019](0019-lock-sessao-copel-entre-jobs.md))
aparentar sessão única por usuário — login novo derruba a sessão anterior. Oito abas logando
concorrentemente seria o mesmo problema que a ADR 0019 corrigiu entre os jobs Coleta Acomp e
Massivas, só que multiplicado por 8 dentro da MESMA coleta.

Resolvido criando um `browserContext` explícito (`browser.newContext()`) **uma vez só**, com
login feito numa única página desse context. Todas as abas adicionais são criadas via
`context.newPage()` (não `browser.newPage()`) — compartilham os mesmos cookies de sessão,
sem precisar (nem poder) logar de novo.

### Coordenação por número de etapa, não por índice de posição

Cada aba, depois de aberta, navega pra `acompanhamentoAction.do`, aplica os mesmos filtros e
busca — carregando sua **própria cópia** da lista de etapas, de forma independente das
outras abas. O texto de cada link é algo como "ETAPA 18 - (309)", onde o número entre
parênteses é a contagem de livros **naquele momento exato** — pode divergir ligeiramente
entre a cópia de uma aba e a de outra, mesmo sendo a mesma etapa. Coordenar por texto
completo ou por índice de posição na lista seria frágil: se a ordem ou a contagem variar
entre as cópias, duas abas poderiam processar a mesma etapa (duplicando dados) ou nenhuma
processar uma etapa (etapa perdida).

Nova função `numeroDaEtapa(texto)` extrai só o número ("18" de "ETAPA 18 - (309)") via
regex — identificador estável entre as cópias. A fila de trabalho compartilhada
(`filaEtapas`, um array simples de números únicos) é montada uma vez, lendo a lista já
completamente carregada (via `aguardarTodasEtapasCarregadas`, Adendo 13) na aba principal,
**antes** de abrir as abas extras. Cada worker consome da fila com `filaEtapas.shift()` —
síncrono em JavaScript, então mesmo com N workers "concorrentes" (na real intercalados pelo
event loop, não paralelos de verdade a nível de thread) não há risco de duas abas pegarem o
mesmo número. Ao pegar um número, cada aba procura **na sua própria lista local** o link cujo
texto contém esse número, e processa exclusivamente essa etapa.

### Refatoração: `processarEtapa()` e `worker()`

O corpo do processamento de uma etapa (abrir, loop de livros com toda a robustez já validada
— `garantirEtapaVisivel`, recuperação de tela tardia, try/catch por livro — e recolher no
fim) foi extraído para `processarEtapa({page, etapaLink, etapa, registros, rotulo,
estadoDiagnostico})`, reutilizável em qualquer `page`. `worker(page, rotulo, filaEtapas,
registros)` é o loop que cada aba roda: consome a fila até esvaziar, chamando
`processarEtapa()` para cada número recebido, dentro de um try/catch de nível de etapa (mesmo
raciocínio do Adendo 12 da ADR 0018 — uma etapa irrecuperável não pode travar o worker
inteiro, senão as etapas restantes da fila ficam sem ninguém pra processá-las).

`registros` é um array **compartilhado** entre todos os workers — `Array.push` é síncrono,
sem risco de corrupção mesmo com várias chamadas intercaladas.

### Diagnóstico por aba, não mais global

Antes, `diagnosticoOsSalvo`/`diagnosticoEtapaSalvo` eram únicos para a execução inteira (só 1
screenshot de cada categoria, não importa quantas vezes o problema ocorresse). Com várias
abas rodando em paralelo, isso esconderia problemas de abas diferentes atrás do primeiro
screenshot salvo. Agora `estadoDiagnostico = {osSalvo, etapaSalvo}` é criado **por worker**
(uma vez por aba) — cada aba salva no máximo 1 diagnóstico de cada categoria, mas abas
diferentes não se pisam. Nome do arquivo inclui o rótulo da aba (`[Aba 3/8]` saneado) para
identificar qual aba gerou qual captura.

### Configuração

`COPEL_PARALELISMO_ACOMP` (`.env`, default `8` se ausente) — quantidade de abas. Nunca abre
mais abas do que etapas existem na fila (sem sentido ter 8 abas ociosas pra 2 etapas).

## Consequências

- O lock de sessão exclusiva entre Coleta Acomp e Massivas (`copelSessaoLock.js`, ADR 0019)
  continua funcionando sem alteração — ele envolve a chamada inteira de
  `coletarDadosAcompanhamento()`, que agora abre várias abas *internamente*, mas ainda é uma
  única chamada protegida pelo lock. Massivas continua nunca logando ao mesmo tempo que
  qualquer aba do Acompanhamento.
- Risco aceito, não mitigado nesta mudança: 8 sessões HTTP simultâneas contra o mesmo portal
  aumentam a carga sobre ele e a chance de instabilidade/timeouts pontuais — já coberta pela
  robustez de erro por etapa (Adendo 12) e por livro (Adendo 12/13), mas não eliminada. Se
  isso se mostrar um problema na prática, `COPEL_PARALELISMO_ACOMP` pode ser reduzido sem
  mudança de código.
- `npm test` (12 testes) continua passando — mudança isolada em
  `copelScraperService.js`/`.env.example`, sem tocar em schema, rota nem import.
- Não validado ao vivo nesta sessão — fica pra próxima execução do usuário. Vale conferir, no
  primeiro teste real: se as 8 abas realmente aparecem visíveis (com `COPEL_HEADLESS=false`),
  se a fila é dividida sem repetição nem etapa perdida, e se o volume de UCs total bate com
  execuções sequenciais anteriores.

## Adendo — só abriu 2 abas: a lista de etapas não tinha carregado tudo antes de montar a fila

Testado ao vivo: usuário rodou a coleta e só viu 2 abas abrirem, não 8. Ele mesmo apontou a
causa provável antes de eu investigar: a montagem da fila provavelmente não esperava a lista
de etapas carregar por completo via scroll.

Confirmado revendo o código. Duas causas reais, ambas do mesmo tema:

1. **A janela de confiança de `aguardarTodasEtapasCarregadas` era curta demais pra rodar só
   uma vez.** No fluxo sequencial antigo (Adendo 13 da ADR 0018), essa função era chamada de
   novo a cada etapa que parecia ter acabado — várias chances ao longo de minutos. No fluxo
   paralelo ela só roda **uma vez**, antes de montar a fila definitiva — se o próximo lote de
   etapas demorasse mais que os 300ms entre tentativas pra aparecer no DOM, a função "achava"
   que tinha estabilizado (2 leituras iguais) cedo demais, e a fila ficava curta pra sempre
   (nada tenta carregar mais depois).
2. **O salto direto pro fim (`scrollTo(0, document.body.scrollHeight)`) pode não disparar o
   carregamento do próximo lote da mesma forma que rolar em passos.** Se o portal usa algo
   como intersection observer no fim da lista atual pra decidir quando buscar mais itens,
   pular direto pro fim pula por cima do gatilho — mais parecido com "teletransportar" do que
   com o "ir rolando a tela pra baixo" que o usuário descreveu como o processo manual real.

### Correção

`aguardarTodasEtapasCarregadas()`: troca `scrollTo` (salto) por `scrollBy(0, innerHeight)`
(passo do tamanho de uma janela por vez); intervalo entre passos de 300ms para 600ms; exige 4
leituras estáveis seguidas (era 2) antes de considerar concluído; teto de tentativas subiu de
100 para 150 (mais passos, cada um menor).

Segunda camada de proteção, independente da primeira: no `worker()`, se a etapa sorteada da
fila não for encontrada na lista local da aba (pode ser que ESSA aba especificamente ainda
não tenha terminado de carregar — cada aba rola de forma independente), agora tenta rolar
mais uma vez antes de desistir; se ainda não achar, devolve o número à fila (em vez do
comportamento antigo, que descartava a etapa silenciosamente) para outra aba tentar. Um `Map`
`tentativasPorEtapa` compartilhado limita isso a `MAX_TENTATIVAS_LOCALIZAR_ETAPA = 5` — sem
esse limite, uma etapa que genuinamente não existe em nenhuma aba (cenário hipotético, não
observado) ficaria sendo devolvida pra fila pra sempre, travando a coleta num loop.

`npm test` (12 testes) continua passando. Não validado ao vivo nesta sessão — fica pra
próxima execução do usuário confirmar que as 8 abas abrem quando há etapas suficientes.

## Adendo — abas pareciam se revezar em vez de rodar em paralelo de verdade

Usuário reportou, já com as 8 abas abrindo corretamente: viu a etapa 24 abrir e ficar parada
"um tempão" num livro sem continuar, "como se estivesse esperando a vez dele de voltar a
execução" — sugerindo que as abas não processam de fato em paralelo.

Hipótese mais provável: todas as 8 abas compartilham a MESMA sessão HTTP (mesmo `JSESSIONID`,
por decisão deliberada — ver corpo desta ADR, "sessão compartilhada, não uma sessão por
aba"). Aplicações Java/Struts como essa (padrão de URL `*Action.do`) costumam sincronizar o
acesso à `HttpSession` do lado do servidor — mesmo que o cliente dispare requisições de várias
abas ao mesmo tempo, o servidor pode processá-las uma de cada vez porque todas pertencem à
mesma sessão. Se for esse o caso, o "paralelismo" seria real só do lado do cliente (8
conexões abertas), mas o trabalho de verdade ainda seria serializado no servidor.

Perguntado ao usuário se queria testar sessões separadas por aba (login independente,
paralelismo real de servidor também) — risco: se o portal usa sessão única por *usuário* (não
por cookie), 8 logins da mesma conta poderiam se derrubar entre si, do mesmo jeito que Coleta
Acomp e Massivas se derrubavam antes da ADR 0019. Usuário preferiu não arriscar isso ainda:
manter a sessão compartilhada e primeiro confirmar a causa com dados reais.

Instrumentação adicionada: timestamp de INÍCIO/FIM (com duração) ao redor do clique que abre
a OS de cada livro — a única ação de rede pesada e recorrente (uma por livro) — e timestamp de
início ao abrir cada etapa. Com isso, o próximo log real permite comparar os intervalos
`[INÍCIO, FIM]` de abas diferentes: se houver sobreposição real entre abas (duas ou mais com
requisição em voo ao mesmo tempo), o paralelismo client-side está funcionando e o sintoma
observado era só uma aba lenta num livro difícil (não uma serialização de verdade); se os
intervalos nunca se sobrepõem entre abas diferentes, confirma a sincronização de sessão no
servidor — e aí a decisão de tentar sessões separadas por aba (com o risco descrito acima)
volta à mesa.

`npm test` (12 testes) continua passando. Não validado ao vivo nesta sessão — fica pra
próxima execução do usuário colar o log com os novos timestamps para eu analisar.

## Adendo — timestamp em toda linha de log do fluxo de coleta

Usuário pediu pra generalizar: não só as ações já instrumentadas (abrir OS, abrir etapa),
mas TODA ação do fluxo — do login até a importação no Postgres — com horário no terminal,
pra dar pra contabilizar o tempo total de execução sem precisar cronometrar por fora.

Criado `BACKEND/src/utils/logTempo.js`: `log()`/`logWarn()`/`logErro()`, substitutos de
`console.log`/`warn`/`error` que já prefixam `[hh:mm:ss.mmm]` antes de qualquer outro
argumento. Todas as 26 chamadas de `console.log/warn/error` em `copelScraperService.js`
trocadas pelas equivalentes (via `sed`, depois conferido visualmente); os dois logs de
timing manuais adicionados no Adendo anterior (que já embutiam `${horaAgora()}` na própria
mensagem) tiveram essa parte removida, já redundante com o prefixo automático.

`copelImportService.js` ganhou log por lote inserido (útil pra ver o progresso — um ciclo
grande pode gerar 60+ lotes de 300 linhas). `coletaCopelService.js` ganhou marcos de tempo
decorrido desde o início do ciclo em 3 pontos: fim do scraping, fim da importação, e fim do
ciclo inteiro (login → scraping → importação → recálculo do painel) — dá pra ver quanto cada
fase levou e o total, direto no terminal, sem precisar somar manualmente os timestamps.

`npm test` (12 testes) continua passando. Testado localmente que o formato de saída do
`logTempo.js` está correto (`[hh:mm:ss.mmm] mensagem`). Não validado ao vivo contra o portal
real nesta sessão.

## Adendo — causa raiz real do "esperando a vez": a busca inteira se perde em algumas abas, não é serialização de servidor

Rodada ao vivo, com os timestamps já instrumentados: das 16 etapas encontradas, **8 foram
completamente perdidas** (desistidas em todas as 8 abas após 5 tentativas cada) e outras 5
ficaram com só 1-2 livros coletados de dezenas/centenas esperados. Os logs mostraram 5 das 8
abas falhando quase no mesmo instante (dentro de meio segundo umas das outras) com "tabela
com 0 linhas visíveis depois de tentar reabrir" — enquanto as outras 3 abas continuaram
coletando normalmente, sem nenhum problema, no mesmo intervalo.

O diagnóstico automático (screenshot + texto, já salvo pelo código existente) revelou a causa
real: a página, no momento da falha, mostra o menu completo normalmente (usuário continua
logado: home, equipes, despacho, acompanhamento...) mas o **corpo principal está
completamente vazio** — nenhum link "ETAPA", nenhuma tabela, nada. Não é a etapa que recolheu
(Adendo 7) nem a sessão que caiu — é a **busca inteira que se perdeu** nessa aba específica,
como se ela tivesse voltado para o estado "acabou de entrar na tela, ainda sem buscar".

Isso explica por que `aguardarTodasEtapasCarregadas()` nunca resolvia depois disso: rolar a
página não adianta quando não há absolutamente nada carregado para revelar — a causa não é
"lista ainda carregando", é "resultado da busca sumiu". E como só algumas abas (não todas)
foram afetadas ao mesmo tempo, a hipótese anterior (servidor serializando toda a sessão) não
se sustenta sozinha — é mais provável que o servidor guarde o "resultado da busca atual" como
estado de SESSÃO (não por conexão/aba), e uma ação de uma aba (buscar, cancelar, etc.)
enquanto outra está no meio de algo pode sobrescrever esse estado compartilhado para a
segunda, sem invalidar a sessão em si.

### Correção aplicada

No `worker()`: quando uma etapa não é encontrada mesmo depois de rolar (`aguardarTodasEtapasCarregadas`),
E a lista de etapas da página está **totalmente vazia** (não só "essa etapa específica ainda
não apareceu"), refaz filtro + busca do zero (`aplicarFiltroEBuscar`) antes de desistir —
recupera a aba para o estado funcional em vez de deixá-la "cega" pelo resto da execução
(cenário real observado: 5 abas ficaram permanentemente incapazes de achar qualquer etapa
depois do evento, desistindo de 8 etapas inteiras em sequência).

### Limitação que permanece, não resolvida por esta correção

Essa correção **recupera** a aba depois do problema acontecer, mas não evita que ele
aconteça — a etapa que estava sendo processada no momento da perda de busca ainda fica
parcialmente coletada (só os livros já processados antes do evento). Se isso se mostrar
frequente na prática, a única forma de eliminar a causa de vez é dar a cada aba sua PRÓPRIA
sessão (login independente por aba) — a opção que o usuário preferiu não arriscar ainda no
Adendo anterior, mas agora com evidência mais concreta do problema real da sessão
compartilhada (não é só "paralelismo aparente", é corrupção de estado entre abas).

`npm test` (12 testes) continua passando. Corrigido e reiniciado o backend na mesma sessão —
falta confirmar ao vivo se a recuperação funciona e se a frequência de perda de etapas cai
significativamente.

## Adendo — a causa era mais específica: aba presa na tela de detalhe de uma OS, não "busca perdida"

Reiniciado com a correção acima, rodada ao vivo de novo: a recuperação por
`aplicarFiltroEBuscar()` também falhou — `page.selectOption: Timeout 30000ms exceeded`. O
diagnóstico automático (agora salvo no momento da falha fatal, `catch` do worker) revelou a
causa real, mais precisa que a hipótese anterior: a página estava na URL
`editarTarefasLeituraAction.do?acompanhamento=S`, mostrando "DADOS DA OS" e "DADOS DE
EXECUÇÃO" com a lista de leituristas — ou seja, a aba estava presa na tela de **detalhe de
uma OS específica**, não numa tela de Acompanhamento "sem busca". Faz sentido: o `select`
de concessionária que `aplicarFiltroEBuscar()` tentava usar não existe nessa tela — daí o
timeout.

Rastreada a origem: quando "All promises were rejected" acontece (nem popup nem "DADOS DE
EXECUÇÃO" dentro dos 20s de timeout), o `catch` de `processarEtapa()` fazia UMA checagem
**instantânea** de "a tela apareceu tarde?" antes de decidir fechar. Sob a carga de 8 abas
competindo pela mesma sessão, a navegação real pode demorar mais que isso — a tela de
detalhe aparece *depois* dessa checagem única, e como ninguém mais olha para trás, ela fica
aberta para sempre. A aba fica cega dali em diante: sem etapas visíveis, sem formulário de
busca, presa numa URL completamente diferente.

### Duas correções

1. A checagem de "apareceu tarde" virou um poll de até 10s (10 tentativas de 1s) em vez de
   uma checagem única — cobre o caso realista de "só faltava mais um pouco".
2. Se mesmo assim a aba ficar sem nenhuma etapa (`worker()`), a recuperação agora começa com
   `page.goto(URL_ACOMPANHAMENTO)` **antes** de `aplicarFiltroEBuscar()` — força a navegação
   para a URL certa independente de qual tela a aba estava presa, em vez de depender de
   achar e clicar num botão CANCELAR que pode nem existir na tela em que ela realmente está.

`npm test` (12 testes) continua passando. Corrigido e reiniciado o backend na mesma sessão —
segunda rodada de validação ao vivo em andamento.

## Adendo — mesmo com `goto()`, 8 abas seguem sobrecarregando; reduzido para 5

Terceira rodada ao vivo, com diagnóstico dedicado na falha de recuperação (commit anterior):
a recuperação com `page.goto()` **também falhou** algumas vezes (`page.selectOption:
Timeout` de novo, mesmo já tendo forçado a navegação). Mas dessa vez, ao longo do ciclo
inteiro (~10 minutos, 603634ms), a maioria das abas conseguiu se recuperar em alguma
tentativa seguinte — resultado real conferido no banco: **as 16 etapas apareceram todas**
(nenhuma foi totalmente perdida, diferente da primeira rodada, que perdeu 8 de 16). Mas
ainda com muita perda **parcial**: etapas grandes (17 com 97 livros esperados, 18, 19, 21,
23, 24) ficaram com só 1 livro cada — a aba trava, se recupera, mas ao se recuperar já pula
para a próxima etapa disponível na fila, abandonando a etapa anterior naquele ponto. Total do
ciclo: ~2059 UCs coletadas, bem abaixo do volume observado em execuções sequenciais bem
sucedidas.

Ao longo da rodada, praticamente **todas as 8 abas** passaram por "All promises were
rejected" dentro de uma janela de ~30 segundos — sinal mais forte ainda de sobrecarga real
sob 8 conexões simultâneas competindo pela mesma sessão, não um problema isolado de uma ou
duas abas.

Usuário sugeriu, antecipando esse cenário: se o erro continuar, reduzir para 5 abas pra ver
se fica mais administrável. Aplicado: `COPEL_PARALELISMO_ACOMP=5` no `.env` local (o default
do código, documentado em `.env.example`, continua 8 — essa é uma configuração empírica
específica deste ambiente/conta, não uma mudança de comportamento padrão). Dados do ciclo
anterior (incompleto) limpos da tabela antes de reiniciar.

Não validado ao vivo ainda com 5 abas — fica pra próxima execução confirmar se a frequência
de "All promises were rejected"/travamento cai o suficiente para completar mais livros por
etapa antes de pular para a próxima.

## Adendo — mesmo com 5 abas, `goto()` isolado às vezes não bastava; virou retry de 3 tentativas

Rodando com 5 abas, o diagnóstico dedicado (commit anterior) finalmente foi capturado num
caso real: depois do `page.goto(URL_ACOMPANHAMENTO)`, a URL estava **correta** (confirmado no
screenshot/texto), mas o corpo da página continuava vazio — sem o `select` de concessionária,
só o menu — mesmo depois dos 30s de auto-wait padrão do Playwright em cima do
`selectOption()`. Diferente do caso anterior (aba presa em `editarTarefasLeituraAction.do`),
aqui a navegação para a URL certa funcionou, mas o **servidor não devolveu a página
completa** — sinal de sobrecarga momentânea do lado dele, não um problema de navegação do
lado do cliente.

Extraída a lógica de recuperação para `recuperarAba(page, rotulo, estadoDiagnostico)`: agora
tenta `goto()` + `aplicarFiltroEBuscar()` até 3 vezes, com 3s de folga entre tentativas, antes
de desistir — tratando esse tipo de falha como transitório (o que é consistente com o padrão
observado: outras abas, no mesmo intervalo, continuavam funcionando normalmente). Diagnóstico
continua sendo salvo só na última tentativa, uma vez por aba.

Também reduzido `COPEL_PARALELISMO_ACOMP` para 5 (Adendo anterior) — mesmo assim, a
frequência de "All promises were rejected" observada com 5 abas pareceu proporcionalmente
parecida com a de 8, o que enfraquece um pouco a hipótese de que é *só* volume de conexões
simultâneas; pode haver um componente de instabilidade da rede/portal mais amplo, não
exclusivo da paralelização. Fica em aberto para as próximas execuções confirmarem com mais
dados.

`npm test` (12 testes) continua passando. Não validado ao vivo ainda com o retry de 3
tentativas — fica pra próxima execução do usuário.

## Adendo — fila por LIVRO em vez de fila por ETAPA (fim do desbalanceamento de carga)

Usuário colou o HTML real da página de Acompanhamento depois de uma busca, e apontou três
coisas que mudam a arquitetura da paralelização:

1. Depois da busca, **todas as etapas e todos os livros de cada uma já estão no DOM de uma
   vez só** — o clique em "ETAPA N - (M)" só alterna a visibilidade (`ShowHide()`, função do
   próprio site) de uma `<table id="item">` que já existe, com `style="display:none"`
   enquanto recolhida. Não é carregamento sob demanda por etapa — só a lista de *etapas* em
   si (os links) carrega aos poucos via scroll (Adendo acima); a tabela de livros de cada
   etapa que já apareceu vem inteira desde o início.
2. Com isso, não faz sentido a fila de trabalho ser por etapa inteira: basta ler os livros de
   todas as etapas de uma vez (leitura de texto/atributo não exige visibilidade, só
   `.click()` exige) e cada uma das 5 abas ir processando **livro por livro** de uma fila
   compartilhada única, não etapa por etapa.
3. Cuidado explícito pedido: nenhum livro pode ser importado duas vezes por abas diferentes.

Esse desenho resolve de raiz o problema relatado no Adendo "abas pareciam se revezar": a fila
por etapa causava desbalanceamento severo de carga — uma etapa com 4 livros (ETAPA 16) e uma
com 128 (ETAPA 24) contavam como "1 item" cada na fila, então a aba que pegava a etapa grande
ficava sozinha nela por muito mais tempo enquanto outras abas, com etapas pequenas, esgotavam
a fila e ficavam ociosas — não havia como "roubar" trabalho de uma etapa já em andamento em
outra aba.

### Mudanças em `copelScraperService.js`

- **`extrairOsId(href)`**: extrai o id da OS do `href="javascript:update('12105126', ...)"` do
  link "número da OS" de cada linha — identificador **globalmente único** por livro/OS,
  diferente do "número do livro" exibido (que é só um rótulo, não garantidamente único entre
  etapas). Vira a chave de identidade de cada item da fila.
- **`extrairLivrosDaEtapa(etapaLink, etapaNumero)`**: lê todas as linhas da tabela de uma
  etapa (visível ou não) e monta um array de `{osId, etapa, livro, localidade, ...}` — sem
  clicar/expandir a etapa.
- **Montagem da fila em `coletarDadosAcompanhamento()`**: antes de abrir as abas extras, itera
  sobre TODAS as etapas já carregadas na aba principal, chamando `extrairLivrosDaEtapa` em
  cada uma e concatenando os resultados em `filaLivros` (array achatado, um item por livro de
  todas as etapas). Substitui a antiga `filaEtapas` (array de números de etapa).
- **`processarLivro({page, alvo, registros, rotulo, estadoDiagnostico})`** substitui
  `processarEtapa()`: localiza a etapa do livro na própria página do worker (cada aba
  carregou sua cópia independente — mesmo raciocínio de sempre), garante que a tabela dessa
  etapa está visível (`garantirEtapaVisivel`, extraída da lógica que antes vivia dentro do
  loop de `processarEtapa`), localiza a linha certa comparando por `osId` (não por índice nem
  por número do livro — uma comparação imune a reordenação da lista entre leituras) e delega
  a `abrirEExtrairOs()` — o clique na OS, extração das UCs e fechamento (popup ou mesma
  página), também extraído do corpo antigo de `processarEtapa`.
- **`worker()`**: agora consome `filaLivros.shift()` em vez de `filaEtapas.shift()`. Como cada
  livro só existe **uma única vez** no array (montado numa única leitura, antes de qualquer
  aba extra abrir), a garantia contra double-processing (pedido 3 do usuário) vem de graça da
  própria estrutura de dados — não precisa de nenhum `Set`/lock adicional: um item só pode
  estar na fila ou já ter sido `shift()`ado por exatamente uma aba, nunca as duas coisas ao
  mesmo tempo (`Array.shift()` é síncrono em JS single-thread). `tentativasPorLivro` (Map
  chaveado por `osId`, substitui `tentativasPorEtapa`) limita a quantas vezes um livro pode
  voltar pra fila após falha (`MAX_TENTATIVAS_LOCALIZAR_LIVRO = 5`), mesmo raciocínio de
  antes, só que no grão certo agora.
- `garantirEtapaVisivel` deixou de ser uma função interna de `processarEtapa` (fechada sobre
  `etapa`/`totalLivrosInicial`) e virou uma função de nível de módulo, chamada por livro (já
  que livros consecutivos da fila podem pertencer a etapas diferentes, ao contrário do fluxo
  antigo onde uma aba ficava "presa" numa etapa só até ela esgotar).

### Efeito colateral positivo: paralelismo não fica mais limitado pelo número de etapas

Antes, `totalAbas = Math.min(paralelismoConfigurado, filaEtapas.length)` — com poucas etapas
(ex.: 2), no máximo 2 abas abriam, mesmo que houvesse centenas de livros no total. Agora o
mesmo cálculo usa `filaLivros.length`, então as 5 abas configuradas são usadas sempre que
houver pelo menos 5 livros no total, independente de quantas etapas existirem.

## Consequências

- Nenhuma mudança na lógica de extração de dados por livro (`extrairLinhasDetalheOs`,
  `aguardarTabelaEstabilizar`) nem na estrutura dos registros salvos — só a forma como o
  trabalho é distribuído entre abas mudou.
- `node --check` confirma sintaxe válida do arquivo reescrito.
- Não validado ao vivo nesta sessão — fica pra próxima execução do usuário confirmar que: (1)
  a fila por livro elimina o desbalanceamento observado antes (nenhuma aba grande "prende"
  as outras), (2) nenhum livro aparece duplicado no resultado final, (3) o volume total de
  UCs coletadas bate com o esperado.
