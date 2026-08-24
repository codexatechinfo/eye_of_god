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
| 6 | Segredos | ⏳ pendente | `.env` sem rotação, `JWT_SECRET` ausente — ver `/segredos` |
| 7 | Módulos + flags | ⚪ na | não se aplica a single-tenant |
| 8 | Botão de erro | ⏳ pendente | ver `/observabilidade` |
| 9 | Testes | ⏳ pendente | ver `/testes` |
| 10 | Backup | ⏳ pendente | ver `/infra` |
| 11 | WAF / TLS / rate limit | ⏳ pendente | ambiente ainda é só dev local |
| 12 | LGPD | ⚪ na | não se aplica a single-tenant |

## Próximos passos (na ordem do ciclo)

1. `/segredos` — rotacionar credencial do banco e do portal Copel (estavam sem
   `.gitignore` protegendo o arquivo até esta regularização), gerar `JWT_SECRET`.
2. `/modelo-acesso` — formalizar a matriz RBAC e decidir se cabe RLS por `user_id`.
3. Quando `gh` estiver disponível: criar o remote GitHub e configurar proteção de branch
   na `main` (PR obrigatório, CI verde).
