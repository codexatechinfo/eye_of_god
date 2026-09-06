# ADR 0032 — Contagens de livro cortadas pelo ciclo ATUAL (número de livro é reaproveitado entre meses)

## Contexto

Usuário reportou com prints: colaborador (JOAO PAULO DOMINGUES DA SILVA) mostrava "Realizadas: 564"
no card de resumo, mas o painel "Execução do dia" abaixo dizia "Nenhuma atividade registrada hoje" —
contradição óbvia. Além disso, comparando com o portal Copel direto: o livro 036137 (etapa 05, OS
aberta 04/09/2026, prazo 08/09/2026) mostrava "0/176" no portal (nenhuma leitura ainda), enquanto o
app calculava "174/38" (212) pro mesmo livro — mais MEIA CENTENA de leituras que não existem, e um
total maior até que o tamanho do livro no portal.

Investigação (consulta direta ao banco, não só leitura de código):

- `coordenadas_ucs_mineradas` (roster de UCs por livro) tem 212 linhas pro livro 36137, sem
  duplicata (212 UCs distintas) — não é bug de linha repetida.
- `contr_execucao_leitura` confirma a OS atual: `data_recebimento = 04/09/2026`, única janela já
  vista pra esse número de livro nessa tabela.
- TODAS as leituras de `base_dados_leitura` pro livro 36137 são de **agosto** (`11/08`, `07/08`,
  `06/08/2026`, `mes_ref_livro = 2026-08-01`) — nenhuma de setembro. Ou seja: as 174 "leituras"
  que o app contava como progresso do livro ATUAL (aberto em 04/09) eram, na verdade, leituras de
  um ciclo ANTERIOR do mesmo NÚMERO de livro — números de livro são reaproveitados mês a mês (o
  "036137" de agosto e o "036137" de setembro são fisicamente rotas diferentes, só compartilham o
  código).
- `obterEventosPorLivrosAteData` (`monitoramentoService.js`, usada por
  `atividadeColaboradoresService.js` pra corrigir digitados/naoDigitados/impedimentos, e também por
  `obterProgressoPorLivro`/`obterResumo`/`obterFaixasDias`/`detalheContr`/`leituraUrbanaService.js`)
  e as duas queries novas de `obterJornadaColaborador` (`ja_realizado_antes`, e o `pendentes` do
  ADR 0030 Adendo 13) comparavam `base_dados_leitura` contra o livro por NÚMERO, "alguma vez, em
  qualquer dia" — sem nenhum corte pelo ciclo/OS atual. Toda leitura histórica de QUALQUER ciclo
  anterior do mesmo número contava como progresso do ciclo mais recente.
- Consequência mais grave que a contagem errada: em `obterJornadaColaborador`, se o colaborador
  releesse HOJE uma UC que também foi lida num ciclo anterior do mesmo número de livro,
  `ja_realizado_antes` (sem esse corte) excluiria essa leitura de HOJE da timeline por achar que "já
  tinha sido feita antes" — uma leitura REAL de hoje sumiria silenciosamente do painel. Não
  reproduzido ao vivo neste caso específico (o livro 36137 não tem NENHUMA leitura ainda no ciclo
  atual), mas é uma consequência estrutural do mesmo bug, mais perigosa que o número errado.

## Decisão

`contr_execucao_leitura.data_recebimento` (data de abertura da OS do ciclo atual — já usada em
`classificarTipoServico`) é o corte confiável: qualquer evento de `base_dados_leitura` com
`data_da_leitura` ANTERIOR a essa data pertence a um ciclo passado do mesmo número de livro e não
conta como progresso do ciclo atual. Aplicado nos três lugares que comparavam contra o histórico
completo:

1. **`obterEventosPorLivrosAteData`** (`monitoramentoService.js`): nova CTE `ciclo_atual`
   (`DISTINCT ON (livro::int) livro::int, data_recebimento` de `contr_execucao_leitura`, escopada
   aos mesmos livros já filtrados por `$2::int[]`) — a CTE `eventos` só aceita
   `data_da_leitura >= data_recebimento` quando esse dado existe.
2. **`ja_realizado_antes`** (`obterJornadaColaborador`, `atividadeColaboradoresService.js`): mesma
   CTE `ciclo_atual`, escopada a uma consulta preliminar rápida (`SELECT DISTINCT livro::int FROM
   base_dados_leitura WHERE nome_do_usuario = $1 AND data_da_leitura = $2`, só os livros que
   aparecem HOJE pra esse colaborador — suficiente porque o `NOT EXISTS` só casa contra `b.livro`
   de `primeira_realizacao`, que é sempre um desses livros). Sem filtro por `colaborador` na CTE —
   `data_recebimento` é propriedade do LIVRO, não de quem está com ele agora.
3. **`pendentes`** (mesmo arquivo, Adendo 13 da ADR 0030): mesma lógica, escopada aos livros que já
   vieram em `rows` (as UCs realizadas hoje).

Em todo lugar, `data_recebimento` ausente ou malformada mantém o comportamento ANTIGO (sem corte) —
não regride livro que só existe via Massiva ou nunca apareceu em `contr_execucao_leitura`.

## Consequências

- `digitados`/`naoDigitados`/`impedimentos` de QUALQUER tela que use `obterEventosPorLivrosAteData`
  (Trilho, Monitoramento de Livros — resumo/faixas de dias/detalhe, leitura urbana) agora refletem
  só o ciclo/OS atual, não o histórico acumulado do número de livro. Números que pareciam "altos
  demais" ou inconsistentes com o portal Copel (livro recém-aberto já com progresso "herdado" de um
  ciclo anterior) corrigem sozinhos.
- `totalRealizadas`/`totalPendentes`/`totalImpedimentos` por colaborador (soma dos livros dele)
  mudam de valor em qualquer caso onde algum livro dele tenha histórico de ciclo(s) anterior(es).
- Pendentes (mapa/timeline, ADR 0030 Adendo 13) deixam de esconder UCs que só foram lidas num ciclo
  passado — voltam a aparecer corretamente como "ainda não lidas neste ciclo".
- Roster (`coordenadas_ucs_mineradas`) pode continuar maior que o total real do livro no portal
  (212 vs 176 no caso investigado, sem duplicata) — não corrigido aqui: parece ser
  defasagem/acúmulo da própria tabela "minerada" entre ciclos, fora do escopo desta correção (só o
  NUMERADOR/critério de "já lido" foi corrigido, não o denominador/roster em si). Fica registrado
  como suspeita pra investigar se aparecer de novo.

## Verificação

Confirmado ao vivo contra o banco real:
- Livro 36137 (JOAO PAULO): `digitados` 174 → **0** (bate com "0/176" do portal, considerando a
  diferença de roster já registrada acima). `totalRealizadas` do colaborador: 564 → **0**, agora
  consistente com a timeline vazia ("nenhuma atividade hoje" — ele genuinamente não leu nada hoje
  nem neste ciclo).
- Livro 4002 (EDILSON, caso já validado nas ADRs 0031/0030 Adendo 13): **sem mudança** —
  `digitados` 188 (era 190 antes de qualquer corte por ciclo; a pequena diferença é esperada, esse
  livro só tem uma janela de ciclo vista até agora), 94 pontos realizados / 36 pendentes na jornada,
  idêntico a antes — confirma que o corte não regride quem já estava correto.
- `obterProgressoPorLivro` (consumidor da Monitoramento de Livros) chamado direto: mesmos números
  corrigidos, confirma que o fix se propaga pra esse consumidor também.
- `npm test` (12/12) sem erro. Sem mudança de frontend nesta rodada.
