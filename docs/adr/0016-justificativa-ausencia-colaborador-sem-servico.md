# ADR 0016 — Indicador de ausência justificada na lista de colaboradores "sem serviço"

## Contexto

Três pedidos relacionados: 1) colaborador "sem serviço" que tem justificativa de ausência
deve ter um indicador visível de cara na lista (sem precisar expandir); 2) uma segunda fonte
de justificativa, além de `atestados` (que já alimentava o card "Ausência justificada" na
visão expandida): `ativos_inativos.situacao` no formato `"A2 - DD/MM/YYYY"` indica
afastamento a partir dessa data, com `volta_afastamento` trazendo a data de retorno
(`"YYYY-MM-DD"`) ou o texto `"INDETERMINADO"`; só conta se hoje cai dentro do período; 3)
destaque visual adicional quando `atestados.afastado_INSS = 'SIM'`.

## Decisão

### Segunda fonte de justificativa — `ativos_inativos.situacao`

Conferido contra dado real antes de implementar: `situacao` tem só 3 padrões na prática —
`"ATIVO"`, `"INATIVO"`, ou `"A2 - DD/MM/YYYY"` (10 variações de data na amostra, todas no
mesmo formato). `volta_afastamento` é texto livre com datas `"YYYY-MM-DD"` ou o literal
`"INDETERMINADO"`.

Nova função `obterLicencasAtivosInativosHoje(db)` em `atividadeColaboradoresService.js`,
mesma estrutura de `obterAfastamentosHoje` (que já lia `atestados`): extrai a data de início
via regex, só inclui quando `hoje >= data_início` e (`volta_afastamento` indeterminado OU
`hoje < data_retorno`). As duas fontes são mescladas em `listarAtividadeHoje` — `atestados`
tem prioridade (tem motivo/INSS, mais detalhado); `ativos_inativos` só preenche quem não
tinha nada em `atestados`. `AfastamentoInfo` (FRONTEND) ganhou `origem: 'atestado' |
'licenca'` e `dataRetorno`/`qtdDiasAfastado`/`afastadoInss` viraram nullable (licença não tem
motivo nem contagem de dias, e pode ter retorno indeterminado).

### Bug descoberto no meio do caminho: afastado nem aparecia na lista

Implementado o indicador, testado ao vivo, e o ícone não aparecia pra ninguém da nova fonte.
Causa: `colaboradoresService.js` (`listarAtivos`, a query que alimenta a lista inteira do
Trilho) filtra `WHERE situacao = 'ATIVO'` — colaborador com `"A2 - ..."` nunca entra na
lista base, então o indicador nunca teria onde aparecer, por mais correto que o cálculo de
`afastamentosHoje` estivesse. Corrigido incluindo também quem está afastado **e o
afastamento vale hoje** — mesma regra de "contempla hoje" replicada em SQL
(`CONDICAO_AFASTADO_HOJE`, compartilhada entre `listarAtivos` e `listarOpcoesFiltro` pra
cargo/regional de afastados também aparecerem nos filtros). Replicar a regra em SQL (em vez
de reaproveitar a função JS) foi necessário porque `listarAtivos` roda antes de qualquer
cálculo de atividade — é a lista BASE que decide quem existe na tela.

### Indicador visual — ícone, não card

Ícone pequeno (mesmo `<svg>` de documento já usado no card "Ausência justificada"
expandido) ao lado do nome, só quando `!atividadeDe(nome) && afastamentoDe(nome)` — ou seja,
só pra quem está "sem serviço" E tem justificativa. Azul por padrão; **roxo** quando
`afastadoInss === 'SIM'` (pedido 3) — cor reaproveitada de um propósito já estabelecido no
app (badge "massiva" também é roxo, mas em contexto totalmente diferente, sem colisão visual
já que nunca aparecem juntos). Tooltip com o motivo (ou texto genérico) + "(INSS)" quando
aplicável.

## Consequências

- Testado ao vivo (JWT de teste): 11 afastamentos hoje (6 de `atestados`, 5 de
  `ativos_inativos`). `EMERSON RENATO SASTRE` (licença indeterminada) passou a aparecer na
  lista com ícone azul, tooltip "Afastado por tempo indeterminado" — antes da correção do
  filtro base, não aparecia em lugar nenhum. `LUCIANO HENRIQUE DE MATTOS` (atestado, INSS)
  com ícone roxo, tooltip "Ausência justificada (INSS)".
- Suíte de isolamento de tenant (12 testes) e build do Angular continuam passando.
- Colaboradores afastados agora contam na lista geral do Trilho (antes eram invisíveis) —
  aparecem como "sem serviço" com o indicador, o que é o comportamento correto (eles
  continuam vinculados à empresa, só ausentes por período definido/indefinido), mas aumenta
  o total de colaboradores listado em relação a antes desta mudança.
