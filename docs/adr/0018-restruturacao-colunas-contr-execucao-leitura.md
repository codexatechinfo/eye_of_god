# ADR 0018 — Reestruturação de colunas de `contr_execucao_leitura`

## Contexto

Usuário pediu para alterar a estrutura de `contr_execucao_leitura` (a tabela de leitura/
releitura alimentada pelo scraper de acompanhamento Copel, fonte da aba Monitoramento de
Livros e de boa parte da aba Trilho):

**Colunas removidas**: `tipo_oss`, `subtipo_os`, `numero_os`, `data_ultima_atualizacao`,
`qtd_digitados_nao_digitados`, `qtd_com_leitura_sem_leitura`, `percentual_sem_leitura`,
`qtd_fora_de_faixa_foto`.

**Colunas mantidas**: `etapa`, `localidade`, `livro`, `empreiteira`, `data_recebimento`,
`hora_recebimento`, `data_prevista_limite`, `situacao` — mais `data_import`/`hora_import`
(confirmado com o usuário que continuam existindo; ele só não as citou porque são metadados
carimbados na importação, não vêm do scraping em si) e `id`/`empresa_id` (chave e RLS).

**Colunas novas**: `uc`, `colaborador`, `codigo`, `equipamento`, `tipo_especificacao`,
`faturamento`, `leitura_atual` — todas `varchar(255)`, mesmo padrão das demais. Usuário
confirmou que vêm de **outra aba do portal Copel**, ainda não indicada — o scraping dessas
colunas fica pendente de instrução futura.

A tabela já estava vazia no momento da mudança (truncada a pedido do usuário momentos antes,
neste mesmo ciclo de trabalho), então não houve perda de dado real na alteração de schema em
si.

## Decisão

### DDL

```sql
ALTER TABLE public.contr_execucao_leitura
  DROP COLUMN tipo_oss,
  DROP COLUMN subtipo_os,
  DROP COLUMN numero_os,
  DROP COLUMN data_ultima_atualizacao,
  DROP COLUMN qtd_digitados_nao_digitados,
  DROP COLUMN qtd_com_leitura_sem_leitura,
  DROP COLUMN percentual_sem_leitura,
  DROP COLUMN qtd_fora_de_faixa_foto,
  ADD COLUMN uc character varying(255),
  ADD COLUMN colaborador character varying(255),
  ADD COLUMN codigo character varying(255),
  ADD COLUMN equipamento character varying(255),
  ADD COLUMN tipo_especificacao character varying(255),
  ADD COLUMN faturamento character varying(255),
  ADD COLUMN leitura_atual character varying(255);
```

Rodado como `postgres` dentro do container `supabase-db` (`app_user` não é dono da tabela —
mesmo padrão de todo DDL neste projeto). RLS/FK/PK preservados (`ALTER TABLE ... DROP/ADD
COLUMN` não mexe neles).

### `copelImportService.js`: scraping posicional continua intacto, gravação muda

O scraper (`copelScraperService.js`) lê a tabela `#item` do portal **por posição de
célula**, sem nome — a ordem das 16 colunas originais (`CAMPOS`, agora renomeado
`CAMPOS_SCRAPER`) tinha que continuar batendo com o HTML da página, senão o parse inteiro
desalinha. Como o usuário não indicou mudança no layout dessa tabela específica (só disse
que as colunas novas vêm de **outra** aba), `CAMPOS_SCRAPER` foi mantido do jeito que estava.

Separado um segundo array, `CAMPOS_TABELA` (`etapa, localidade, livro, empreiteira,
data_recebimento, hora_recebimento, data_prevista_limite, situacao`), usado só para montar o
`INSERT` — o parse continua extraindo as 16 posições originais para um objeto (`obj`), mas só
os 8 campos de `CAMPOS_TABELA` são de fato escritos no banco. As 7 colunas novas ficam de fora
do `INSERT` por enquanto (default `NULL`, todas nullable) até o scraping da aba nova ser
implementado.

### Código dependente de `qtd_digitados_nao_digitados` (fonte `contr_execucao_leitura`)

Usuário autorizou explicitamente remover mesmo sabendo que quebraria código ("pode apagar o
código da api vai ser alterado tbm pra essas novas mudanças"). Antes de fazer a alteração,
levantado todo o uso real da coluna no código para não deixar a coleta automática ou as telas
quebradas com erro SQL (`column does not exist`) enquanto a nova lógica de progresso não é
definida:

- **`leituraUrbanaService.js`** (`calcularLeituraUrbana`) — roda a **cada ciclo de coleta**
  (chamado por `coletaCopelService.executarColetaCopel`, não só quando alguém abre uma tela).
  Se ficasse quebrado, a coleta automática inteira falharia a cada ciclo, não só a API.
  `digitados`/`nao_digitados` trocados por `0::int` fixo, com comentário explicando o motivo.
- **`atividadeColaboradoresService.js`** (`listarAtividadeHoje`) — `qtd_digitados_nao_digitados`
  removida do `SELECT`; `parseQtd(linha.qtd_digitados_nao_digitados)` trocado por
  `digitados = 0; naoDigitados = 0` direto.
- **`massivasService.js`** — 4 pontos usavam `condicaoQuantidade('c.qtd_digitados_nao_digitados')`/
  `condicaoQuantidadeNao(...)` (`contarFonteContr`, `obterFaixasDias`, `detalheContr`,
  `historicoContrLivro`), todos com o alias `c` = `contr_execucao_leitura`. Trocados por duas
  constantes novas, `CONTR_DIGITADOS_SQL`/`CONTR_NAO_DIGITADOS_SQL` (ambas `'0'`), documentadas
  no topo do arquivo. **Não tocado**: os pontos que usam `t.qtd_digitados_nao_digitados`
  (`contarTabela`, `detalheMassiva`, `historicoMassivaLivro`) — `t` ali é uma tabela de
  massiva (`pendentes_im`/`atribuidas_im`/`em_execucao_im`), que não muda nesta ADR.

Em `contarFonteContr` e `obterFaixasDias`, o `ORDER BY ... (${digitados} + ${naoDigitados})
ASC` que antes desempatava por "linha de menor quantidade restante" virou, na prática,
`ORDER BY c.livro, (0 + 0) ASC` — SQL válido, mas sem efeito de desempate real; trocado por
`ORDER BY c.livro, id ASC` em `contarFonteContr` (mais determinístico que uma constante).

### O que fica temporariamente zerado/incompleto

Com `digitados`/`nao_digitados` fixos em `0` para a fonte leitura/releitura:

- Coluna "Progresso" e "Executados/Pendentes" na tabela de Monitoramento de Livros mostram
  `0/0` / `0%` para todo livro de leitura/releitura.
- Contagem "leituras" nos cards de resumo (Pendentes/Atribuídas/Em Execução/faixas de dias)
  fica sempre `0`, embora a contagem de "livros" continue correta (`COUNT(*)` não depende da
  coluna removida).
- Percentual de execução e status parado/ativo do Trilho, para colaboradores de leitura/
  releitura, ficam sempre "0% executado hoje" — `digitados`/`naoDigitados` zerados em
  `listarAtividadeHoje` alimentam `percentualExecucao()`/`pontuacaoDestaque()` no FRONTEND.
  Massiva não é afetada (fonte separada).

Isso é esperado e temporário — fica assim até o usuário indicar de onde vêm as 7 colunas
novas e como a nova lógica de progresso deve ser calculada a partir delas.

## Adendo — coluna `smart`

Usuário pediu mais uma coluna: `smart` (`varchar(255)`, mesmo padrão das demais). Adicionada
com `ALTER TABLE public.contr_execucao_leitura ADD COLUMN smart character varying(255);`,
mesmo processo (como `postgres` dentro do `supabase-db`). Confirmada via
`information_schema.columns`.

Mesma situação das 7 colunas do Adendo original: não populada pelo scraper ainda (nenhum
código toca nela), origem/uso não especificados no pedido — fica pendente de instrução.

## Consequências

- `contr_execucao_leitura` com o novo schema confirmado via `\d` (RLS/FK/PK intactos).
- `npm test` (suíte de isolamento de tenant, 12 testes) continua passando — mudança não mexe
  em RLS/tenant.
- Testado ao vivo, direto contra o banco (sem passar pela camada HTTP), exercitando os 4
  caminhos de código afetados: `calcularLeituraUrbana`, `listarAtividadeHoje`,
  `obterResumo`/`obterDetalhe` (escopo `leiturarelitura`) — todos rodaram sem erro de SQL. A
  coleta automática já tinha repopulado a tabela com o schema novo nesse meio-tempo (808
  pendentes, 1253 linhas de detalhe), confirmando que `copelImportService.js` grava
  corretamente com as colunas atuais.
- **Pendente**: scraping das 7 colunas novas (aguardando o usuário indicar a aba/fluxo do
  portal) e a lógica de progresso que vai substituir `qtd_digitados_nao_digitados` —
  provavelmente usando `leitura_atual` de alguma forma, mas isso ainda não foi definido.
