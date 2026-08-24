# ADR 0002 — Postgres local via Supabase self-hosted, sem Prisma

Supersede parcialmente a [ADR 0001](0001-perfil-e-caminho-dados.md): o raciocínio de lá
("não reescrever uma camada de dados que já funciona em produção") deixou de valer porque
a decisão nova, tomada pelo usuário, foi justamente parar de apontar para o banco de
produção compartilhado.

## Contexto

O backend conectava direto no Postgres de produção (`10.60.0.9/FIMM_COPEL`), o mesmo banco
usado pelo data warehouse de relatórios da operação (schema `BASE_DADOS`, fora do escopo
deste app). O usuário decidiu que o ambiente de desenvolvimento deve ter seu **próprio**
Postgres local, sem depender do banco de produção — e explicitamente pediu para não usar
mais o Prisma.

## Decisão

- **Postgres local, subido via stack self-hosted do Supabase** (WSL2 + Docker, ver
  `~/infra/eye-of-god` dentro da distro), provisionado pela skill `/infra`. Porta exposta
  diretamente pelo container `db` em `55432` (não pelo pooler Supavisor, que fica em
  `65432` — a porta 5432 padrão já estava ocupada por um Postgres nativo do Windows nesta
  máquina).
- **O app conecta direto no Postgres via `pg` (node-postgres), sem Prisma e sem
  `@supabase/supabase-js`/PostgREST.** O Supabase self-hosted (Studio, PostgREST, Auth
  etc.) existe só como ferramenta de gestão/visualização do banco — não é o caminho de
  acesso a dado da aplicação. Motivo: quase todo o código já era SQL cru parametrizado via
  `prisma.$queryRawUnsafe` (UNION ALL dinâmico entre tabelas, `DISTINCT ON`, nome de tabela
  variável em runtime) — coisa que a API do PostgREST/supabase-js não expressa. Levar isso
  pra `.rpc()` exigiria transformar ~11 consultas em functions no Postgres, um trabalho bem
  maior que o pedido: só tirar o Prisma.
- **Schema recriado por `pg_dump --schema-only` da produção**, restaurado no banco local —
  56 tabelas, só estrutura, **sem dado nenhum**. O usuário escolheu explicitamente não
  copiar os dados reais.
- **Três papéis de banco** (seguindo o padrão da `/infra`): `migrator` (DDL/schema),
  `app_user` (runtime da aplicação — é quem está no `DATABASE_URL` do `.env`), `readonly`
  (relatório/BI). `service_role` do Supabase tem `BYPASSRLS` e acesso total — só é
  relevante se algo um dia usar o PostgREST; hoje não é usado pelo app.

## Consequências

- **O banco local está vazio.** O dashboard e as listagens não mostram nada até o job de
  coleta (scraper Copel) rodar e popular as tabelas de novo, ou até alguém decidir importar
  dado real depois — decisão nova, não tomada aqui.
- **O banco de produção (`10.60.0.9/FIMM_COPEL`) não foi alterado.** Só foi lido uma vez
  (`pg_dump --schema-only`) para copiar a estrutura. Os relatórios de atraso de livros e o
  `relatorio_jornada.py` do usuário, que também usam esse banco, não são afetados.
- `docker-compose.yml` da stack Supabase tem duas edições manuais em relação ao padrão
  oficial: porta do `db` publicada explicitamente (`55432:5432`) e porta do `supavisor`
  fixada em `65432` em vez de `${POSTGRES_PORT}` — para não colidir com o Postgres nativo
  do Windows na 5432. Registrado aqui porque não é óbvio olhando só o `.env`.
- `@prisma/client`, `@prisma/adapter-pg` e `prisma` saíram do `package.json`. `pg` já era
  dependência (usado pelo adapter do Prisma) e virou o único client de banco.
- Erro de e-mail duplicado no cadastro mudou de `erro.code === 'P2002'` (Prisma) para
  `erro.code === '23505'` (código Postgres nativo de `unique_violation`).

## Alternativas descartadas

- **`@supabase/supabase-js` para tudo, com as consultas complexas viradas function +
  `.rpc()`** — descartado por ora pelo tamanho do trabalho (~11 functions, risco de
  divergência sutil na lógica de dedup/prazo). Fica como possibilidade futura se o app
  precisar mesmo de RLS por request via PostgREST.
- **Manter Prisma, só trocar o host do banco** — descartado porque o usuário pediu
  explicitamente para não usar mais Prisma.
