# Changelog

Este projeto segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e
[SemVer](https://semver.org/lang/pt-BR/).

## [Não lançado]

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
