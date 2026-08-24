# Olho de Deus

Sistema interno de acompanhamento de leitura e releitura de medidores (livros) para
operações de leitura urbana e rural sob contrato com a Copel. Coleta dados automaticamente
do portal da Copel via scraping (Playwright), grava no Postgres da aplicação e expõe um
dashboard de atrasos por regional, etapa e empreiteira.

## O que não faz

Não emite fatura, não substitui os sistemas internos da Copel e não atende mais de um
cliente — é uma ferramenta interna, de uso único, para a equipe de coordenação/supervisão
de leitura.

## Arquitetura em 10 linhas

- **BACKEND** (`/BACKEND`) — API Node.js/Express, acesso ao Postgres direto via `pg`
  (node-postgres, sem ORM), autenticação por JWT com dois níveis (`ADMIN` / usuário
  comum), jobs agendados (`node-cron`) que disparam scraping Playwright do portal Copel em
  ciclo contínuo das 07h às 19h.
- **FRONTEND** (`/FRONTEND`) — SPA Angular 21, consome a API via `AuthGuard` + JWT
  armazenado no cliente, exibe dashboard de atrasos e telas de colaboradores/massivas.
- Banco de dados: em desenvolvimento, **Postgres local self-hosted via Supabase** (WSL2 +
  Docker) — o Supabase (Studio, Auth, PostgREST) só serve de ferramenta de gestão do banco;
  o app não passa por ele, conecta direto. Schema copiado por `pg_dump --schema-only` do
  banco de produção — sem dado. Detalhes em [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) e
  [ADR 0002](docs/adr/0002-postgres-local-via-supabase-sem-prisma.md).

## Como rodar

### Pré-requisito: Postgres local

O backend espera um Postgres local rodando (self-hosted via Supabase, dentro do WSL):

```bash
wsl -e bash -lc "cd ~/infra/eye-of-god && sh run.sh start"
```

Studio (gestão visual) fica em `http://localhost:8000`; o Postgres em si, exposto direto em
`localhost:55432` (não pela porta do pooler).

### Backend

```bash
cd BACKEND
npm install
cp .env.example .env   # preencher com as credenciais reais
npm run dev
```

### Frontend

```bash
cd FRONTEND
npm install
npm start
```

A API sobe em `http://localhost:3000` (ou `PORT` do `.env`); o frontend em
`http://localhost:4200`.

## Documentação

- [`docs/PRD.md`](docs/PRD.md) — problema, escopo, critérios de aceite
- [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) — diagramas (classes e fluxo crítico)
- [`docs/RBAC.md`](docs/RBAC.md) — papéis e permissões
- [`docs/CHECKLIST.md`](docs/CHECKLIST.md) — requisitos do padrão de projeto e status atual
- [`docs/painel.html`](docs/painel.html) — painel de acompanhamento (abrir no navegador)
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — como contribuir
- [`SECURITY.md`](SECURITY.md) — como reportar vulnerabilidade
