# Changelog

Este projeto segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e
[SemVer](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Adicionado

- Barra de % de execução abaixo do nome de cada colaborador na lista do Trilho; a lista
  passa a ordenar todos os filtros (Parado/Sem serviço/Ativo/Sem sincronismo e a lista sem
  filtro nenhum) pelos mais críticos primeiro (menor % dentro de cada categoria). Coluna
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
