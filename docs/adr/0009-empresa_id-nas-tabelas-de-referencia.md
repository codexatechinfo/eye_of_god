# ADR 0009 — `empresa_id` também em `calendario_leitura`, `cidades_localidades` e `tab_ligacao_coordenadas`

## Contexto

Essas 3 tabelas foram deixadas de fora do isolamento por empresa na
[ADR 0003](0003-rbac-multi-tenant.md) e na restauração da
[ADR 0007](0007-restaura-tab-ligacao-coordenadas.md), classificadas como
"referência compartilhada" — a premissa era que, como o sistema atendia um
único contrato (Copel/FIMM), o calendário de prazos, a lista de
cidade/localidade e as coordenadas de UC eram as mesmas pra quem quer que
estivesse lendo.

Usuário esclareceu que essa premissa não vale mais: cada empresa cliente do
SaaS pode atender contrato/região diferente, logo pode ter seu próprio
calendário de prazos, sua própria lista de localidades e suas próprias
coordenadas. Manter essas 3 tabelas compartilhadas faria o import de uma
empresa sobrescrever dado que outra empresa depende.

Banco local de dev estava vazio nas 3 tabelas e sem nenhuma empresa
cadastrada ainda (cópia de produção trouxe só estrutura, sem dados — ver
ADR 0002) — não houve necessidade de decidir migração de dado legado.

## Decisão

- `calendario_leitura`, `cidades_localidades` e `tab_ligacao_coordenadas`
  ganharam `empresa_id uuid not null references empresas(id)`, índice
  (`idx_<tabela>_empresa_id`), `enable`/`force row level security` e a
  mesma policy `isolamento_empresa` (`ROOT` vê tudo, os demais só a própria
  empresa) já usada nas outras 10 tabelas de negócio — sem exceção de
  "linha sem dono" no `using`/`with check`.
- `CONFIG_IMPORTACAO` (`temEmpresa: false` → `true` nas 3) foi a única
  mudança de código necessária no backend: `importacaoController.js` e
  `importacaoService.js` já eram genéricos sobre `temEmpresa` desde a
  [ADR 0008](0008-empresa-alvo-importacao-root.md) — `ROOT` agora também
  escolhe `?empresaId=` pra essas 3 tabelas, e o `DELETE`/`INSERT` do
  upsert passou a escopar por empresa automaticamente.
- FRONTEND não precisou de mudança de lógica — o seletor de empresa em
  `importacao-view.ts` já decide `precisaEscolherEmpresa()` a partir do
  campo `compartilhada` que vem do backend (`!temEmpresa`), não de uma
  lista fixa no código.
- `leituraUrbanaService.js` e `massivasService.js` fazem `LEFT JOIN
  cidades_localidades`/`calendario_leitura` sem filtro explícito de
  `empresa_id` na condição do `JOIN` — não precisou mudar: como essas
  consultas sempre rodam sobre `req.db` (conexão já dentro do contexto de
  tenant), a RLS filtra as linhas visíveis do lado direito do `JOIN`
  automaticamente, do mesmo jeito que qualquer outra tabela.
- Não há mais nenhuma tabela "compartilhada" no catálogo de importação —
  toda tabela de negócio hoje tem dono.

## Consequências

- Migration aplicada direto no Postgres local (sem arquivo de migration
  versionado no repo — o projeto ainda não tem uma ferramenta de migration,
  registrado como dívida em `docs/CHECKLIST.md`), via usuário `postgres`
  dentro do container `supabase-db` (o `app_user` de runtime não é dono das
  tabelas, não pode rodar DDL — ver `/infra`).
- Testado: `BACKEND/test/isolamento_tenant.test.js` ganhou 6 casos novos
  (fail-closed e isolamento cross-empresa nas 3 tabelas) — suíte completa
  (12 testes) passa. Testado também o caminho real de import (`ROOT` com
  `?empresaId=` grava só na empresa escolhida; outra empresa não enxerga a
  linha) direto contra `importacaoService.js`.
- **Cada empresa agora precisa importar seu próprio calendário de prazos,
  lista de localidades e coordenadas de UC** — não há mais um dado "de
  fábrica" compartilhado. Se uma empresa nova entrar sem importar essas 3
  planilhas, os `LEFT JOIN` em `massivasService.js`/`leituraUrbanaService.js`
  simplesmente não casam nada (campo fica `NULL`), não é erro — mas o
  relatório fica sem `local`/prazo até a empresa importar.
