# PRD — Olho de Deus

## Problema

A operação de leitura e releitura de medidores (livros) sob contrato com a Copel depende
de dados de execução (leitura feita, atraso, releitura pendente) que hoje vivem espalhados
entre o portal da Copel e planilhas manuais. Sem consolidação automática, a coordenação
descobre atraso tarde — depois que já virou multa ou não conformidade contratual.

## Fora de escopo

- Não emite fatura nem se conecta a sistema de faturamento.
- Não substitui nenhum sistema da Copel — apenas lê o que o portal expõe.
- Não atende mais de um cliente/empreiteira — é uso interno, single-tenant.
- Não faz o agendamento de leituristas em campo (isso é de outro sistema/processo).
- Não gera relatório de RH (atestados, férias, folgas) além de expor o dado já existente
  no banco — não há fluxo de aprovação desses eventos aqui.

## Atores e jornadas

| Ator | Jornada principal |
|---|---|
| Coordenador (`ADMIN`) | Login → dashboard de leitura urbana → identifica atraso por regional/etapa → registra justificativa/tratamento |
| Usuário comum | Login → consulta dashboard e telas de colaboradores/massivas — sem ação administrativa |
| Job de coleta (automático) | A cada ciclo (07h–19h), autentica no portal Copel, extrai pendentes/atribuídas/em execução/massivas, grava no Postgres, recalcula o cache do painel |

## Critérios de aceite por feature

- **Autenticação**: login com email/senha retorna JWT; rotas protegidas rejeitam token
  ausente ou expirado; rota administrativa rejeita usuário sem `nivel = ADMIN`.
- **Coleta automática**: roda em loop entre 07h e 19h, não sobrepõe execuções concorrentes
  (`emAndamento`), e falha de um ciclo não derruba o processo nem impede o próximo.
- **Dashboard de leitura urbana**: serve dado do cache quando disponível; se o cache está
  vazio, recalcula sob demanda antes de responder.
- **Colaboradores/Massivas**: listagem reflete o estado mais recente importado do scraper.

## Sistemas externos

- **Portal Copel** — scraping via Playwright, autenticado com `COPEL_USERNAME` /
  `COPEL_PASSWORD`. Ponto único de falha do fluxo crítico.
- **Postgres compartilhado** (`BASE_DADOS` / `FIMM_COPEL`) — mesmo banco usado pelos
  relatórios de atraso de livros descritos no `CLAUDE.md` do usuário; o Prisma acessa um
  schema que já existe fora do controle de migration do app.

## Métrica de sucesso

Redução do tempo entre a leitura/releitura ficar em atraso no portal Copel e isso aparecer
no dashboard — hoje medido informalmente, meta é ficar defasado no máximo um ciclo de
coleta (≤ algumas horas dentro da janela 07h–19h).
