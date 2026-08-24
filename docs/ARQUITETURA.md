# Arquitetura — Olho de Deus

## Visão geral

Monorepo com dois apps independentes (sem workspace compartilhado). Em desenvolvimento, o
Postgres é **local** — self-hosted via Supabase (WSL2 + Docker) — e o backend acessa direto
via `pg` (node-postgres), sem ORM. O Supabase self-hosted (Studio, Auth, PostgREST etc.) só
existe como ferramenta de gestão/visualização do banco; o app não passa por ele. Ver
[ADR 0002](adr/0002-postgres-local-via-supabase-sem-prisma.md).

```mermaid
classDiagram
  class FRONTEND_Angular {
    +Login
    +Home_Dashboard
    +AuthGuard
    +AuthService
  }
  class BACKEND_Express {
    +authRoutes
    +dashboardRoutes
    +coletaRoutes
    +colaboradoresRoutes
    +massivasRoutes
  }
  class authMiddleware {
    +autenticarToken()
    +exigirAdmin()
  }
  class coletaJob {
    +iniciarJobColeta()
    +loopContinuo()
  }
  class copelScraperService {
    +coletarDadosAcompanhamento()
  }
  class copelImportService {
    +importarParaPostgres()
  }
  class dashboardCacheService {
    +definir()
    +obter()
  }
  class PortalCopel {
    <<sistema externo>>
  }
  class Postgres_Local {
    <<self-hosted via Supabase, WSL>>
    +users
    +control_empreiteiras
    +pendentes_im
    +atribuidas_im
    +em_execucao_im
    +massivas
    +... 56 tabelas (schema copiado, sem dado)
  }

  FRONTEND_Angular --> BACKEND_Express : HTTP + JWT
  BACKEND_Express --> authMiddleware : usa
  BACKEND_Express --> Postgres_Local : pg.Pool (app_user)
  coletaJob --> copelScraperService : chama
  copelScraperService --> PortalCopel : Playwright
  copelScraperService --> copelImportService : registros
  copelImportService --> Postgres_Local : grava staging
  coletaJob --> dashboardCacheService : atualiza cache
```

## Fluxo crítico — coleta automática e atualização do painel

Se este fluxo quebra, o dashboard fica com dado velho e a coordenação volta a descobrir
atraso tarde — é o problema que o sistema existe para resolver.

```mermaid
sequenceDiagram
  participant Cron as node-cron (07h–19h)
  participant Job as coletaJob
  participant Scraper as copelScraperService
  participant Copel as Portal Copel
  participant Import as copelImportService
  participant DB as Postgres local (app_user)
  participant Cache as dashboardCacheService
  participant API as dashboardController
  participant UI as Frontend

  Cron->>Job: dispara loopContinuo()
  loop dentro da janela 07h–19h
    Job->>Scraper: coletarDadosAcompanhamento()
    Scraper->>Copel: login (COPEL_USERNAME/PASSWORD)
    alt login falha
      Scraper-->>Job: erro + screenshot em diagnosticos/
      Job->>Job: log erro, segue para próximo ciclo
    else login ok
      Copel-->>Scraper: dados de pendentes/atribuídas/em execução/massivas
      Scraper-->>Job: registros
      Job->>Import: importarParaPostgres(registros)
      Import->>DB: grava tabelas de staging
      Job->>Job: calcularLeituraUrbana()
      Job->>Cache: definir({ leituraUrbana })
    end
    Job->>Job: aguarda PAUSA_ENTRE_CICLOS_MS
  end

  UI->>API: GET /dashboard/leitura-urbana
  API->>Cache: obter()
  alt cache vazio
    API->>DB: recalcula sob demanda
  end
  Cache-->>API: payload
  API-->>UI: JSON com atraso por regional/etapa
```

## Decisões registradas

- [ADR 0001](adr/0001-perfil-e-caminho-dados.md) — perfil `app-single-tenant`.
- [ADR 0002](adr/0002-postgres-local-via-supabase-sem-prisma.md) — Postgres local
  self-hosted via Supabase, acesso direto por `pg`, sem Prisma.
