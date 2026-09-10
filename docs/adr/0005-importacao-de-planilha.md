# ADR 0005 — Importação de planilha (.xlsx) por tabela

## Contexto

O usuário pediu uma forma de importar dado direto por arquivo pras 11 tabelas de negócio
que sobraram depois da poda ([ADR 0004](0004-poda-de-tabelas-nao-usadas.md)) — hoje só o
scraper Copel grava nessas tabelas; nem toda tabela é alimentada por ele (`atestados`,
`ativos_inativos`, `cidades_localidades`, `suspensao`, `calendario_leitura`,
`prazo_reg_livros` não vêm do portal, são mantidas manualmente).

## Decisão

### Formato e escopo

Só `.xlsx`. Vale pra 11 tabelas, não pra `users` (usuário se cria pela rota de sempre, não
por planilha) nem pelas 3 de apoio ao RBAC.

### Regra por tabela — definida pelo usuário, não inventada

`BACKEND/src/config/importacaoConfig.js` é a fonte da verdade. Dois modos:

- **`substituir`** — cada import apaga tudo (escopado por empresa quando a tabela tem
  `empresa_id`) e recarrega do zero: `atestados`, `ativos_inativos`, `cidades_localidades`,
  `suspensao`.
- **`upsert`** — linha do arquivo cuja **chave composta** bate com uma linha já existente
  (mesma empresa) substitui essa linha; senão vira linha nova. Chave é tupla, não coluna a
  coluna — por isso `DELETE ... USING unnest(...)` no lugar de vários `= ANY()`
  independentes, que combinariam valor de uma linha do arquivo com valor de outra por
  engano:
  - `atribuidas_im`, `pendentes_im`, `em_execucao_im`: `(numero_os, dt_rec_abertura,
    qtd_digitados_nao_digitados)`
  - `contr_execucao_leitura`: `(numero_os, data_recebimento, hora_recebimento,
    qtd_digitados_nao_digitados)`
  - `control_empreiteiras`: `(data_da_leitura, hora_da_leitura, nome_do_usuario,
    unidade_consumidora)`
  - `calendario_leitura`, `prazo_reg_livros`: `(mes_ref)`

Nenhuma dessas tabelas ganhou constraint `UNIQUE` na chave — o scraper insere a mesma
"chave de negócio" várias vezes ao dia de propósito (snapshots ao longo do ciclo
07h–19h), e uma constraint quebraria esse insert. O upsert do import é lógica de
aplicação (`DELETE` pontual seguido de `INSERT`), não `ON CONFLICT`.

### Segurança do parser

- Cabeçalho da planilha (primeira linha) tem que bater exatamente (case-insensitive) com
  uma coluna cadastrada em `colunas` — qualquer nome fora disso rejeita o arquivo inteiro
  antes de tocar o banco. Nunca usa nome de coluna vindo do arquivo direto numa query.
- `id` e `empresa_id` nunca são aceitos como coluna do arquivo — `id` é serial, `empresa_id`
  é sempre `req.usuario.empresaId` (do token verificado), nunca o que vier no arquivo ou na
  URL.
- `multer` limita o arquivo a 20MB e rejeita qualquer coisa que não seja `.xlsx`.

### Biblioteca de Excel: `exceljs`, não `xlsx`

`xlsx` (SheetJS) tem duas vulnerabilidades conhecidas sem correção disponível via npm
(prototype pollution e ReDoS — a correção da SheetJS existe, mas só publicada fora do
registro do npm, e instalar de fora do registro não é algo que se faz sem checagem manual
de quem está mantendo o ambiente). `exceljs` não tem advisory equivalente; trocado antes de
escrever qualquer linha de parsing. Pendência conhecida: `exceljs` depende de uma versão
de `uuid` com advisory moderado (não crítico, sem exploração óbvia no caminho que este
código usa — só leitura de planilha, não os métodos de geração de UUID afetados); registrar
em `/seguranca` na próxima auditoria.

### Quem pode importar

`POST /importacao/:tabela` e `GET /importacao` exigem `ADMINISTRADOR` ou `ROOT`
(`exigirNivelMinimo('ADMINISTRADOR')`) — mesma régua de quem cria usuário.

### Tabelas compartilhadas — aviso, não bloqueio

`calendario_leitura` e `cidades_localidades` não têm `empresa_id` (ver ADR 0003) — import
nelas afeta todas as empresas, não só a de quem importou. A API devolve `compartilhada:
true` nessas duas e o FRONTEND mostra um aviso antes do usuário confirmar, mas não bloqueia
— decisão consciente do usuário, registrada aqui pra não ser esquecida.

## Consequências

- Auditoria: toda importação grava uma linha em `audit_log` (ação `importar_arquivo`, com
  tabela, modo e nome do arquivo em `detalhe`).
- Testado ponta a ponta contra o banco local: modo `substituir` (troca o conteúdo inteiro),
  modo `upsert` (linha com chave repetida substitui, chave nova acrescenta, chave ausente
  do arquivo fica intocada), bloqueio de nível (`USUARIO` recebe 403), bloqueio de tabela
  fora do allowlist (`users` recebe 400).
- FRONTEND: aba "Importação" em `home.html`, visível só quando `nivel` é `ADMINISTRADOR`
  ou `ROOT` (`Home.podeImportar()`) — a mesma tela de sempre, sem rota nova, mostra o
  comportamento e as colunas aceitas da tabela escolhida antes do usuário subir o arquivo.

## Alternativas descartadas

- **Constraint `UNIQUE` na chave + `INSERT ... ON CONFLICT`** — mais idiomático em SQL puro,
  descartado porque quebraria o insert normal do scraper (que grava a mesma chave de
  negócio várias vezes ao dia por design).
- **`xlsx` (SheetJS via npm)** — descartado por vulnerabilidade sem correção disponível no
  registro do npm.

## Adendo 1 (2026-09-10) — célula de data do Excel gravava sempre um dia antes (fuso horário)

Usuário pediu pra importar `prazo_reg_livros.xlsx` de setembro. Reimportação gravou `mes_ref
= '2026-08-31'` em vez de `'2026-09-01'` — o MESMO sintoma já relatado e "corrigido" em
2026-09-07 (comentário antigo em `importacaoConfig.js`), só que dessa vez batendo mesmo
depois daquele fix (`colunasDataIso` + `formatarDataIso`). O fix de 07/09 resolveu o formato
(DD/MM/YYYY → YYYY-MM-DD), mas não a causa raiz: **toda célula de data do Excel, lida pelo
`exceljs`, vem como meia-noite UTC** (`new Date('2026-09-01T00:00:00.000Z')`) — não existe
timezone num serial de data do Excel, e o `exceljs` ancora em UTC ao converter. O código
extraía o dia com `getFullYear()`/`getMonth()`/`getDate()` (componentes LOCAIS) e com
`toLocaleDateString('pt-BR')` (também local) — em qualquer timezone de offset negativo
(America/Sao_Paulo, UTC-3, o fuso do servidor), meia-noite UTC de um dia é 21h do dia
ANTERIOR local, então essas duas chamadas SEMPRE devolviam o dia errado pra qualquer coluna
de data cuja célula do Excel estivesse formatada como data (não texto) — não um caso raro
perto da virada de dia, o deslocamento é fixo e afeta 100% das células desse tipo.

Achado direto: testado com a planilha real (`prazo_reg_livros.xlsx`, célula `A2` = 1º de
setembro) — `toISOString()` confirma `2026-09-01T00:00:00.000Z`; `getFullYear/getMonth/getDate`
(local) devolvem `2026-08-31`; `getUTCFullYear/getUTCMonth/getUTCDate` devolvem `2026-09-01`
(certo). O comentário antigo de `formatarDataIso` tinha a lógica invertida: avisava contra
`toISOString()` citando a cilada de fuso horário de `PRAZO_CONTR_SQL` — mas aquele caso é de
um `Date` construído LOCALMENTE no próprio código (`new Date(y, m, d)`, onde local é o certo e
UTC quebra); aqui a origem é o `exceljs`, que é sempre UTC-anchored — a regra se inverte.

**Impacto real, não só teórico**: confirmado que a importação de `ativos_inativos` feita
minutos antes (mesma sessão, pedido anterior do usuário) gravou TODAS as colunas de data
(`admissao`, `45_dias`, `90_dias`, `data_atualizacao`) um dia atrasadas — matrícula 105417
gravou `admissao = 15/11/2022` quando a planilha tinha `16/11/2022`. Qualquer tabela
importada com coluna de data em célula Excel nativa (não texto) estava sujeita ao mesmo erro,
com ou sem `colunasDataIso` — o bug está nas DUAS ramificações de `extrairLinhas` que lidam
com `valor instanceof Date`.

### Decisão

`formatarDataIso` trocado pra usar `getUTCFullYear`/`getUTCMonth`/`getUTCDate`. O caminho
padrão (texto DD/MM/YYYY) trocado de `valor.toLocaleDateString('pt-BR')` pra
`valor.toLocaleDateString('pt-BR', { timeZone: 'UTC' })` — mesma correção, aplicada às duas
ramificações que convertem `Date` pra string em `extrairLinhas`.

`ativos_inativos` (modo `substituir`, sem chave) e `prazo_reg_livros` de setembro (linhas
erradas com `mes_ref = '2026-08-31'` apagadas manualmente antes) foram reimportados com o
código já corrigido, no mesmo dia — nenhuma tabela ficou com dado errado gravado por mais que
alguns minutos. `calendario_leitura` (usa `colunasDataIso` desde 2026-09-07, mesmo caminho
afetado) foi conferida: dado atual não mostra o sintoma (`mes_ref` aparece limpo,
`2026-09-01`/`2026-08-01`/`2026-07-01`, sem nenhum "dia 31" fantasma nem em `prazo_leitura`) —
mas sem a planilha original de quando foi importada pra comparar célula a célula, não dá pra
garantir 100% que nunca foi afetada; se o usuário ainda tiver o arquivo fonte, vale reimportar
pra ter certeza.

### Verificação

Testado direto contra a planilha real (`prazo_reg_livros.xlsx`): célula de data que antes do
fix virava `'2026-08-31'` agora vira `'2026-09-01'`, batendo com o `toISOString()` da célula.
Reimport de `prazo_reg_livros` (setembro, 13.892 linhas) e `ativos_inativos` (626 linhas)
confirmados linha a linha contra a planilha de origem após o fix — datas batendo
exatamente. `npm test` (18/18) limpo.
