# Catálogo de módulos — por empresa

Perfil `saas-multi-cliente` (ver [ADR 0003](adr/0003-rbac-multi-tenant.md)): módulo liga e
desliga por empresa via linha na tabela, não constante no código — ativar/desativar é um
`UPDATE`, não um deploy.

```sql
create table tenant_features (
  empresa_id uuid not null references empresas(id),
  module_key text not null,
  enabled    boolean not null default false,
  primary key (empresa_id, module_key)
);
```

Já criada (`docs/adr/0003-rbac-multi-tenant.md`), com RLS: `ROOT` lê e altera qualquer
linha; cada empresa só lê a própria; ninguém além de `ROOT` grava.

## Módulos hoje

Nenhum `module_key` definido ainda — o sistema inteiro (coleta, dashboard, colaboradores,
massivas) é único, sem separação por módulo. Cadastrar aqui conforme surgir funcionalidade
que faça sentido ligar só para algumas empresas (ex.: se um cliente não usa "massivas",
desligar o módulo em vez de esconder na tela).
