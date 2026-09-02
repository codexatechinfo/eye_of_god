# ADR 0027 — Extração "Controle de Empreiteiras" (→ `base_dados_leitura`), encadeada no job de Massivas

## Contexto

Usuário forneceu um script Python standalone (Playwright + `psycopg2`), já validado ao vivo
contra o portal Copel, que: loga, seleciona concessionária/empreiteira, navega um widget de
calendário (estilo Duetto Datepicker) até o dia atual, exporta um `.csv` ("EXPORTAR
RELATÓRIO"), normaliza as colunas (casamento difuso de cabeçalho, já que o export nem sempre
bate exatamente com os nomes esperados) e faz `DELETE` (do dia)+`COPY` numa tabela
`control_empreiteiras`.

Essa tabela não existe mais neste banco — removida nesta mesma sessão por estar superada,
substituída por `base_dados_leitura` (ADR 0024, réplica estrutural exata da mesma tabela; ADR
0004 Adendo 1 registra a remoção). O pedido: portar essa extração pra dentro da API Node,
escrevendo em `base_dados_leitura`, com uma mudança de comportamento — em vez de só extrair o
dia atual, cada ciclo primeiro apaga+reimporta o dia **anterior** (o relatório pode ter sido
corrigido/consolidado no portal desde a última coleta) e só depois apaga+reimporta o dia
**atual**.

## Decisão de execução — encadeado dentro do job de Massivas, não um job separado

Perguntado e confirmado com o usuário: a extração nova roda **dentro da mesma sessão do
scraper de Massivas**, mesma conta Copel, sem logar de novo — não é um terceiro consumidor da
fila `copelSessaoLock.js`. Motivo: o portal trata sessão como única por conta (ADR 0019); um
job separado só disputaria a mesma sessão à toa, enquanto encadear dentro da sessão já aberta
pelo Massivas evita um login extra e mantém a garantia "nunca duas sessões Copel ativas ao
mesmo tempo" sem precisar de coordenação nova. A paralelização do Acompanhamento com múltiplas
contas (mencionada pelo usuário na mesma conversa) é uma tarefa **separada**, fora de escopo
desta ADR.

## Achado crítico — formato de data diverge do script original

O script Python formata `data_da_leitura`/`mes_ref_livro` como `YYYY-MM-DD`. Certo pra
`control_empreiteiras` (extinta), **errado** pra `base_dados_leitura`: toda a base de código já
escrita na ADR 0025 (`buscarEventosLeitura`, `montarUcsAtuais`, `obterJornadaColaborador`,
`obterUltimaUcRealizadaPorColaborador`) valida `data_da_leitura` contra `^\d{2}\/\d{2}\/\d{4}$`
(`DD/MM/YYYY`) — mesmo padrão do resto do schema. O port formata pra `DD/MM/YYYY`
(`formatarDataBr`, reescrita — não é tradução literal do `formatar_data` original, que saía em
ISO). Divergência deliberada, documentada explicitamente no código pra não ser "corrigida" de
volta pra ISO por engano no futuro.

## Arquivos

### Novo: `BACKEND/src/services/copelControleEmpreiteirasScraperService.js`

Porta a lógica de navegação/extração do script (mesmos seletores — mesma conta, mesmo portal):

- **Sem login próprio** — reaproveita a `page` já logada por `coletarMassivas()`
  (`copelMassivasScraperService.js`). Só: clica no link do relatório
  (`a[href='/lis/relatorioControleEmpreiteirasAction.do']`), seleciona concessionária/
  empreiteira por `label` nos `<select>` (`searchConcessionariaId`/`searchEmpreiteiraId`).
- Navegação do calendário: `ajustarCalendarioParaMes`/`clicarDiaVisivel`/
  `selecionarDataNoCalendario`/`selecionarPeriodo` — porta 1:1 os mesmos seletores do script
  (`td.title`, `td.button.nav`, `td.day`, `#btnmesReferencia`/`#btndataInicio`/`#btndataFim`),
  generalizada pra aceitar qualquer data alvo (`Date`), não só "hoje" — única mudança real na
  lógica de navegação, já que o script original só suportava a data atual.
- Exportação: `page.waitForEvent('download')` + clique em "EXPORTAR RELATÓRIO", salva em
  `os.tmpdir()`, apagado (best-effort) depois de processar.
- Parse do CSV: `ExcelJS` (já dependência do projeto, usado em `importacaoService.js`) —
  `workbook.csv.read(stream, { parserOptions: { delimiter: ';' }, map: v => v })`. O `map`
  identidade evita a conversão automática de número/data do ExcelJS (perderia zero à esquerda
  de `livro`/`etapa`, converteria data pra `Date` sem controle). Encoding: lê como UTF-8
  primeiro; se aparecer `U+FFFD` (bytes inválidos), relê como `latin1` — mesma cascata de
  fallback do script Python, sem precisar de dependência nova (`latin1`/`cp1252` são idênticos
  na faixa de acentuação portuguesa usada aqui).
- Normalização: porta `normalizarTxt`/`detectarColunas`/`TERMOS_COLUNAS`/`EXCLUSOES`/
  `linhaValidaNegocio` (filtro exato por concessionária/empreiteira) — mesma lógica de
  casamento difuso de cabeçalho do script. `etapa`/`livro` mantêm o zero-padding original
  (2/5 dígitos).
- `extrairControleEmpreiteiras(page, dataAlvo, { concessionaria, empreiteira })`: uma chamada =
  uma data, devolve array de objetos já no formato de colunas de `base_dados_leitura`.
- `formatarDataBr`, `normalizarLinhas`, `detectarColunas` exportados também, além da função
  principal — são funções puras, testadas isoladamente sem precisar de navegador (ver
  Verificação).

### Novo: `BACKEND/src/services/copelControleEmpreiteirasImportService.js`

Espelha `copelImportService.js` (SAVEPOINT por lote de até 300 linhas — um lote ruim nunca
perde os outros já inseridos com sucesso na mesma chamada):

`importarControleEmpreiteiras(db, registros, empresaId, dataDaLeituraBr)`: `DELETE FROM
base_dados_leitura WHERE data_da_leitura = $1 AND empresa_id = $2` (escopado por tenant, ADR
0009 — não por concessionária/empreiteira como no script original) seguido de `INSERT` em
lotes. Chamar com `registros = []` ainda faz o `DELETE` (reconcilia o dia pra "sem dado") —
comportamento intencional, ver próxima seção.

### Modificado: `copelMassivasScraperService.js` / `coletaMassivasService.js`

`coletarMassivas()` ganha, depois de raspar pendentes/atribuídas/em execução e **antes** do
`browser.close()`, duas chamadas a `extrairControleEmpreiteiras` (ontem, depois hoje), cada uma
no seu **próprio** `try/catch`. `coletaMassivasService.js#executarColetaMassivas` chama
`importarControleEmpreiteiras` uma vez por data, cada uma com seu `DELETE`+`INSERT` independente
(pedido explícito do usuário — não numa transação só, um dia não trava o outro).

**Bug achado e corrigido antes de considerar pronto** (autorevisão, não reportado pelo
usuário): a primeira versão inicializava o resultado como `{ ontem: [], hoje: [] }` e um erro
de extração virava log — mas `[]` (array vazio) é EXATAMENTE o mesmo valor que "extração rodou
e achou zero linhas de verdade" (`importarControleEmpreiteiras` trata `[]` como reconciliação
válida: ainda apaga o que existia antes). Resultado: uma falha transitória de rede na extração
de "ontem" apagaria dado BOM de um dia anterior, sem substituir por nada — pior que não ter
rodado o ciclo. Corrigido: inicializa como `{ ontem: null, hoje: null }`; cada data tem seu
próprio `try/catch` (erro em "ontem" não impede a tentativa de "hoje"); a camada de import só
aciona `DELETE`+`INSERT` quando o valor não é `null` (`!= null`, que em JS exclui `null` e
`undefined` mas inclui `[]`). Verificado ao vivo (ver abaixo) que a distinção funciona nos dois
sentidos: `null` preserva dado preexistente, `[]` de verdade reconcilia (apaga) corretamente.

### `.env.example`

`COPEL_CONCESSIONARIA`/`COPEL_EMPREITEIRA` documentadas (opcionais — o código já tem os mesmos
defaults do script original, funciona sem editar `.env`).

## O que NÃO muda

- `copelSessaoLock.js`, `coletaJob.js`/`copelScraperService.js` (Acompanhamento) — intocados.
- Frequência do ciclo — continua a do loop de `coletaMassivasJob.js`, sem pausa extra só pra
  este passo.
- Nenhuma rota/endpoint HTTP novo.
- Paralelização do Acompanhamento com múltiplas contas Copel — mencionada pelo usuário na
  mesma conversa, tratada como tarefa separada.

## Verificação

- `node --check` nos 2 arquivos novos e nos 2 modificados
- Teste isolado das funções puras (`formatarDataBr`, `detectarColunas`, `normalizarLinhas`),
  sem navegador: 6 formatos de data de entrada → sempre `DD/MM/YYYY` na saída; cabeçalho com
  `Mensagem`/`Mensagem Auxiliar` mapeado pra colunas diferentes (sem colisão); linha de
  concessionária/empreiteira que não bate filtrada corretamente; `etapa`/`livro` com
  zero-padding certo
- Teste de importação direto contra o banco (fora do HTTP, mesmo padrão já usado nesta sessão):
  1ª importação insere; reimportar a mesma data com registros diferentes substitui (não
  acumula); importar `[]` limpa a data (0 linhas depois)
- Teste específico da distinção `null`/`[]`: dado preexistente sobrevive quando o resultado
  simulado é `null` (extração "falhou"); o mesmo dado é corretamente apagado quando o resultado
  é `[]` (extração "rodou e achou zero")
- `npm test` (12/12) continua passando (isolamento de tenant não muda)
- Execução ao vivo real contra o portal Copel (login de produção) não foi feita nesta sessão —
  fica pra quando o usuário rodar o job de verdade; é uma ação com efeito colateral externo
  (login na conta real), avisar antes se for disparada manualmente fora do ciclo normal do job
