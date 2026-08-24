# ADR 0004 — Poda das tabelas não usadas

## Contexto

O schema copiado da produção ([ADR 0002](0002-postgres-local-via-supabase-sem-prisma.md))
trouxe 56 tabelas — a maioria delas de relatórios que essa aplicação nunca leu nem escreveu
(itens de multa, produtividade, folha, rota, etc.), herdadas por ter vindo de um
`pg_dump --schema-only` do banco de produção inteiro, não de um recorte do que o app usa.

## Decisão

O usuário definiu explicitamente as 12 tabelas de negócio que o app realmente usa:
`atestados`, `ativos_inativos`, `atribuidas_im`, `calendario_leitura`,
`cidades_localidades`, `contr_execucao_leitura`, `control_empreiteiras`, `em_execucao_im`,
`pendentes_im`, `prazo_reg_livros`, `suspensao`, `users`. As outras 43 foram removidas
(`DROP TABLE ... CASCADE`) do Postgres **local**.

Antes de apagar, confirmado por grep em todo `BACKEND/src` que nenhuma das 43 é referenciada
em rota, service ou controller — a remoção não quebra nada que já funcionava.

Mantidas também as 3 tabelas da [ADR 0003](0003-rbac-multi-tenant.md) (`empresas`,
`tenant_features`, `audit_log`) — não fazem parte do pedido do usuário, mas são a base do
RBAC/multi-tenant recém implementado; apagá-las quebraria login e isolamento entre
empresas. Confirmado explicitamente com o usuário antes de agir.

Total no Postgres local: 15 tabelas (12 de negócio + as 3 de RBAC).

## Consequências

- Produção (`10.60.0.9/FIMM_COPEL`) não foi tocada — a poda foi só no banco local. As 43
  tabelas continuam existindo lá, usadas por outros processos (relatórios de atraso de
  livros, `relatorio_jornada.py`).
- Se alguma feature futura precisar de uma tabela removida (ex.: multa, produtividade), o
  caminho é repetir o recorte do [ADR 0002](0002-postgres-local-via-supabase-sem-prisma.md)
  (`pg_dump --schema-only -t nome_da_tabela`) só para ela — não reimportar tudo de novo.
- `docs/RBAC.md`, `docs/ARQUITETURA.md` e `docs/estado.json`, que citavam "~48 tabelas de
  negócio" (ADR 0003), passam a refletir 12.
