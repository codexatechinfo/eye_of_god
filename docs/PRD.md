# PRD — Olho de Deus

## Problema

A operação de leitura e releitura de medidores (livros) sob contrato com a Copel depende
de dados de execução (leitura feita, atraso, releitura pendente) que hoje vivem espalhados
entre o portal da Copel e planilhas manuais. Sem consolidação automática, a coordenação
descobre atraso tarde — depois que já virou multa ou não conformidade contratual.

## Fora de escopo

- Não emite fatura nem se conecta a sistema de faturamento.
- Não substitui nenhum sistema da Copel — apenas lê o que o portal expõe.
- Não faz o agendamento de leituristas em campo (isso é de outro sistema/processo).
- Não gera relatório de RH (atestados, férias, folgas) além de expor o dado já existente
  no banco — não há fluxo de aprovação desses eventos aqui.
- Não define hoje a granularidade fina de permissão do papel `SUPERVISOR` — as atribuições
  específicas ainda serão detalhadas (ver `docs/RBAC.md`, seção "Em aberto").

## Multi-empresa

Sistema SaaS: a Codexa (papel `ROOT`) opera a plataforma para várias empresas clientes,
cada uma com o próprio administrador, supervisores e usuários, isoladas umas das outras
(ver [ADR 0003](adr/0003-rbac-multi-tenant.md)). Cada empresa tem sua própria conta/contrato
Copel e enxerga só o próprio dado.

## Atores e jornadas

| Ator | Jornada principal |
|---|---|
| `ROOT` (devs Codexa) | Login → escolhe a empresa que quer ver → mesma jornada de administrador, em qualquer empresa; cria empresa nova e o primeiro administrador dela |
| `ADMINISTRADOR` (maior nível da empresa) | Login → dashboard de leitura urbana da própria empresa → identifica atraso por regional/etapa → cria usuário novo para a equipe |
| `SUPERVISOR` | Login → consulta dashboard e telas de colaboradores/massivas da própria empresa (granularidade fina pendente) |
| `USUARIO` | Login → consulta dashboard e telas de colaboradores/massivas da própria empresa; só pode alterar a própria foto de perfil e preferências visuais |
| Job de coleta (automático) | A cada ciclo (07h–19h), autentica no portal Copel com a credencial da empresa configurada, extrai pendentes/atribuídas/em execução/massivas, grava no Postgres já carimbado com a empresa, recalcula o cache do painel dela |

## Critérios de aceite por feature

- **Autenticação**: login com email/senha retorna JWT com `nivel` e `empresaId`; rotas
  protegidas rejeitam token ausente ou expirado; `POST /usuarios` rejeita quem não é
  `ADMINISTRADOR` ou `ROOT`.
- **Isolamento entre empresas**: nenhuma consulta de uma empresa retorna linha de outra —
  garantido por RLS no Postgres, não só por filtro na aplicação (ver `docs/RBAC.md`).
- **Coleta automática**: roda em loop entre 07h e 19h, não sobrepõe execuções concorrentes
  (`emAndamento`), e falha de um ciclo não derruba o processo nem impede o próximo.
- **Dashboard de leitura urbana**: serve dado do cache quando disponível; se o cache está
  vazio, recalcula sob demanda antes de responder.
- **Colaboradores/Massivas**: listagem reflete o estado mais recente importado do scraper.

## Sistemas externos

- **Portal Copel** — scraping via Playwright, autenticado com `COPEL_USERNAME` /
  `COPEL_PASSWORD`. Ponto único de falha do fluxo crítico.
- **Postgres** — em desenvolvimento, local self-hosted via Supabase; schema copiado por
  `pg_dump --schema-only` do banco de produção original (`BASE_DADOS`/`FIMM_COPEL`, usado
  também pelos relatórios de atraso de livros descritos no `CLAUDE.md` do usuário), que
  continua intocado. Acesso direto via `pg`, sem ORM (ver ADR 0002).

## Métrica de sucesso

Redução do tempo entre a leitura/releitura ficar em atraso no portal Copel e isso aparecer
no dashboard — hoje medido informalmente, meta é ficar defasado no máximo um ciclo de
coleta (≤ algumas horas dentro da janela 07h–19h).
