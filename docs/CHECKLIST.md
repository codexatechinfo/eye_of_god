# Checklist — padrão de projeto (perfil `saas-multi-cliente`)

Reclassificado de `app-single-tenant` — ver [ADR 0003](adr/0003-rbac-multi-tenant.md).
Fonte da verdade é [`docs/estado.json`](estado.json); este arquivo é a leitura humana.
Regenerar o painel visual com `node scripts/painel.mjs`.

| # | Requisito | Status | Detalhe |
|---|---|---|---|
| 1 | PRD | ✅ ok | `docs/PRD.md` — inclui fora de escopo, atores multi-empresa |
| 2 | UML | ✅ ok | `docs/ARQUITETURA.md` — classDiagram + fluxo crítico |
| 3 | Repo + docs padrão | 🟡 parcial | git local ok; falta remote GitHub e proteção de branch |
| 4 | Matriz RBAC | ✅ ok | `docs/RBAC.md` — 4 papéis, matriz recurso×ação, aplicado em rota + RLS |
| 5 | `empresa_id` + RLS | ✅ ok | 13 tabelas (`enable`+`force`), testado (`BACKEND/test/isolamento_tenant.test.js`). Banco local podado pra só 15 tabelas no total — ver ADR 0004 |
| 6 | Segredos | 🟡 parcial | histórico varrido (sem leak), hook + CI ativos, `JWT_SECRET`/senha do Postgres local geradas; falta rotacionar senha do Postgres de **produção** e credencial Copel |
| 7 | Módulos + flags | ✅ ok | `tenant_features` criada (`docs/MODULOS.md`), sem módulo cadastrado ainda |
| 8 | Botão de erro | ⏳ pendente | ver `/observabilidade` |
| 9 | Testes | 🟡 parcial | isolamento de tenant coberto; resto (unit/E2E) ainda não — ver `/testes` |
| 10 | Backup | ⚪ na (dev) | ambiente `wsl-dev` — backup é opcional; obrigatório se algum dia isto virar `servidor-prod` |
| 11 | WAF / TLS / rate limit | ⏳ pendente | ambiente ainda é só dev local |
| 12 | LGPD | ⏳ pendente | agora multi-empresa com dado de colaborador (atestado, afastamento) — reavaliar, deixou de ser `na` |

## Banco local e multi-tenant (mudança de arquitetura)

`DATABASE_URL` aponta para um Postgres local self-hosted via Supabase (WSL, ADR 0002),
sem Prisma (`pg` direto). O schema (56 tabelas) foi copiado do banco de produção via
`pg_dump --schema-only`; o único dado real (um lote que o scraper gravou sem querer num
teste) foi atribuído à "empresa principal" seedada. O banco de produção
(`10.60.0.9/FIMM_COPEL`) continua intocado, usado só por outros processos (relatórios de
atraso de livros, `relatorio_jornada.py`).

O projeto virou `saas-multi-cliente` (ADR 0003): toda tabela de negócio tem `empresa_id` +
RLS forçada, 4 papéis (`ROOT`/`ADMINISTRADOR`/`SUPERVISOR`/`USUARIO`), autenticação por JWT
de verdade (antes existia o middleware mas não era usado em nenhuma rota — corrigido).

## Importação de planilha

`POST /importacao/:tabela` — sobe `.xlsx` pras 12 tabelas habilitadas, `ADMINISTRADOR`/`ROOT`
só, modo `substituir` ou `upsert` por chave composta conforme a tabela (ver
[ADR 0005](adr/0005-importacao-de-planilha.md)). Aba "Importação" no FRONTEND.

## Próximos passos (na ordem do ciclo)

1. **Você**: rotacionar a senha do Postgres de **produção** e a credencial do portal
   Copel no painel de cada provedor — não é uma ação que a IA deve conduzir sozinha.
2. **Você**: trocar a senha do usuário `ROOT` de bootstrap (`root@codexa.dev`), entregue
   uma única vez no chat.
3. Detalhar a granularidade fina do papel `SUPERVISOR` (hoje igual a `USUARIO` + leitura —
   ver `docs/RBAC.md`, seção "Em aberto").
4. `/lgpd` — reavaliar agora que virou multi-empresa com dado de colaborador.
5. Configurar proteção de branch na `main` no GitHub (PR obrigatório, CI verde).
6. Novos clones devem rodar `git config core.hooksPath .githooks` para ativar o hook de
   proteção contra segredo (ver `CONTRIBUTING.md`).
