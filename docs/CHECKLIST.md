# Checklist — padrão de projeto (perfil `app-single-tenant`)

Fonte da verdade é [`docs/estado.json`](estado.json); este arquivo é a leitura humana.
Regenerar o painel visual com `node scripts/painel.mjs`.

| # | Requisito | Status | Detalhe |
|---|---|---|---|
| 1 | PRD | ✅ ok | `docs/PRD.md` — inclui fora de escopo |
| 2 | UML | ✅ ok | `docs/ARQUITETURA.md` — classDiagram + fluxo crítico |
| 3 | Repo + docs padrão | 🟡 parcial | git local ok; falta remote GitHub e proteção de branch |
| 4 | Matriz RBAC | 🟡 parcial | middleware existe, cobertura por rota não auditada |
| 5 | RLS por `user_id` | ⏳ pendente | avaliar em `/modelo-acesso` |
| 6 | Segredos | 🟡 parcial | histórico varrido (sem leak), hook + CI ativos, `JWT_SECRET` gerado; falta rotacionar senha do Postgres e credencial Copel |
| 7 | Módulos + flags | ⚪ na | não se aplica a single-tenant |
| 8 | Botão de erro | ⏳ pendente | ver `/observabilidade` |
| 9 | Testes | ⏳ pendente | ver `/testes` |
| 10 | Backup | ⏳ pendente | ver `/infra` |
| 11 | WAF / TLS / rate limit | ⏳ pendente | ambiente ainda é só dev local |
| 12 | LGPD | ⚪ na | não se aplica a single-tenant |

## Próximos passos (na ordem do ciclo)

1. **Você**: rotacionar a senha do Postgres (`DATABASE_URL`) e a credencial do portal
   Copel no painel de cada provedor — não é uma ação que a IA deve conduzir sozinha.
2. `/modelo-acesso` — formalizar a matriz RBAC e decidir se cabe RLS por `user_id`.
3. Configurar proteção de branch na `main` no GitHub (PR obrigatório, CI verde).
4. Novos clones devem rodar `git config core.hooksPath .githooks` para ativar o hook de
   proteção contra segredo (ver `CONTRIBUTING.md`).
