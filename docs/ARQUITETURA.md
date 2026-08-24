# Arquitetura — Olho de Deus

## Visão geral

Monorepo com dois apps independentes (sem workspace compartilhado) e um Postgres externo
que também serve como data warehouse de relatórios da operação.

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
  class Postgres_BASE_DADOS {
    <<banco compartilhado>>
    +users
    +control_empreiteiras
    +pendentes_im
    +atribuidas_im
    +em_execucao_im
    +massivas
    +... 50+ tabelas de relatório
  }

  FRONTEND_Angular --> BACKEND_Express : HTTP + JWT
  BACKEND_Express --> authMiddleware : usa
  BACKEND_Express --> Postgres_BASE_DADOS : Prisma
  coletaJob --> copelScraperService : chama
  copelScraperService --> PortalCopel : Playwright
  copelScraperService --> copelImportService : registros
  copelImportService --> Postgres_BASE_DADOS : grava staging
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
  participant DB as Postgres (BASE_DADOS)
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

Ver [`docs/adr/0001-perfil-e-caminho-dados.md`](adr/0001-perfil-e-caminho-dados.md) para a
justificativa do perfil `app-single-tenant` e do caminho de dados Prisma em modo
introspecção (sem migration).
