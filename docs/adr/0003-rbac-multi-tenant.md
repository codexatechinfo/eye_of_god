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
