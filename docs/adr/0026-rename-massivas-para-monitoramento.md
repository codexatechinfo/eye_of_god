# ADR 0026 — Rename de arquivos "massivas" que na verdade são sobre livros/monitoramento

## Contexto

Ao investigar o crash da aba "Monitoramento de Livros" (ADR 0023 Adendo 1), ficou evidente
que `massivasController.js`/`massivasService.js`/`massivasRoutes.js` (backend) e
`massivas.service.ts`/`massivas-view/*` (frontend) servem **duas abas** — "Massivas" (tabelas
de staging `pendentes_im`/`atribuidas_im`/`em_execucao_im`, alimentadas por um scraper próprio)
e "Monitoramento de Livros" (`contr_execucao_leitura`/`base_dados_leitura`, sem relação com
massiva) — através de um `escopo`/`tipoServico` que alterna o comportamento. A MAIOR parte do
conteúdo real desses arquivos (timeline de UC, deslocamento/rota, prazo regulatório, regime
sucessivo de impedimento, contagem de leitura/releitura) é sobre livros, não sobre massiva.
Usuário: "corrija o nome dos arquivos de código que estão com o nome massivas mas não tem haver
com massivas isso pode confundir futuramente".

## Decisão

Levantamento prévio (agente de exploração) separou os arquivos "massivas" em dois grupos:

- **Genuinamente só sobre massivas** (pipeline scraper → import → coleta) — nomes mantidos:
  `coletaMassivasController.js`, `coletaMassivasJob.js`, `coletaMassivasRoutes.js`,
  `coletaMassivasService.js`, `copelMassivasImportService.js`, `copelMassivasScraperService.js`.
- **Mistos, servem as duas abas** — renomeados de `massivas*` para `monitoramento*`:

| Antes | Depois |
|---|---|
| `BACKEND/src/controllers/massivasController.js` | `monitoramentoController.js` |
| `BACKEND/src/routes/massivasRoutes.js` | `monitoramentoRoutes.js` |
| `BACKEND/src/services/massivasService.js` | `monitoramentoService.js` |
| `FRONTEND/src/app/services/massivas.service.ts` (`MassivasService`) | `monitoramento.service.ts` (`MonitoramentoService`) |
| `FRONTEND/.../massivas-view/` (`MassivasView`, seletor `app-massivas-view`) | `monitoramento-view/` (`MonitoramentoView`, `app-monitoramento-view`) |

Tipos com sufixo `Massivas` no service do frontend também renomeados por consistência
(`ContagemMassivas`, `ResumoMassivas`, `OpcoesFiltroMassivas`, `DetalheMassivas`,
`StatusMassivas`, `VisualizacaoMassivas`, `PrazoMassivas`, `FaixaDiasMassivas`,
`EscopoMassivas`, `HistoricoLivroMassivas`, `UcsLivroMassivas` → sufixo `Monitoramento`).
Comentários/referências cruzadas em `atividadeColaboradoresService.js`,
`leituraUrbanaService.js`, `deslocamentoService.js` e `colaboradores.service.ts` atualizados
pra apontar pros novos nomes.

**O que NÃO mudou** (fora do pedido — "arquivos de código", não contrato de API): o prefixo de
URL `/massivas` (`app.use('/massivas', monitoramentoRoutes)` em `server.js`) continua o mesmo,
comentário adicionado explicando por quê. O texto visível ao usuário ("aba Massivas", card
"Total massivas") também não muda — só identificadores de código.

**Escolha do nome**: perguntado ao usuário entre `monitoramento` e `execucao` — escolheu
`monitoramento` (bate com o nome real da aba "Monitoramento de Livros").

**Ressalva encontrada depois da escolha, não revertida**: `home.ts` já usa a string
`'monitoramento'` como CHAVE do tipo `Aba` (`type Aba = 'monitoramento' | 'livros' | 'massivas'
| 'importacao'`) — mas ali `'monitoramento'` significa a aba **Trilho** (mapa), não
"Monitoramento de Livros" (essa é `'livros'`); comentário no código já explica: "'monitoramento'
é a aba Trilho (rótulo mudou, chave não — ver ADR 0006)". São namespaces diferentes (uma
string de estado interno vs. nomes de arquivo/classe) e não há colisão de código real, mas um
futuro leitor buscando por "monitoramento" no projeto vai encontrar as duas coisas sem relação
entre si — trazido de volta ao usuário como um ponto de atenção, não desfeito nesta sessão.

## Verificação

- `npm test` (12/12), `node --check` em todos os arquivos backend alterados,
  `ng build --configuration development` limpos
- `obterResumo`/`obterDetalhe` (agora em `monitoramentoService.js`) testados direto contra o
  banco depois do rename — continuam funcionando (527ms/118ms)
- `grep` confirmando zero referências residuais a `massivasController`/`massivasRoutes`/
  `massivasService`/`massivas.service`/`massivas-view`/`MassivasService`/`MassivasView` no
  código (backend e frontend) — só sobraram os arquivos genuinamente sobre massiva
  (`coletaMassivas*`/`copelMassivas*`, que contêm "massivas" como substring do próprio nome
  correto) e referências de PROSA ao nome real da aba "Massivas" (comentários, rótulos de UI)
- Renomes feitos via `git mv` (preserva histórico/blame)
- Não verificado visualmente no navegador (mesma limitação de sempre nesta sessão, sem
  credencial de login)
