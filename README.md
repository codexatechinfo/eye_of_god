# Olho de Deus

Sistema interno de acompanhamento de leitura e releitura de medidores (livros) para
operações de leitura urbana e rural sob contrato com a Copel. Coleta dados automaticamente
do portal da Copel via scraping (Playwright), consolida com o banco de operação
(`BASE_DADOS`) e expõe um dashboard de atrasos por regional, etapa e empreiteira.

## O que não faz

Não emite fatura, não substitui os sistemas internos da Copel e não atende mais de um
cliente — é uma ferramenta interna, de uso único, para a equipe de coordenação/supervisão
de leitura.

## Arquitetura em 10 linhas

- **BACKEND** (`/BACKEND`) — API Node.js/Express, Prisma como client de acesso ao Postgres
  (schema introspectado, não gerenciado por migration), autenticação por JWT com dois
  níveis (`ADMIN` / usuário comum), jobs agendados (`node-cron`) que disparam scraping
  Playwright do portal Copel em ciclo contínuo das 07h às 19h.
- **FRONTEND** (`/FRONTEND`) — SPA Angular 21, consome a API via `AuthGuard` + JWT
  armazenado no cliente, exibe dashboard de atrasos e telas de colaboradores/massivas.
- Banco de dados: Postgres compartilhado com o data warehouse de relatórios da operação
  (schema `BASE_DADOS`) — o Prisma acessa tabelas que já existem fora do controle do app.
  Detalhes em [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md).

## Como rodar

### Backend

```bash
cd BACKEND
npm install
cp .env.example .env   # preencher com as credenciais reais
npx prisma generate
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
