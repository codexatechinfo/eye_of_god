# ADR 0001 — Perfil do projeto e caminho de dados

## Contexto

O repositório já existia com backend (Express + Prisma) e frontend (Angular) funcionando,
mas sem `.gitignore`, sem documentação e sem repositório GitHub remoto configurado. Era
necessário classificar o projeto para saber que padrões de RBAC/RLS/testes exigir.

## Decisão

- **Perfil: `app-single-tenant`.** O schema Prisma (59 modelos) não tem nenhuma coluna ou
  tabela de tenant/empresa/cliente; a tabela `users` tem só `nivel` (ADMIN / comum). É uso
  interno de uma única operação. Por isso o catálogo de módulos com flag por cliente e RLS
  por `tenant_id` não se aplicam — RBAC por papel é suficiente.
- **Caminho de dados: `prisma`**, mas em modo introspecção, não migration. O
  `schema.prisma` foi gerado a partir de um banco Postgres que já existe e é compartilhado
  com o data warehouse de relatórios da operação (schema `BASE_DADOS`/`FIMM_COPEL`) — a
  maioria das 59 tabelas não pertence à aplicação, pertence ao processo de relatório mais
  amplo. Isso significa que **não há migration do Prisma a aplicar**: alterar o schema
  aqui não altera o banco, e rodar `prisma migrate` contra esse banco seria destrutivo para
  tabelas de que o app nem é dono.
- **Ambiente**: máquina Windows local do desenvolvedor — tratado como ambiente de
  desenvolvimento (achados de segurança pontuam e informam, não bloqueiam), não como
  servidor de produção.

## Consequências

- `/modelo-acesso` deve desenhar RBAC sem RLS/tenant_id — o isolamento aqui é só de papel.
- `/seguranca` deve avaliar o banco pelo que ele é: compartilhado, fora do controle de
  migration do app, com credencial de acesso amplo — não pelo padrão de "app dono do
  schema".
- `/segredos` tem trabalho imediato: `BACKEND/.env` tem credencial de banco e do portal
  Copel em texto puro, sem `.gitignore` até agora protegendo o arquivo, e o código usa
  `JWT_SECRET` que não está definido no `.env` atual.

## Alternativas descartadas

- **`saas-multi-cliente`** — descartado por não haver nenhum sinal de tenant no schema nem
  no código; forçaria RLS e catálogo de módulos sem necessidade real.
- **Migrar para `caminho_dados: supabase-js`** — descartado porque o app já usa Prisma
  funcionando; reescrever a camada de dados de um sistema em produção é risco sem retorno
  (regra do preflight).
