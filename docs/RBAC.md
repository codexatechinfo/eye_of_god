# RBAC — Olho de Deus

Perfil `saas-multi-cliente` (ver [ADR 0003](adr/0003-rbac-multi-tenant.md) — reclassificado
a partir do `app-single-tenant` original da [ADR 0001](adr/0001-perfil-e-caminho-dados.md)).
Isolamento é de dois tipos ao mesmo tempo: por **papel** (o que cada nível pode fazer) e por
**empresa** (cada empresa só vê o próprio dado, via `empresa_id` + RLS).

## Papéis

| Papel | Quem | Escopo |
|---|---|---|
| `ROOT` | Devs da Codexa | Global — todas as empresas |
| `ADMINISTRADOR` | Maior nível de cada empresa | Própria empresa, tudo |
| `SUPERVISOR` | Um nível abaixo do administrador | Própria empresa (granularidade fina pendente — ver "Em aberto") |
| `USUARIO` | Nível mais baixo | Própria empresa; escrita restrita ao próprio perfil |

## Matriz — recurso × ação × papel

Célula em branco = ninguém decidiu ainda = bloqueado por padrão (`exigirNivelMinimo` nega
o que não está explicitamente liberado).

| Recurso | Ação | ROOT | ADMINISTRADOR | SUPERVISOR | USUARIO |
|---|---|---|---|---|---|
| `empresas` | ler (a própria) | ✅ (todas) | ✅ | ✅ | ✅ |
| `empresas` | criar/editar | ✅ | ❌ | ❌ | ❌ |
| `users` | ler (da própria empresa) | ✅ (todas) | ✅ | ✅ | ✅ |
| `users` | criar | ✅ (qualquer empresa) | ✅ (só a própria) | ❌ | ❌ |
| `users` | editar nível/empresa/ativo de outro | ✅ | ✅ (só a própria empresa) | ❌ | ❌ |
| `users` (próprio) | editar `foto_perfil`/`preferencias` | ✅ | ✅ | ✅ | ✅ |
| `users` (próprio) | editar nível/empresa/senha | ✅ | — | ❌ | ❌ |
| Dashboard / coleta / colaboradores / massivas | ler | ✅ (com `?empresaId=`) | ✅ | ✅ | ✅ |
| `tenant_features` (módulos) | ler/alterar | ✅ | — (leitura só) | ❌ | ❌ |
| `audit_log` | ler (da própria empresa) | ✅ (todas) | ✅ | ❌ | ❌ |

## Implementação

- `BACKEND/src/middlewares/authMiddleware.js`:
  - `autenticarToken` — exige JWT válido; o payload carrega `sub` (id), `nivel`,
    `empresaId`.
  - `anexarContextoTenant` — abre uma transação no Postgres com `app.nivel`/
    `app.empresa_id` setados a partir do token, disponível em `req.db`; é isso que a RLS lê.
  - `exigirNivelMinimo(nivel)` — hierarquia `USUARIO < SUPERVISOR < ADMINISTRADOR < ROOT`;
    usado hoje só em `POST /usuarios`.
- Toda rota de negócio em `server.js` passa por `autenticarToken` + `anexarContextoTenant`
  antes de chegar no controller — não tem rota de dado desprotegida.

## RLS — onde a garantia de verdade mora

Documento aqui é intenção; o que vale é o banco. `~48` tabelas de negócio têm `empresa_id`
`not null`, RLS `enable` + `force`, e uma policy de isolamento (`ROOT` vê tudo, os demais só
a própria empresa) — nem `using` nem `with check` abrem exceção pra ausência de contexto.
7 tabelas de referência geográfica/calendário (compartilhadas entre empresas, não são dado
de uma empresa específica) ficam de fora de propósito: `cidades_localidades`,
`calendario_leitura`, `coordenadas_municipios`, `coordenadas_uc_livro`, `rota_seq`,
`tab_ligacao_coordenadas`, `lista_codigos_op`.

Prova automatizada em `BACKEND/test/isolamento_tenant.test.js` (`npm test`).

## Em aberto

- **Granularidade de `SUPERVISOR`** — o usuário sinalizou que "as atribuições ainda serão
  criadas em detalhe". Hoje `SUPERVISOR` tem as mesmas permissões efetivas de `USUARIO`
  além da leitura; a matriz linha a linha (o que especificamente um supervisor pode que um
  usuário comum não pode) fica pra quando isso for definido.
- **Coluna vs linha**: a restrição de `USUARIO` a só `foto_perfil`/`preferencias` é
  reforçada no código da rota (`PATCH /usuarios/me` só aceita esses dois campos, com
  `WHERE id = <do token>`), não por `GRANT` de coluna no Postgres — todo mundo conecta como
  o mesmo `app_user`, não há papel de banco por nível de aplicação. Ver ADR 0003.
