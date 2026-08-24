# RBAC — Olho de Deus

Perfil `app-single-tenant`: um cliente único, sem isolamento por tenant. O controle é só
de papel (RBAC), não de dado por cliente.

## Papéis

| Papel (`nivel`) | Pode |
|---|---|
| `ADMIN` | Tudo que o usuário comum pode, mais: rotas atrás de `exigirAdmin` (gestão de colaboradores, ajustes administrativos) |
| usuário comum | Login, consulta ao dashboard, telas de colaboradores/massivas em modo leitura |

## Implementação atual

- `BACKEND/src/middlewares/authMiddleware.js`:
  - `autenticarToken` — exige JWT válido (`Authorization: Bearer <token>`) em toda rota
    protegida.
  - `exigirAdmin` — exige `req.usuario.nivel === 'ADMIN'`, aplicado depois de
    `autenticarToken`.
- O `nivel` vem do payload do JWT, definido no cadastro (`authService.criarUsuario`).

## Lacuna conhecida

Nem toda rota sob `/colaboradores`, `/massivas`, `/coleta` e `/dashboard` foi auditada uma
a uma para confirmar que `autenticarToken`/`exigirAdmin` estão aplicados onde deveriam —
isso é trabalho da skill `/modelo-acesso`, encadeada ao final deste ciclo.
