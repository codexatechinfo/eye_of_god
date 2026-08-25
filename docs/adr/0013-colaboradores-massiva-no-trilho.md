# ADR 0013 — Colaboradores só-massiva entram na lista do Trilho + badge de cargo

## Contexto

Dois pedidos na mesma leva sobre a lista de colaboradores do Trilho (`lista-colaboradores`):

1. Ao expandir um colaborador, mostrar se é motoqueiro, pedestre ou monitor.
2. Colaborador com massiva atribuída/em execução hoje, mas sem nenhuma leitura/releitura em
   `contr_execucao_leitura`, aparecia como "sem serviço" — errado, ele está trabalhando, só
   que numa fonte de dado que a lista nunca olhava.

## Decisão

### Badge de cargo

`ativos_inativos.cargo` já vem cru (`LEITURISTA MOTOCICLISTA` / `LEITURISTA` / `MONITOR`).
`rotuloCargo()` em `lista-colaboradores.ts` traduz pra Motoqueiro/Pedestre/Monitor; badge
colorido ao lado do nome da regional, visível só quando o colaborador está expandido — sem
mudança de backend, o dado já vinha na resposta de `/colaboradores/ativos`.

### Colaboradores só-massiva

`atividadeColaboradoresService.listarAtividadeHoje` só consultava `contr_execucao_leitura`
(leitura/releitura) — por isso ninguém que só tivesse massiva aparecia no mapa de
atividade, e a lista renderiza "sem serviço" pra qualquer colaborador ausente desse mapa.

Nova função `listarColaboradoresMassivaHoje(db)` busca em `atribuidas_im`/`em_execucao_im`
(as duas tabelas de `TABELAS_MASSIVA` que têm coluna `leiturista` — `pendentes_im` não tem,
ninguém foi atribuído ainda) do batch mais recente de cada tabela, agrupada por leiturista.

**Mesmo problema de sub-lote que `massivasService.contarFonteMassiva`/`detalheMassiva` já
tratam**: cada tabela pode ter mais de uma linha para o mesmo `(leiturista, livro)` — visto
ao vivo testando com "ALYSSON DIEGO DENIPOTI", que sem dedup aparecia com o livro "031580"
duplicado (`0/1` e `0/2`) e outros livros repetidos, 26 linhas para 24 livros reais.
Corrigido replicando o mesmo padrão de dedup dessas duas funções: `DISTINCT ON (leiturista,
livro)` dentro de cada tabela, ficando com a linha de menor quantidade restante (mais
avançada); entre `atribuidas_im`/`em_execucao_im` pro mesmo livro, "Em Execução" vence
"Atribuída" (prioridade 2 > 1).

O resultado é mesclado em `listarAtividadeHoje` depois do processamento normal de
leitura/releitura: colaborador que já apareceu (tem leitura E massiva no mesmo dia) recebe
os livros de massiva empurrados no array `livros` existente e os totais somados; colaborador
que só tem massiva vira uma entrada nova, com `ativo: true` (tem serviço, mesmo sem dado de
sincronismo por livro — as tabelas de massiva não têm granularidade de horário por leitura
individual como `contr_execucao_leitura.hora_import` tem) e `minutosParado: 0`.

`LivroAtividade.tipoServico` (FRONTEND) ganhou o valor `'massiva'` além de
`'leitura'/'releitura'/null`; badge roxo (`bg-violet-100`) na lista "Livros de hoje" ao lado
dos badges azul/âmbar já existentes — mesmo componente visual, só uma cor nova.

## Adendo — "Progresso de atividades" contaminado entre escopos

Efeito colateral não previsto: a mesma mescla que fez `atividade.totalRealizadas`/
`totalPendentes` de cada colaborador somarem leitura+releitura+massiva juntos também
contaminou o card "Progresso de atividades" da barra de resumo (ADR 0012) — usuário reportou
94526/206649 (45.7%) na aba **Massivas**, um total absurdo pra massiva (206.649 é da ordem
de grandeza de leitura+releitura, não só massiva).

Causa: `MassivasView.progressoContagens()` somava `atividade.totalRealizadas`/
`totalPendentes` — os totais já agregados do colaborador — sem filtrar por fonte. Isso
sempre foi "global" de propósito pros três primeiros números da barra (Agentes em
campo/Comunicação, métrica de colaborador, não de aba — ver ADR 0012), mas "Progresso de
atividades" precisa refletir só o escopo da aba aberta, e passou a vazar dado de massiva pra
Livros e vice-versa a partir do momento em que a atividade de massiva entrou na mesma lista
(ADR 0013, decisão principal).

Corrigido trocando a soma dos totais agregados por uma soma livro a livro, filtrando
`livro.tipoServico === 'massiva'` (aba Massivas) ou `!== 'massiva'` (aba Monitoramento de
Livros) antes de somar `digitados`/`naoDigitados` — `agentesEmCampoLista()`, "Agentes em
campo" e "Comunicação" continuam globais, só o Progresso passou a ser por escopo.

Testado ao vivo (JWT de teste): aba Massivas caiu de 94526/206649 pra 0/2859; aba
Monitoramento de Livros ficou em 94526/203790. A soma das duas (203790 + 2859 = 206649) bate
exatamente com o número contaminado de antes — confirma que a separação está certa, sem
perda nem duplicação de contagem entre as duas abas.

## Consequências

- Testado ao vivo (JWT de teste): "ALYSSON DIEGO DENIPOTI" (só tinha massiva hoje) passou a
  aparecer na lista do Trilho com cargo "Motoqueiro", 24 livros (sem duplicata), todos com
  badge "massiva", `totalRealizadas: 0` / `totalPendentes: 105` — batendo com a soma direta
  no banco.
- Colaboradores que já tinham leitura/releitura hoje e também têm massiva continuam
  aparecendo uma única vez (mesclado, não duplicado) — confirmado comparando alguns nomes
  que apareciam tanto na consulta de massiva quanto na lista "sem sincronismo" antes da
  mudança.
- Suíte de isolamento de tenant (12 testes) continua passando — a mudança é só leitura de
  tabela adicional dentro do mesmo `db` já autenticado pelo contexto de tenant da requisição.
