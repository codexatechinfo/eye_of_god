# ADR 0007 — Restaura `tab_ligacao_coordenadas` e habilita importação por UC

## Contexto

`tab_ligacao_coordenadas` foi uma das 43 tabelas removidas do banco local na
[ADR 0004](0004-poda-de-tabelas-nao-usadas.md) por não estar na lista de 12 tabelas que o
usuário definiu como as realmente usadas. O usuário pediu de volta, já com importação por
planilha habilitada.

## Decisão

- Recriada exatamente como em produção — `pg_dump --schema-only -t tab_ligacao_coordenadas`
  de novo (mesma técnica da [ADR 0002](0002-postgres-local-via-supabase-sem-prisma.md)):
  3 colunas, `"UC"` (maiúsculo, precisa aspas em SQL), `latitude`, `longitude`. Sem coluna
  `id` — a tabela nunca teve chave primária em produção, e o import por `DELETE` + `INSERT`
  (ver abaixo) não precisa de uma.
- **Sem `empresa_id`** — mesma classificação de `cidades_localidades`/`calendario_leitura`
  (ADR 0003): é referência geográfica compartilhada entre empresas, não dado de uma
  empresa específica. Um import aqui afeta todas as empresas — o `compartilhada: true` que
  a API já devolvia pras outras duas referências cobre esse aviso automaticamente, sem
  precisar de código novo.
- Importação (`docs/adr/0005-importacao-de-planilha.md`): modo `upsert`, chave `UC` — linha
  do arquivo com a mesma UC de uma já existente substitui; UC nova acrescenta. Sem
  constraint `UNIQUE` na tabela, mesmo raciocínio das outras: o `DELETE ... USING
  unnest($1::text[])` seguido de `INSERT` já dá o efeito de upsert sem precisar de chave
  única no banco — o mecanismo genérico de `importacaoService.js` já suportava chave de
  uma coluna só e `temEmpresa: false` (era exatamente o caso de `calendario_leitura`), não
  precisou de nenhuma mudança de código, só a entrada nova em `importacaoConfig.js`.

Total de tabelas no banco local: 16 — 9 de negócio com `empresa_id` + `users` + 3 de
referência compartilhada (`calendario_leitura`, `cidades_localidades`,
`tab_ligacao_coordenadas`) + 3 de apoio ao RBAC (`empresas`, `tenant_features`,
`audit_log`).

## Consequências

- Testado ponta a ponta: import com UC repetida substitui a linha (coordenada antiga some),
  UC nova aparece, UC não mencionada no arquivo fica intocada — exatamente a regra pedida.
- Produção não foi tocada — só lida mais uma vez pra copiar a estrutura dessa tabela
  especificamente.
- **`id bigserial primary key` adicionado depois**, a pedido do usuário — pra ficar
  consistente com o padrão de toda outra tabela do banco local (`bigint` + sequence, PK).
  Pegadinha real encontrada no teste: `ALTER TABLE ... ADD COLUMN id bigserial` cria uma
  sequence nova, e o `GRANT` original na tabela (feito na criação) **não cobre sequence
  criada depois** — o import quebrou com `permission denied for sequence
  tab_ligacao_coordenadas_id_seq` até rodar `GRANT USAGE, SELECT ON SEQUENCE
  tab_ligacao_coordenadas_id_seq TO app_user` à parte. Vale lembrar disso sempre que uma
  coluna serial/identity for adicionada numa tabela que já existia.
