# ADR 0025 — Timeline/deslocamento/impedimentos/jornada baseados em `base_dados_leitura`

## Contexto

`contr_execucao_leitura.hora_import` é o instante do CICLO DE RASPAGEM (~35-50min), não o
instante real em que o colaborador leu o medidor — causa raiz já documentada de "trabalhado"
ficar sempre ~0s na Jornada (memória `project_jornada_trabalhado_zero`, ADR 0022 Adendo 1).
`base_dados_leitura` (ADR 0024, carga diária contínua confirmada com o usuário) tem
`data_da_leitura`/`hora_da_leitura` reais por UC, mais `mensagem` (texto completo do código, ex.
"094 - LEITURA TELEMEDIDA") em vez de só um código numérico. Usuário pediu pra reconstruir
timeline, deslocamento/km percorrido, impedimentos e jornada em cima dessa fonte melhor —
mantendo "a realizar" (roster/pendentes) em `contr_execucao_leitura`, confirmado com o usuário.

**Escopo desta ADR** (decidido com o usuário): timeline, deslocamento/km, impedimentos e
jornada — tudo escopado a um livro/colaborador por vez. **Fora de escopo**:
`listarAtividadeHoje` (quais livros aparecem "hoje" na barra lateral) fica pra uma conversa
separada — função bem mais entrelaçada com o dashboard inteiro.

## Decisão

### Formato do `livro` diverge entre as tabelas

`contr_execucao_leitura.livro = '040980'` (zero à esquerda) vs `base_dados_leitura.livro =
'40980'` (sem zero) — confirmado ao vivo, mesmo padrão já documentado pra
`coordenadas_ucs_mineradas`/`prazo_reg_livros`. Toda query cruzando as duas compara
`livro::int = $1::int`. Índice novo `idx_base_dados_leitura_livro_int (empresa_id,
(livro::int))` — sem ele, cada abertura de painel de livro varreria as 3,5 milhões de linhas
inteiras (mesma classe de bug da ADR 0023).

### Classificação de impedimento

Código extraído do prefixo numérico de `mensagem` (regex `^(\d+)\s*-`). Não-impedimento: `000`
(normal), `099` (confirmada). Administrativo (não conta mais como impedimento): `094`
(telemedida), `059` (leitura do cliente), `037` (plurimensal), `027` (troca de medidor), `054`
(fora de rota), `055`/`056` (cadastrar/descadastrar cão feroz — ação administrativa, não o cão
em si). Ambíguos (`098`-não confirmado, `030`-suspeita de irregularidade, `031`-casa
interligada) ficam como impedimento real, a pedido do usuário. Resto do catálogo (obstrução de
campo de verdade) sem mudança.

### `BACKEND/src/services/massivasService.js`

`buscarEventosLeitura(db, livro)` — busca eventos de `base_dados_leitura` pro livro.
`escolherPorUc(linhas, ordem)` — uma linha por UC ('primeira' pra timeline, 'ultima' pra
enriquecer atuais), desempate por `especificacao = 'CON'` quando duas linhas caem no mesmo
instante (par CON/GTP/BAM confirmado nos dados reais). `extrairCodigoDeMensagem(mensagem)`.

`listarUcsAtuaisDoLivro` (agora `montarUcsAtuais`, síncrona): fonte não muda (continua
`contr_execucao_leitura`, mantém roster + pendentes), mas cada UC com evento em
`base_dados_leitura` tem `codigo`/`data_import`/`hora_import`/`tipo_especificacao`
sobrescritos com o dado real; sem evento, mantém o original (nunca quebra). `codigo` só é
sobrescrito se `extrairCodigoDeMensagem` conseguir extrair algo (`?? resto.codigo` como rede de
segurança contra mensagem malformada).

`listarTimelineUcsRealizadasDoLivro` (agora síncrona, recebe o mapa 'primeira' já pronto):
monta a timeline inteira a partir de `base_dados_leitura` — `data_import`/`hora_import` (nomes
de campo mantidos por compatibilidade com o frontend) viram os horários reais.

`anexarSegmentosDeslocamento`/`deslocamentoService.js`: **sem alteração nenhuma** — como
`atuais` agora carrega o horário real quando disponível, o cálculo de intervalo/distância/pausa
passa a refletir a realidade sem tocar no motor de cálculo.

### `BACKEND/src/services/atividadeColaboradoresService.js`

`obterJornadaColaborador` reescrita pra `base_dados_leitura`. Diferença importante da versão
antiga: `ja_realizado_antes` usa **comparação de data de verdade**
(`to_date(...) < to_date($2,...)`), não o truque de `id < primeiro_id do dia` — aquele truque
dependia de `id` ser aproximadamente cronológico, válido pra `contr_execucao_leitura` (scraper
escreve em tempo real), mas **não** pra `base_dados_leitura` (alimentada por import em lote
diário — `id` reflete ordem de importação, não do evento). Índice novo
`idx_base_dados_leitura_usuario_data (empresa_id, nome_do_usuario, data_da_leitura)`.

### Dois problemas reais de qualidade de dado achados ao vivo (não previstos no plano)

1. **Linhas com `data_da_leitura`/`hora_da_leitura` em branco** (226.567 de 3,5 milhões, ~6,5%
   — mesmas linhas sem `mensagem`, gap de origem no export, não introduzido por este trabalho).
   Sem filtrar, `chaveDataHoraOrdenavel` tratava `""` como `"0000-00-00T"`, que vence QUALQUER
   data real na comparação — a linha em branco roubava o posto de "primeira realização" de UCs
   que na verdade tinham data boa (ou nenhuma, caindo certo no fallback). Corrigido filtrando
   essas linhas fora de `buscarEventosLeitura`.
2. **132 linhas com `data_da_leitura` em formato ISO** (`"2026-08-31"` em vez de
   `"DD/MM/YYYY"`) — todas do import do `.xlsx` (ADR 0024 Adendo 2): o ExcelJS devolveu essa
   coluna já como string formatada em ISO, não como objeto `Date`, então a conversão de
   `lerXlsx` (que só tratava `instanceof Date`) não pegou. Quebrava `to_date(...)` com erro
   fatal (`date/time field value out of range`), derrubando a jornada do colaborador afetado.
   Corrigido as 132 linhas direto no banco (`to_char(to_date(..., 'YYYY-MM-DD'), 'DD/MM/YYYY')`)
   e adicionada validação de formato (`~ '^\d{2}/\d{2}/\d{4}$'`) nas duas queries novas — uma
   importação futura com formato errado só perde aquela linha, não derruba a consulta inteira.

## Verificação

- Índices `idx_base_dados_leitura_livro_int` e `idx_base_dados_leitura_usuario_data` criados
  via `CREATE INDEX CONCURRENTLY`
- `obterUcsDoLivro('040980')`: 91 UCs em atuais (79 já conhecidas + **12 descobertas como
  realizadas só por `base_dados_leitura`, ainda pendentes em `contr_execucao_leitura`** —
  achado real confirmado ao vivo, prova que a fonte nova é mais atualizada em alguns casos), 12
  na timeline (cobertura ainda parcial pro mês — deve crescer com a carga diária), 2,92km
- `obterUcsDoLivro('040981')`: 53 atuais, 15 timeline, 2,34km
- **Jornada — o bug antigo confirmado corrigido**: `GUILHERME QUILES`/29-08 →
  `trabalhadoSegundos: 10004` (2h47min), `ocupacaoPercentual: 85` (antes: sempre ~0s/0%
  pra qualquer colaborador, ver ADR 0022 Adendo 1). Testado com mais 2 colaboradores
  (`TIAGO JOSE DE LIMA`, `CLEBERSON FERNANDO RODRIGUES DE SOUZA`) — números plausíveis e
  distintos nos dois; colaborador inexistente devolve `semDado: true` corretamente
- Par CON/GTP/BAM da mesma leitura (mesma data+hora) confirmado escolhendo CON nos dois lugares
- `npm test` (12/12), `node --check` nos arquivos alterados, `ng build --configuration
  development` limpos
