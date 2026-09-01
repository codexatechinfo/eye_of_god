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

## Adendo 1 — `control_empreiteiras` removida (superada por `base_dados_leitura`)

Usuário pediu pra apagar `control_empreiteiras` e atualizar o modelo de importação/exportação
(`importacaoConfig.js`, que também alimenta o gerador de planilha de exemplo — `GET
/importacao/exemplo`, `gerarExemploTodasTabelas`). Uma das 12 tabelas originais desta ADR,
`control_empreiteiras` foi **superada** pela ADR 0024 (`base_dados_leitura`, réplica exata da
mesma estrutura, criada especificamente pra substituí-la — data/hora reais de leitura em vez do
ciclo de raspagem, ver ADR 0025) e desde então não era mais escrita nem lida por nenhuma
consulta do app; só sobrava referenciada no allowlist de importação.

Confirmado antes de apagar: tabela com **0 linhas** (já não recebia dado há tempos), nenhuma FK
de outra tabela apontando pra ela, nenhuma view dependente. `DROP TABLE control_empreiteiras`
executado. Entrada correspondente removida de `importacaoConfig.js` (`CONFIG_IMPORTACAO`) — o
gerador de planilha de exemplo é inteiramente derivado desse config
(`Object.entries(CONFIG_IMPORTACAO)`), então a tabela também deixou de aparecer no dropdown da
aba Importação e nos modelos/exemplos baixáveis sem precisar tocar em código além do config.

### Verificação

- `node --check` no config alterado, `npm test` (12/12)
- `information_schema`/`pg_tables` confirmando a tabela removida
- `gerarExemploTodasTabelas` testado direto contra o banco depois da remoção — continua
  gerando o arquivo normalmente (13 tabelas restantes no modelo, `control_empreiteiras`
  ausente, `base_dados_leitura` presente)
