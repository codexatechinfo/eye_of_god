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
