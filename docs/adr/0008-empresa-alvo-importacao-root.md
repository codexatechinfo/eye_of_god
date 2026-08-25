# ADR 0008 — `empresaId` explícito na importação quando quem importa é ROOT

## Contexto

Usuário reportou `null value in column "empresa_id" of relation "atestados" violates
not-null constraint` ao tentar importar como `ROOT`. Causa: `ROOT` não tem empresa própria
(`empresaId` é `null` no token — ver [ADR 0003](0003-rbac-multi-tenant.md)), e
`importacaoController.js` sempre usava `req.usuario.empresaId` direto, sem o mesmo desvio
que `usuariosController.js`/`coletaController.js`/`dashboardController.js` já tinham pra
esse caso — brecha esquecida na hora de construir o [ADR 0005](0005-importacao-de-planilha.md).

## Decisão

- `importacaoController.js` ganhou a mesma regra das outras rotas: pra tabela com
  `empresa_id` (`temEmpresa: true`), `ROOT` informa a empresa via `?empresaId=` na URL; quem
  não é `ROOT` sempre usa a própria empresa do token, nunca aceita empresa vinda de
  parâmetro (senão um `ADMINISTRADOR` poderia gravar dado na empresa alheia só trocando o
  parâmetro). Falta de `empresaId` pra `ROOT` agora dá erro 400 limpo (`empresaId é
  obrigatório para ROOT nessa tabela`) em vez de estourar a constraint do Postgres.
- **`GET /empresas` novo** — lista as empresas que a RLS deixa o usuário ver (`ROOT` vê
  todas, os demais só a própria — nenhuma lógica de filtro no controller, a policy de
  `empresas` já resolve). Existe só pra alimentar o seletor do FRONTEND.
- FRONTEND: a tela de Importação mostra um seletor de "Empresa" só quando **as duas**
  condições valem — usuário é `ROOT` **e** a tabela escolhida não é compartilhada
  (`tabela.compartilhada === false`). Pra `ADMINISTRADOR`, nada muda — a empresa dele é
  usada sem perguntar, do mesmo jeito que já era.

## Consequências

- Testado: import sem `empresaId` como `ROOT` → 400 limpo; com `empresaId` → sucesso.
  Seletor de empresa aparece/some corretamente ao trocar de tabela no browser real.
- **Mesma brecha pode existir em qualquer rota nova que grave em tabela com `empresa_id`
  sem passar pelo padrão `exigirNivelMinimo` + "ROOT escolhe, os demais usam a própria"** —
  vale conferir isso toda vez que uma rota nova de escrita for criada.
