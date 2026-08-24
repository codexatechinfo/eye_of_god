# Changelog

Este projeto segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e
[SemVer](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Adicionado

- Estrutura de documentação e governança do repositório (README, CONTRIBUTING, SECURITY,
  PRD, ARQUITETURA, RBAC, CHECKLIST, ADR, painel de acompanhamento).
- `.gitignore` na raiz cobrindo segredos, `node_modules`, build e artefatos do scraper.
- CI (`.github/workflows/ci.yml`) com lint/build/test para BACKEND e FRONTEND.
- Varredura de segredo no pre-commit e no CI via `gitleaks`.
- Postgres local self-hosted via Supabase (WSL2 + Docker), com schema copiado da produção
  (estrutura apenas, sem dado).

### Alterado

- **Removido o Prisma do BACKEND.** Acesso ao Postgres passou a ser direto via `pg`
  (node-postgres) — a lógica das ~11 consultas SQL complexas não mudou, só o driver. Ver
  [ADR 0002](docs/adr/0002-postgres-local-via-supabase-sem-prisma.md).
- `DATABASE_URL` de desenvolvimento passou a apontar para o Postgres local, não mais para o
  banco de produção compartilhado (`10.60.0.9/FIMM_COPEL`), que continua intocado.
- Código de erro de e-mail duplicado no cadastro: `P2002` (Prisma) → `23505` (Postgres).

## [0.1.0] - histórico anterior

- Backend Express + Prisma com autenticação JWT, scraping Copel (Playwright) e jobs
  agendados de coleta.
- Frontend Angular com login, dashboard e telas de colaboradores/massivas.
