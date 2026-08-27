# ADR 0019 — Fila de exclusão mútua entre os jobs Coleta Acomp e Massivas

## Contexto

Dois jobs cron independentes rodam em loop contínuo (07h–19h) desde o boot do servidor
(`server.js`): `coletaJob.js` ("Coleta Acomp", aba Acompanhamento) e
`coletaMassivasJob.js` ("Massivas", abas Pendentes/Atribuídas/Em Execução). Cada um abre
seu próprio browser Playwright, mas os dois fazem login no mesmo sistema
(`www.copel.com/lis`) com a mesma conta (`COPEL_USERNAME`/`COPEL_PASSWORD`) — não existe
segunda credencial disponível.

Usuário reportou, com log real do terminal, o Coleta Acomp crashando no meio da etapa 15
com `locator.click: Timeout 30000ms exceeded` esperando
`a.color:has-text("ETAPA")`, e reiniciando do zero ("voltou pra etapa 15"). No mesmo trecho
de log, intercalado (os dois jobs escrevem no mesmo stdout), aparecem as mensagens sem
prefixo do Massivas — `Filtros aplicados`, `Buscando... (tentativa 1/3)`,
`138 linhas extraídas (atribuídas)`, `Abrindo em execução...` — que só existem em
`copelMassivasScraperService.js`, precedidas por `Realizando login...` na mesma função.

## Decisão

Causa raiz: o portal Copel aparenta usar sessão única por usuário — login novo da mesma
conta invalida a sessão HTTP anterior no servidor. Como os dois jobs rodam concorrentemente
o dia inteiro sem nenhuma coordenação, o login de um decorre exatamente no meio da operação
do outro, derrubando a página que estava no meio de uma etapa — daí o timeout súbito num
locator que segundos antes funcionava normalmente.

Criado `BACKEND/src/services/copelSessaoLock.js`: uma fila de exclusão mútua simples
(`comSessaoExclusiva(tarefa)`, baseada em encadear promises, sem dependência nova) que
serializa as duas coletas. `coletaCopelService.js` e `coletaMassivasService.js` agora
envolvem a chamada ao respectivo scraper (a parte que faz login e usa a sessão Copel — não
a etapa de importar pro Postgres, que não depende da sessão) com essa fila. Efeito: nunca
mais os dois jobs têm sessão Copel ativa ao mesmo tempo; um espera o outro terminar antes
de começar seu próprio ciclo.

## Consequências

- Elimina a causa raiz do crash/reinício no meio de etapa — não é mais necessário adivinhar
  se o problema está na lógica de navegação do scraper.
- Efeito colateral aceito: os dois jobs passam a rodar em série, não mais em paralelo — o
  tempo total de ciclo por job pode aumentar quando o outro está no meio de uma coleta longa.
  Preferível ao retrabalho e à perda de progresso causados pelo crash.
- Testes de isolamento de tenant (`npm test`, 12/12) seguem passando — a mudança não toca
  em banco de dados nem RLS, só orquestração dos dois jobs em memória do processo Node.
- Se no futuro existir uma segunda credencial Copel dedicada a um dos jobs, essa fila deixa
  de ser necessária e pode ser removida sem afetar mais nada.
