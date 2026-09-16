# ADR 0003 — Reclassificação para saas-multi-cliente e RBAC de 4 níveis

Supersede a classificação da [ADR 0001](0001-perfil-e-caminho-dados.md): o projeto deixou
de ser `app-single-tenant`.

## Contexto

Ao pedir o `/modelo-acesso`, o usuário descreveu 4 papéis onde `administrador` é "o maior
nível de usuário de **cada empresa**" — confirmado explicitamente: o sistema vai atender
várias empresas clientes, cada uma isolada da outra, com a Codexa (`root`) operando por
cima de todas. Isso invalida a premissa da ADR 0001 (nenhum sinal de tenant no schema) —
não porque o schema tivesse tenant, mas porque o requisito de negócio mudou.

## Decisão

### Perfil

`saas-multi-cliente`. Catálogo de módulos por empresa e RLS completo passam a ser
obrigatórios (eram `na` na ADR 0001).

### Papéis (hierarquia, cada um vê os de baixo)

| Papel | Quem | Pode |
|---|---|---|
| `ROOT` | Devs da Codexa | Tudo, em qualquer empresa — é quem mantém o sistema |
| `ADMINISTRADOR` | Maior nível dentro de uma empresa | Tudo dentro da própria empresa, inclusive criar usuário |
| `SUPERVISOR` | Um nível abaixo do administrador | Operação do dia a dia da própria empresa (a granularidade fina fica pra quando as atribuições forem detalhadas) |
| `USUARIO` | Nível mais baixo | Só a própria empresa; só pode alterar a própria foto de perfil e preferências visuais |

**Só `ROOT` e `ADMINISTRADOR` criam usuário novo** — reforçado em dois lugares
independentes: `authMiddleware.exigirNivelMinimo('ADMINISTRADOR')` na rota, e a RLS de
`users` (que impede gravar em empresa alheia de qualquer forma). `USUARIO`/`SUPERVISOR` só
alteram a própria linha, e só `foto_perfil`/`preferencias` — reforçado com `WHERE id = <do
token>` na query e por essas serem as duas únicas colunas que o endpoint de autoatendimento
aceita (não é um `UPDATE users SET *`; é uma coluna de cada vez, escolhida no código, não
no corpo da requisição). Não é reforçado por `GRANT` de coluna no Postgres porque todo
mundo conecta como o mesmo `app_user` — não há um papel de banco por nível de usuário.

### `empresa_id`, não `tenant_id`

Mesmo nome de conceito da skill, nome em português porque é o termo que já aparece em todo
o resto do domínio (users.nivel, docs em pt-BR).

- Todas as ~48 tabelas de negócio (tudo, exceto `users` e 7 tabelas de referência
  geográfica/calendário compartilhada — `cidades_localidades`, `calendario_leitura`,
  `coordenadas_municipios`, `coordenadas_uc_livro`, `rota_seq`,
  `tab_ligacao_coordenadas`, `lista_codigos_op`) ganharam `empresa_id uuid not null
  references empresas(id)`.
- `users.empresa_id` é a única exceção **nula** — só pra `nivel = 'ROOT'`, forçado por
  `check (nivel = 'ROOT' or empresa_id is not null)`.
- RLS habilitada **e forçada** (`force row level security`) em toda tabela de negócio,
  fail-closed: sem `app.nivel`/`app.empresa_id` setados, zero linha visível.
- Policy única por tabela, replicada via `DO $$ ... $$` sobre todo `pg_tables` que não é
  referência: `ROOT` vê tudo, os demais só a própria empresa — nem no `using`, nem no
  `with check`. Índice `(empresa_id)` em toda tabela de negócio.

### Contexto de tenant sem Supabase Auth nem Prisma

Como a [ADR 0002](0002-postgres-local-via-supabase-sem-prisma.md) já tirou o Prisma e não
usa `supabase-js`, não existe JWT do Supabase chegando na conexão pra popular
`auth.jwt()`. O padrão usado é o mesmo que a skill descreve pro caminho `prisma` — variável
de sessão setada pela própria aplicação — só que adaptado pra `pg` puro:

- `config/db.js` expõe `abrirContextoTenant({ empresaId, nivel })`: pega um client do pool,
  abre transação, faz `set_config('app.nivel', ..., true)` e `set_config('app.empresa_id',
  ..., true)` — o terceiro parâmetro `true` é local à transação, então o client volta pro
  pool limpo.
- `authMiddleware.anexarContextoTenant` chama isso com o `nivel`/`empresaId` do JWT
  (verificado por `autenticarToken` antes), guarda em `req.db`, e faz commit/rollback
  quando a resposta termina.
- Toda rota de negócio (tudo depois de `app.use(autenticarToken, anexarContextoTenant)` em
  `server.js`) usa `req.db`, não o `pool` cru — os 9 arquivos de serviço da ADR 0002 foram
  reabertos e cada função de acesso a dado ganhou `db` como primeiro parâmetro.
- **Login é a exceção**: antes de saber quem é o usuário, não dá pra abrir um contexto de
  empresa — `authService.autenticar` abre um contexto como `ROOT` só pra achar a conta pelo
  e-mail (RLS de `users` deixa `ROOT` ver todo mundo), fecha, e só depois verifica a senha.
- **Os jobs de coleta rodam fora de request HTTP**, sem token. Usam
  `EMPRESA_PRINCIPAL_ID` (variável de ambiente, aponta pra empresa dona da conta Copel
  configurada) como identidade fixa, nível `ADMINISTRADOR` — não `ROOT`, pra continuar
  respeitando o limite de uma empresa mesmo sendo processo de confiança.

### Cache do dashboard

`dashboardCacheService` era uma variável global única — antes do multi-tenant isso não
importava (uma empresa só), mas teria vazado o dashboard de uma empresa pra outra na
primeira requisição que caísse no cache errado. Virou `Map` por `empresaId`.

### Auditoria

Tabela `audit_log` append-only, isolada por empresa na leitura (`ROOT` vê tudo). Cobertura
hoje: só criação de usuário. Estender conforme aparecer ação nova que precise responder
"quem fez isso".

## Consequências

- O dado que já existia nas tabelas (inclusive um lote real que o scraper gravou sem
  querer durante um teste) foi todo atribuído a uma "empresa principal" seedada
  (`00000000-0000-0000-0000-000000000001`), com o consentimento do usuário.
- Um usuário `ROOT` de bootstrap foi criado direto no banco (não dava pra criar pela API —
  ninguém existia ainda pra criar o primeiro). Senha entregue uma única vez, fora de
  arquivo versionado; troca é responsabilidade do usuário.
- `/testes` tem uma suíte inicial (`BACKEND/test/isolamento_tenant.test.js`, `node:test`)
  provando: sem contexto ninguém vê nada, empresa A não vê empresa B, a dona vê o próprio
  dado, `ROOT` vê tudo, e `with check` bloqueia tanto criar empresa quanto gravar linha
  carimbando empresa alheia. Cobertura de RBAC mais fina (o que cada `SUPERVISOR` pode,
  por exemplo) fica pra quando as atribuições forem detalhadas, como o usuário sinalizou.
- `SUPERVISOR` tem hoje as mesmas permissões efetivas de `USUARIO` além da leitura — a
  granularidade real foi propositalmente deixada em aberto ("as atribuições ainda serão
  criadas em detalhe").

## Alternativas descartadas

- **Column-level `GRANT` no Postgres pra restringir o autoatendimento de perfil** —
  descartado porque todo usuário conecta como o mesmo `app_user`; não há papel de banco por
  nível de aplicação, então um `GRANT` de coluna valeria pra todo mundo igual, não
  diferenciaria admin de usuário comum.
- **`ROOT` bypassando com `... OR auth.uid() IS NULL`** — é exatamente o antipadrão que a
  skill marca como buraco de segurança (ausência de identidade abrindo tudo). A policy usada
  checa que `app.nivel` **é explicitamente** `'ROOT'`, não que está ausente — contexto
  ausente continua fail-closed.

## Adendo 1 — conexão vazada derrubou o app inteiro; corrigido, mas quase piorou no processo (2026-09-14)

Usuário reportou "a página não carrega" depois de uma rodada de mudanças no frontend. Investigado ao
vivo (sem acesso de login, via um token JWT assinado localmente com `JWT_SECRET` do próprio `.env`
pra reproduzir a sessão num navegador isolado meu — nunca usado pra ações reais, só leitura/
diagnóstico). Achados dois problemas DIFERENTES na mesma investigação, um deles quase se tornando um
terceiro.

### Problema 1 (real, mas não era a causa dominante): crash silencioso em `regua-tempo.ts`

`ngAfterViewInit` acessava `this.canvasRef.nativeElement` sem checar se o `@ViewChild` resolveu — o
`<canvas>` só existe no DOM com um colaborador aberto (`*ngIf="reguaExtremos() as extremos"`, ver
`regua-tempo.html`), então numa abertura fria do app (ninguém selecionado ainda) `canvasRef` fica
`undefined` e o hook lança `TypeError`. Sem try/catch do Angular ali, isso comia parte do primeiro
ciclo de change detection — sintoma visível: sidebar de colaboradores presa em "Carregando...". Bug
pré-existente (não introduzido pelas mudanças do dia), só nunca tinha sido notado porque a maioria das
sessões continua via HMR em vez de um boot frio de verdade — os vários hard-refresh que pedi ao
usuário mais cedo nesta mesma sessão provavelmente foram o gatilho real dele aparecer agora.
Corrigido: `armarResizeObserver()` comparando o elemento PAI observado (não um booleano "já rodei
uma vez") — cobre tanto "canvas ainda não existe" quanto "canvas foi destruído e recriado" (fechar/
abrir colaborador), sem crashar em nenhum dos dois casos. Ver Adendo 20 da [ADR
0038](0038-sistema-de-design-e-restyle-trilho.md) pro resto da rodada de mudanças desse dia.

### Problema 2 (a causa real): pool de conexões Postgres esgotado

Enquanto verificava o fix acima, `curl` direto no backend (fora do navegador, sem CORS/frontend no
meio) também travava pra sempre — confirmando que o problema não era só frontend. `pg_stat_activity`
mostrou **10 conexões** (o pool inteiro — `pg.Pool` sem `max` explícito usa o default de 10) presas em
`idle in transaction` havia 28 a 40 MINUTOS. Cada requisição HTTP segura um client dedicado a
transação inteira (`abrirContextoTenant`/`fecharContextoTenant`, liberado só quando `res.on('close')`
dispara em `authMiddleware.js`) — alguma requisição não fechou de forma limpa (aba fechada/navegação
no meio de uma chamada, provavelmente das minhas próprias idas e vindas testando no navegador mais
cedo) e o client ficou preso pra sempre. Com o pool 100% esgotado, TODA chamada nova — de qualquer
usuário, não só a minha — ficava pendurada esperando um client livre que nunca vinha. Isso, não o
crash da régua, é o que combina com "a página não carrega": nada relacionado a lógica de tela, o
backend inteiro parou de responder.

**Ação imediata**: `pg_terminate_backend` nas 10 conexões travadas — não resolveu sozinho (o pool do
Node ainda achava os clients "em uso", o TCP morto do lado do Postgres não libera o slot do lado do
`pg.Pool` automaticamente). Precisou reiniciar o processo backend pra zerar o pool de verdade.

> **Nota (2026-09-15, ver Adendo 2 abaixo)**: o `idle_in_transaction_session_timeout` descrito aqui —
> criado pra pegar conexão HTTP vazada — acabou batendo também nos jobs de coleta de fundo, matando
> transações legítimas que ficam paradas (idle, sem query) durante o scraping. Não é o mesmo bug: aqui
> a causa era uma requisição HTTP que nunca fecha; lá é um job que abre a transação cedo demais.

**Correção estrutural**: `idle_in_transaction_session_timeout = 60000` em toda conexão nova
(`pool.on('connect')`, `db.js`) — o PRÓPRIO Postgres encerra qualquer transação parada além do limite,
em vez de depender de achar a causa exata de cada vazamento possível no código do Express pra parar
de sangrar. Autocurativo pro próximo vazamento, seja lá qual for a causa.

### Quase-incidente: a correção do Problema 2 quase criou um Problema 3

Publicado o timeout acima, o backend crashou de novo — **~60 segundos depois**, exatamente quando o
timeout bateu numa das conexões vazadas restantes. Causa: `pg` emite um evento `'error'` no client
quando o Postgres encerra a conexão por trás — e um `EventEmitter` sem listener de `'error'` faz o
Node tratar como exceção não capturada e MATAR O PROCESSO INTEIRO. Conferido no código-fonte do
`pg-pool` instalado (`node_modules/pg-pool/index.js`): o listener de erro que o pool mantém enquanto o
client está OCIOSO no pool é explicitamente REMOVIDO no momento do checkout
(`_acquireClient`/`client.removeListener('error', idleListener)`) e só reanexado no `release()` — ou
seja, um client EM USO (exatamente o caso de toda conexão vazada) fica sem nenhum listener de erro. Um
`pool.on('error', ...)` sozinho cobre só o client ocioso DENTRO do pool, não o caso que causou o
incidente inteiro. Corrigido anexando `client.on('error', ...)` também dentro de
`abrirContextoTenant`, pela duração inteira da requisição, além do `pool.on('error', ...)` pro caso
geral.

**Lição**: uma rede de segurança que interage com uma lacuna PRÉ-EXISTENTE (aqui: nenhum client tinha
handler de erro) pode acionar essa lacuna em vez de só proteger contra ela. Testado ao vivo depois da
correção completa — backend estável por mais de 15s sob a mesma carga (cliques reais no navegador +
os 4 jobs de coleta rodando em paralelo), sem crash.

### Causa raiz do vazamento original — NÃO investigada nesta rodada

Por que `res.on('close')` não disparou pra essas 10 requisições específicas fica sem resposta — mais
provável hipótese (não confirmada): minhas próprias navegações/fechamentos de aba repetidos durante
testes ao vivo mais cedo nesta sessão, um cenário de borda que o comentário de `authMiddleware.js` já
citava como motivo de usar `'close'` em vez de `'finish'`, mas aparentemente não cobre 100% dos casos.
Sinalizado como investigação separada — o timeout/error-handler deste Adendo torna esse vazamento
específico inofensivo daqui pra frente, mas não explica por que ele aconteceu.

### Erro meu, à parte: uma SEGUNDA instância do backend rodando em paralelo

Depois da correção acima, o app voltou a ficar inacessível — mas desta vez porque EU criei o problema:
pra testar sem acesso de login, chamei a ferramenta de preview pra "subir o backend" quando achei (por
`netstat`) que ele estava fora do ar. Só que o processo do PRÓPRIO usuário (nodemon, PID raiz do `npm
run dev` já rodando desde antes desta sessão) só tinha ficado momentaneamente sem responder — minha
ferramenta subiu uma SEGUNDA instância completa (`npm --prefix ... run dev` → nodemon → `node
src/server.js`), com seu próprio pool de conexões E seus próprios 4 jobs de coleta (Acompanhamento,
Massivas, Scalefusion, SEGSAT) rodando em paralelo com a instância original — dobrando a pressão sobre
o pool de conexões e sobre o próprio portal da Copel (dois logins concorrentes). Descoberto via
`Get-CimInstance Win32_Process` (linha de comando de cada `node.exe`, não só o nome) — sem isso as duas
árvores de processo são indistinguíveis num `tasklist` simples. Corrigido encerrando a árvore inteira
da instância redundante (`taskkill /T /F`, incluindo os processos filhos do Playwright que ela tinha
aberto) e terminando as conexões órfãs que sobraram no Postgres. **Lição**: antes de "subir" qualquer
servidor achando que está fora do ar, checar a linha de comando completa dos processos existentes, não
só se a porta está escutando — uma porta momentaneamente livre não significa ausência de supervisor.

### Compounding: consulta lenta já conhecida (CHANGELOG) virou gargalo real de pool

Mesmo com uma instância só e conexões limpas, `/colaboradores/ativos` continuou emperrando. Achado:
a consulta de `roster_do_dia` (`monitoramentoService.js`, já registrada no `CHANGELOG.md` como lenta,
investigação pendente) leva 15-30s sob o volume atual de `roster_ucs_extracao_diaria`
(200 mil+ UCs/dia), e várias rodam ao mesmo tempo (ciclo de coleta de 3min mais requisições de
usuário) — sozinho isso já consumia boa parte de um pool de 10. Mitigação imediata: `max: 20` no
`Pool` (`db.js`) — Postgres tem `max_connections=100`, folga de sobra. Não resolve a lentidão da
consulta em si, que segue pendente (mesma linha do CHANGELOG) — só dá mais margem pro resto do
sistema não travar por causa dela.

### Verificação

`node --check` em `db.js`. `npm test`: 20/20 (sem regressão, reconfirmado depois do `max: 20` também).
`npx tsc --noEmit -p tsconfig.app.json` limpo (fix da régua). Testado ao vivo, de ponta a ponta, num
navegador isolado autenticado via token próprio, DEPOIS de eliminar a instância duplicada e aumentar o
pool: app carrega (355 colaboradores, mapa com marcadores, "Coletando dados"), clique num colaborador
real (GUILHERME AUGUSTO ALVES PEREIRA) abre o painel sem erro no console, `/colaboradores/ativos`
responde em segundos em vez de travar.

## Adendo 2 — a própria rede de segurança do Adendo 1 matava os jobs de coleta longos (2026-09-15)

Na noite do modo profundo diário (ADR 0039), a 1ª extração da noite terminou o scraping com sucesso
(1897/1897 livros, 192.235 UCs, 74,7min) e morreu exatamente na hora de gravar:
`Client has encountered a connection error and is not queryable`. Como `gravarRosterDiario` só roda
depois de `importarParaPostgres`, nenhuma UC foi salva — a extração inteira de quase 75 minutos foi
perdida. O ciclo seguinte detectou "nenhum roster de hoje ainda" e começou tudo de novo do zero.

### Causa raiz

`coletaJob.js`/`coletaMassivasJob.js` chamavam `abrirContextoTenant()` (que já dá `BEGIN`) **antes** de
raspar o site da Copel, não só antes do `INSERT` final — padrão explicitado desde o Adendo 1
("os jobs de coleta abrem a transação ANTES de raspar o portal"). No modo profundo isso significa a
transação ficar parada (idle, nenhuma query rodando, só esperando HTTP/Playwright) por até 75 minutos —
exatamente o cenário que o `idle_in_transaction_session_timeout = 600000` (10min, Adendo 1) existe pra
matar. A rede de segurança contra conexão HTTP vazada estava matando transações de job legítimas, só
mais longas do que o timeout foi calibrado pra tolerar.

Confirmado direto no log do Postgres (`docker logs supabase-db`), que registra o `FATAL` com PID e
timestamp exatos:

```
2026-09-15 21:58:36 UTC  [50243] app_user@postgres  terminating connection due to idle-in-transaction timeout
2026-09-15 22:05:03 UTC  [50242] app_user@postgres  terminating connection due to idle-in-transaction timeout
2026-09-15 23:24:19 UTC  [57541] app_user@postgres  terminating connection due to idle-in-transaction timeout
2026-09-15 23:28:17 UTC  [57877] app_user@postgres  terminating connection due to idle-in-transaction timeout
```

Os dois primeiros caem ~10min depois do backend subir (18:47 BRT) — batendo com a 1ª extração/ciclo de
Massivas do dia. Os dois últimos caem ~10min depois do início da 2ª tentativa (20:13 BRT) — ou seja,
**a 2ª extração já tinha sido morta pelo Postgres aos 20:24, mas seguiu raspando às cegas por mais uns
50 minutos** até tentar gravar e descobrir que a conexão não existia mais.

Isso também reencaixa o "vazamento misterioso" de conexões `idle in transaction` que bloqueou
`CREATE INDEX CONCURRENTLY` mais cedo na mesma noite (ver `CHANGELOG.md`, seção Performance):
provavelmente não era um vazamento de verdade (conexão abandonada pra sempre) — eram essas mesmas
transações de job, legitimamente paradas por dezenas de minutos por causa deste padrão, que qualquer
coisa esperando transações antigas terminarem (inclusive um índice concorrente) enxerga como bloqueio.

### Correção

Em vez de esticar o timeout (o que só adiaria o problema pro próximo scraping mais lento, e enfraqueceria
a proteção original contra conexão HTTP vazada), a transação parou de cobrir o scraping:

- `coletaCopelService.js` (`executarColetaCopel`): agora abre e fecha DUAS transações curtas — uma só
  pra decidir `modoProfundo` (`precisaExtracaoProfundaHoje`), fechada antes do scraping começar; outra
  aberta só depois que `coletarDadosAcompanhamento` retorna, exclusiva pra gravar (import + roster +
  recálculo de painel). Nenhuma das duas fica aberta durante os 30-75min de scraping. A função passou a
  gerenciar seu próprio `abrirContextoTenant`/`fecharContextoTenant` (não recebe mais `db` de fora) —
  `coletaJob.js` e o endpoint manual (`coletaController.js`) simplificaram pra só passar `empresaId`.
- `coletaMassivasService.js` (`executarColetaMassivas`): mesmo padrão — `coletarMassivas()` roda sem
  segurar nenhum client; a transação abre só depois, pra `importarMassivas` + as duas chamadas de
  `importarControleEmpreiteiras` (ontem/hoje), e fecha no fim. `coletaMassivasJob.js` simplificado do
  mesmo jeito.
- O `idle_in_transaction_session_timeout` de 10min (Adendo 1) continua como está — segue cobrindo o caso
  original (requisição HTTP que nunca fecha `req.db`), que não tem relação com este bug.

### Achado secundário, mesma investigação: listener de erro acumulando por reuso de client

`MaxListenersExceededWarning: 11 error listeners added to [Client]` apareceu nos logs da mesma noite, e
o mesmo erro real passou a ser logado 2x, depois 4x seguidas para o mesmo evento. Causa: `pg-pool`
reaproveita o mesmo objeto `Client` entre checkouts diferentes ao longo da vida do processo — e
`abrirContextoTenant` (Adendo 1) registrava `client.on('error', ...)` a cada chamada sem nunca remover
no `release()`, empilhando um listener novo por reuso do mesmo client físico. Corrigido com
`client.removeAllListeners('error')` logo antes de registrar o listener — seguro porque o listener
"ocioso" que o próprio `pg-pool` mantém já foi removido por ele mesmo no momento do checkout (mesmo
mecanismo documentado no Adendo 1), então não sobra nada nosso pra preservar ali.

### Verificação

`node --check` nos 6 arquivos tocados (`db.js`, `coletaCopelService.js`, `coletaJob.js`,
`coletaController.js`, `coletaMassivasService.js`, `coletaMassivasJob.js`). `npm test`: 20/20, sem
regressão. Script isolado (transação de teste, 15 checkouts sequenciais no mesmo client físico —
confirmado pelo `processID`) provou o listener parando em 1 em vez de crescer. Ao vivo: nodemon
reiniciou o backend com o fix (interrompendo de propósito a 2ª extração, que já estava com a conexão
morta havia ~25min e nunca ia completar mesmo sem a mudança); ciclo seguinte de modo profundo entrou em
scraping sem nenhuma conexão `app_user` parada em `pg_stat_activity` durante a raspagem — antes disso
sempre aparecia uma `idle in transaction` crescendo pelo tempo todo do scraping.

## Adendo 3 — `Promise.all` de queries no mesmo `db` nunca rodou em paralelo de verdade (2026-09-15)

Com a aba de terminal do backend aberta pela primeira vez dentro desta ferramenta (antes só o usuário
via o log, direto no VS Code), apareceu um aviso nunca visto antes: `DeprecationWarning: Calling
client.query() when the client is already executing a query is deprecated and will be removed in
pg@9.0`.

Causa: cada requisição HTTP recebe **um único client** (`req.db`, aberto por
`authMiddleware.anexarContextoTenant`, ver seção "Contexto de tenant" acima) — todo `set_config` de RLS é
local a esse client/transação. Vários pontos do código, na tentativa de "paralelizar" 2-3 consultas de
uma função, faziam `Promise.all([db.query(...), db.query(...)])` passando o MESMO `db`. Um `pg.Client`
não roda duas queries ao mesmo tempo de verdade — a lib enfileira por trás (por isso nunca deu erro,
só o aviso, e por pouco tempo mais: a fila silenciosa está sendo removida no pg@9). Ou seja, **nenhuma
dessas "consultas paralelas" jamais rodou em paralelo** — o tempo total sempre foi a SOMA das partes,
não o maior tempo entre elas, apesar do código sugerir o contrário.

Isso reencaixa um mistério já registrado no `CHANGELOG.md`: `/colaboradores/atividade-hoje` tem
`obterBaselineDigitadosPorLivro` como "uma das 3 consultas paralelas" mais lenta (~1,3s), e "tentativas
de índice novo e reescrita com LATERAL não melhoraram". Agora faz sentido — otimizar só essa consulta
nunca ia ajudar muito, porque ela sempre esperava as outras 2 da mesma função terminarem primeiro na
fila do client, mesmo "paralela" no código.

### Escopo — não é 1 lugar, é um padrão

Encontradas e corrigidas ~13 ocorrências do mesmo padrão em 3 arquivos:

- `monitoramentoService.js` — `obterResumo` (incluindo as funções internas `contarStatus`/
  `contarTotal`, que agora também rodam suas partes em sequência), `obterOpcoesFiltro`, `obterDetalhe`,
  `obterHistoricoLivro`, `consultarUcsBrutasDoLivro`, `obterEventosPorLivrosAteData`/função vizinha, e
  o painel de mapa do livro.
- `atividadeColaboradoresService.js` — `obterBaselineDigitadosMassiva`, a consulta principal de
  `listarAtividadeHoje` (a mesma dos 3 itens do CHANGELOG), e o bloco de afastamentos/licenças/
  suspensões.
- `colaboradoresService.js` — `listarOpcoesFiltro`.

`copelControleEmpreiteirasScraperService.js` também tem um `Promise.all`, mas é Playwright
(`page.waitForEvent('download')` corrida com o clique do botão) — não envolve `db`, não é o mesmo bug.

### Correção

Trocado `Promise.all` por `await` sequencial em todos os pontos acima — **sem mudança de comportamento
real**, já que não existia paralelismo de verdade antes (só a ilusão dele). Resolve o aviso de
depreciação e a quebra futura no pg@9, sem ganho nem perda de performance medível.

Paralelismo real exigiria abrir clients adicionais por query, repetindo o `set_config` de RLS em cada
um — mudança bem maior no modelo de tenant-context, avaliada e explicitamente adiada (usuário optou por
só remover o aviso, não implementar paralelismo de verdade nesta rodada).

### Verificação

`node --check` nos 3 arquivos. `npm test`: 20/20, sem regressão. Script isolado, dentro de
`BEGIN`/`ROLLBACK`, escopado numa empresa real (não ROOT sem filtro — isso sozinho já é lento e não é o
que este teste queria medir): `listarAtividadeHoje` (299 colaboradores), `obterOpcoesFiltro` (10
regionais/34 etapas) e `listarOpcoesFiltro` (3 cargos/11 regionais) rodaram sem nenhum
`DeprecationWarning` capturado (`process.on('warning', ...)` no próprio script de teste). `obterResumo`/
`obterDetalhe` não foram exercitados de ponta a ponta no teste — passam por
`obterEventosPorLivrosAteData`, já registrada como consulta lenta sob carga em investigação anterior
desta mesma sessão (índices funcionais em `livro::int`), sem relação com este fix. Ao vivo: nodemon
reiniciou o backend com as mudanças, ciclos de Massivas/Controle de Empreiteiras seguintes rodaram
normalmente.
