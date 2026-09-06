# ADR 0031 — "Sem sincronizar" calculado a partir de `base_dados_leitura`, não mais só `contr_execucao_leitura`

## Contexto

Usuário reportou com print: colaborador com leitura real (código `000 - LEITURA NORMAL`) hoje às
09:04:53 aparecia, horas depois, como "Sem sincronizar há 12h24min" — um número muito maior do que
o real (na hora do print, o correto seria pouco mais de 3h). Pedido: "corrija isso pra todos", não
só pra esse colaborador.

Investigação (consulta direta ao banco, não só leitura de código — ver
`obterUltimaMudancaColaborador` era `null` pra esse colaborador o dia inteiro):

- `minutosParado`/`ultimaMudancaHora` (que decidem os toggles Ativo/Parado/Sem sincronismo em TODA
  a aba Trilho) vêm de `ultimaMudancaColaborador`, calculado em `listarAtividadeHoje`
  (`atividadeColaboradoresService.js`) a partir de `contr_execucao_leitura.codigo`: só conta como
  "sincronizou" quando `digitados` (`SUM(CASE WHEN codigo IS NOT NULL...)`) aumenta de um lote pro
  outro.
- `contr_execucao_leitura.codigo` fica **sempre `NULL`** desde que o scraper de Acompanhamento
  parou de abrir a página de OS de cada livro (mudança documentada no comentário de
  `obterEventosPorLivrosAteData`, `monitoramentoService.js` — "codigo_contr fica sempre NULL —
  codigo só existe via base_dados_leitura"). Confirmado ao vivo: 59 linhas de hoje pro colaborador
  reportado, todas com `codigo = null`, apesar de 140 leituras reais no mesmo livro em
  `base_dados_leitura` no mesmo dia.
- Consequência: `digitados` calculado por esse caminho é **sempre 0** pra qualquer livro de
  leitura/releitura, `ultimaExecucaoLivro` nunca dispara, `ultimaMudancaColaborador` fica pra
  sempre `null` — **pra todo mundo**, não só pro colaborador do print.
- `diferencaMinutos(null, ultimaHoraGeral)` trata `null` como meia-noite (`paraMinutosDoDia(null)`
  → `"0:0:0"` → 0). Na prática, `minutosParado` virava "minutos desde meia-noite até agora" —
  sempre um número grande, crescendo o dia inteiro, disfarçado de "sem sincronizar há Xh" mesmo pra
  quem sincronizou minutos atrás.
- Essa regressão passou despercebida porque uma correção anterior (bloco "Unifica as contagens de
  progresso", já existente) já buscava `base_dados_leitura` pra corrigir `digitados`/`naoDigitados`
  (as CONTAGENS mostradas em "Livros hoje") — mas deliberadamente **não** tocava
  `minutosParado`/`ultimaMudancaHora` (comentário da época: "conceito que continua vindo só do
  scraper/contr_execucao_leitura, fora do escopo desta unificação"). Migrou o "quanto" e esqueceu o
  "quando" — e nessa época `contr_execucao_leitura.codigo` ainda não era sempre-null, então não
  dava pra prever que o "quando" quebraria também.
- Já existe um precedente EXATO pra esse tipo de correção: o caminho de Massiva
  (`listarColaboradoresMassivaHoje`) já mescla `ultimaMudancaHora` com uma "última execução real"
  vinda de outra fonte (`ultimaExecucaoMassiva`, via `maiorHorario`) — só que a leitura/releitura
  nunca ganhou o equivalente.

## Decisão

Nova função `obterUltimaExecucaoRealHoje(db, dataBr)` (`atividadeColaboradoresService.js`): busca
em `base_dados_leitura`, por colaborador (`nome_do_usuario`), o maior `hora_da_leitura` do dia
(`data_da_leitura = dataBr`). Cada linha de `base_dados_leitura` já é um evento real (a tabela só
guarda leituras que aconteceram, não pendências), então o maior horário do dia já É a última
execução real — sem precisar da lógica de "baseline"/"digitados aumentando" que
`contr_execucao_leitura` usa (aquela existe pra filtrar RE-RASPAGEM do mesmo lote, que não existe
aqui). Sem `JOIN` com `coordenadas_ucs_mineradas` de propósito — diferente de
`obterUltimaUcRealizadaPorColaborador` (usada só pra posição no mapa), aqui não precisa de
coordenada, e um `INNER JOIN` excluiria justamente quem tem a última UC ainda não mapeada.

No bloco "Unifica as contagens" de `listarAtividadeHoje`, depois de corrigir
`digitados`/`naoDigitados`, mescla `ultimaMudancaHora` com essa nova fonte via `maiorHorario`
(mesmo padrão já usado no caminho de Massiva) e recalcula `minutosParado`/`parado`/`ativo`/
`semSincronismo` com o valor corrigido. Só AVANÇA o horário, nunca atrasa — colaborador cujo
`contr_execucao_leitura` já estivesse correto não muda de resultado.

Duas queries sequenciais (não `Promise.all`) no mesmo `client` de transação — `pg` não suporta
duas queries concorrentes no mesmo client (gera `DeprecationWarning` e serializa mesmo assim);
mais seguro não depender disso.

## Consequências

- `minutosParado`/`ativo`/`semSincronismo` agora refletem a atividade real de
  leitura/releitura em TODOS os casos (antes só funcionava por coincidência, quando
  `contr_execucao_leitura.codigo` não estava mais sendo preenchido). Colaboradores que pareciam
  "sem sincronismo" há muitas horas por causa deste bug voltam a ser categorizados corretamente
  como Ativo/Parado conforme o caso real — mudança de comportamento em potencialmente TODA a lista
  da aba Trilho, não só no colaborador do print.
- `contr_execucao_leitura.codigo` continua sendo consultado (não removido) — mantém o
  comportamento correto de quem porventura ainda tenha esse campo preenchido, e evita reescrever
  mais do que o necessário pra resolver o bug relatado.
- Caso remanescente conhecido, fora do escopo deste ADR: colaborador que NUNCA teve nenhuma leitura
  real hoje em nenhuma das duas tabelas (`parado = true`, `totalRealizadas = 0`) ainda calcula
  `minutosParado` como "minutos desde meia-noite" — semanticamente ambíguo ("nunca sincronizou"
  virando um número crescente), mas não é o bug relatado (esse exige uma leitura real que já
  aconteceu e não está sendo contada) e mudar esse comportamento não foi pedido.

## Verificação

Confirmado ao vivo contra o banco real (script ad-hoc, mesmo padrão de sessões anteriores): antes
da correção, o colaborador do print tinha `ultimaMudancaHora: null` e `minutosParado` batendo com
"minutos desde meia-noite" (~768min às 12:48); depois da correção,
`ultimaMudancaHora: '09:04:53'` e `minutosParado: 223` (~3h43min, batendo com 09:04 → 12:48).
`npm test` (12/12, isolamento de tenant — não cobre esta lógica diretamente) e `ng build` sem erro.
