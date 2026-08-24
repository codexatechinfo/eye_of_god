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
