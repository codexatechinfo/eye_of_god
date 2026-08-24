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

## [0.1.0] - histórico anterior

- Backend Express + Prisma com autenticação JWT, scraping Copel (Playwright) e jobs
  agendados de coleta.
- Frontend Angular com login, dashboard e telas de colaboradores/massivas.
