const { calcularSegmento } = require('./deslocamentoService');

// ── fontes "massiva" (tabelas de staging do scraper de massivas) ──
const TABELAS_MASSIVA = {
  pendentes: { nome: 'pendentes_im', temLeiturista: false, rotulo: 'Pendente' },
  atribuidas: { nome: 'atribuidas_im', temLeiturista: true, rotulo: 'Atribuída' },
  emExecucao: { nome: 'em_execucao_im', temLeiturista: true, rotulo: 'Em Execução' },
};

const CONTAGEM_ZERO = { livros: 0, leituras: 0 };
const ROTULO_STATUS = { pendentes: 'Pendente', atribuidas: 'Atribuída', emExecucao: 'Em Execução' };

// ── status de leitura/releitura vem da coluna situacao de
// contr_execucao_leitura, não de qual tabela a linha está.
const STATUS_CONTR_SQL = `
  CASE
    WHEN c.situacao ~ '^Em Execução' THEN 'Em Execução'
    WHEN c.situacao ~ '^Atribuída' THEN 'Atribuída'
    ELSE 'Pendente'
  END
`;
// Colaborador vem direto da coluna própria (populada no import — ver
// parseSituacaoColaborador em copelImportService.js). Antes disso existir,
// esta constante tentava re-extrair o nome via regex de dentro de
// `situacao` (formato antigo "Em Execução (X-NOME)") — mas `situacao` já
// vem limpo do banco desde então, então o regex nunca mais casava e
// `leiturista_calc` saía igual a `c.situacao`, não o nome do colaborador.
const LEITURISTA_CONTR_SQL = 'c.colaborador';

// ── leitura vs releitura: só a data manda, independente da situação ──
// recebido antes do prazo é leitura; recebido no prazo ou depois é releitura
// (usuário confirmou: data_recebimento >= data_prevista_limite já é
// releitura, não só estritamente depois); sem data_recebimento ainda
// (situação em aberto) não bate em nenhum dos dois quando o filtro pede um
// tipo específico — só aparece em "todos".
function condicaoTipoServico(tipo) {
  if (tipo === 'leitura') {
    return `c.data_recebimento IS NOT NULL AND to_date(c.data_recebimento, 'DD/MM/YYYY') < to_date(split_part(c.data_prevista_limite, ' ', 1), 'DD/MM/YYYY')`;
  }
  if (tipo === 'releitura') {
    return `c.data_recebimento IS NOT NULL AND to_date(c.data_recebimento, 'DD/MM/YYYY') >= to_date(split_part(c.data_prevista_limite, ' ', 1), 'DD/MM/YYYY')`;
  }
  return null;
}

// Mesma regra de condicaoTipoServico, como expressão reaproveitável (o
// prazo de cada linha também depende do tipo — ver PRAZO_CONTR_SQL).
const TIPO_SERVICO_CONTR_SQL = `
  CASE
    WHEN c.data_recebimento IS NULL THEN NULL
    WHEN to_date(c.data_recebimento, 'DD/MM/YYYY') < to_date(split_part(c.data_prevista_limite, ' ', 1), 'DD/MM/YYYY') THEN 'leitura'
    ELSE 'releitura'
  END
`;

// contr_execucao_leitura.etapa não vem limpo — o scraper grava "ETAPA 18 -
// (528)" (o número entre parênteses é uma contagem que varia a cada ciclo,
// não faz parte da etapa). Extrai só o número, mesma ideia do regex já usado
// em atividadeColaboradoresService.js pro mesmo problema.
const ETAPA_NUM_CONTR_SQL = `substring(c.etapa from '[0-9]+')::int`;

// Confirmado com o usuário: etapas 01–19 são urbanas, 21–38 são rurais (não
// existe etapa 20). Decide o SLA de releitura (24h/48h) e, por tabela, qual
// linha de calendario_leitura vale.
const ETAPA_URBANA_CONTR_SQL = `${ETAPA_NUM_CONTR_SQL} BETWEEN 1 AND 19`;

// calendario_leitura não tem uma FK direta em contr_execucao_leitura (não
// existe coluna mes_ref lá) — o mês é inferido a partir do mês de
// data_prevista_limite, que na prática já é o mesmo prazo de
// calendario_leitura.prazo_leitura pra linhas de leitura (conferido contra o
// banco: etapa 18/mês 2026-08 bate 26/08/2026 nos dois lugares).
function joinCalendarioContr() {
  return `LEFT JOIN calendario_leitura cal
    ON cal.etapa::int = ${ETAPA_NUM_CONTR_SQL}
    AND to_date(cal.mes_ref, 'YYYY-MM-DD') = date_trunc('month', to_date(split_part(c.data_prevista_limite, ' ', 1), 'DD/MM/YYYY'))`;
}

// Prazo de releitura: hora exata do recebimento + 24h (urbana) ou 48h
// (rural) — SLA por horas, não por dia de calendário. to_timestamp() devolve
// timestamptz; ::timestamp descarta o timezone da sessão pra tratar tudo
// como hora local "crua" (mesmo padrão de to_date, sem timezone) — sem o
// cast, misturar com PRAZO_LEITURA_SQL (timestamp sem tz) no mesmo CASE
// arriscaria deslocar a hora dependendo do timezone configurado na conexão.
const PRAZO_RELEITURA_SQL = `
  (to_timestamp(c.data_recebimento || ' ' || COALESCE(c.hora_recebimento, '00:00'), 'DD/MM/YYYY HH24:MI')::timestamp
    + CASE WHEN ${ETAPA_URBANA_CONTR_SQL} THEN INTERVAL '24 hours' ELSE INTERVAL '48 hours' END)
`;

// Prazo de leitura (e de linha ainda pendente, sem data_recebimento): a data
// limite da etapa no calendário, fim do dia (pra "hoje ainda no prazo" valer
// até 23:59:59, não expirar à meia-noite).
const PRAZO_LEITURA_SQL = `(to_date(cal.prazo_leitura, 'YYYY-MM-DD') + INTERVAL '23:59:59')`;

// Prazo efetivo da linha — depende do tipo calculado (ver TIPO_SERVICO_CONTR_SQL).
//
// Nunca devolver isso cru (tipo timestamp) pro node: o driver `pg` converte
// `timestamp without time zone` pro fuso horário do PROCESSO NODE, não UTC —
// resultado: "2026-08-13 23:59:59" (hora de parede, sem fuso real) virava
// "2026-08-14T02:59:59.000Z" no JSON (+3h, fuso de Brasília do host). Bug
// pego só porque testei o valor de verdade, não só se a query rodava sem
// erro. Todo consumidor deste valor formata com to_char(...'"Z"') em vez de
// deixar o driver serializar — ver detalheContr/historicoContrLivro.
const PRAZO_CONTR_SQL = `
  CASE WHEN ${TIPO_SERVICO_CONTR_SQL} = 'releitura' THEN ${PRAZO_RELEITURA_SQL}
       ELSE ${PRAZO_LEITURA_SQL}
  END
`;

// "Agora" pro cálculo de atraso é o momento do último scrape (data_import +
// hora_import), não o relógio real — mesmo padrão já usado em todo o resto
// do app (dt_import/hr_import da massiva, hojeUtcMs() no FRONTEND). ::timestamp
// pelo mesmo motivo do PRAZO_RELEITURA_SQL (comparado direto com ele).
const IMPORT_TS_CONTR_SQL = `to_timestamp(c.data_import || ' ' || c.hora_import, 'DD/MM/YYYY HH24:MI:SS')::timestamp`;

// contarFonteContr/obterFaixasDias/detalheContr fazem DISTINCT ON sobre uma
// subquery de dedup (contrDedupSql) e depois LEFT JOIN com cidades_localidades
// (657 linhas) e calendario_leitura (74 linhas) — tabelas minúsculas. O
// planner do Postgres não consegue estimar direito a cardinalidade de saída
// de um DISTINCT ON sobre subquery (chuta ~1 linha) e escolhe Nested Loop
// pros dois LEFT JOIN, mesmo quando a saída real do dedup é de milhares de
// linhas (~13 mil no lote mais recente, medido ao vivo) — um Nested Loop de
// 13 mil × (657+74) é o que travava a query por 8-11 MINUTOS (confirmado ao
// vivo, viraram pilha de sessões travadas no banco). `SET LOCAL` (só vale
// pra transação da requisição atual, criada por anexarContextoTenant) força
// Hash Join, que não depende dessa estimativa errada pra ser rápido —
// mesma query caiu pra ~600ms depois de testado ao vivo. Ver ADR 0023.
async function desligarNestedLoop(db) {
  await db.query('SET LOCAL enable_nestloop = off');
}

async function obterUltimoBatchMassiva(db) {
  const { rows } = await db.query(`
    SELECT dt_import, hr_import
    FROM pendentes_im
    ORDER BY id DESC
    LIMIT 1
  `);
  return rows[0] || null;
}

async function obterUltimoBatchLeitura(db) {
  const { rows } = await db.query(`
    SELECT data_import, hora_import
    FROM contr_execucao_leitura
    ORDER BY id DESC
    LIMIT 1
  `);
  return rows[0] || null;
}

function chavesAtivas(status) {
  return status && status !== 'todos' ? [status] : ['pendentes', 'atribuidas', 'emExecucao'];
}

// tipoServico ativo(s) a partir do filtro escolhido na tela.
function fontesAtivas(tipoServico) {
  if (tipoServico === 'massiva') return { massiva: true, leitura: false, releitura: false };
  if (tipoServico === 'leitura') return { massiva: false, leitura: true, releitura: false };
  if (tipoServico === 'releitura') return { massiva: false, leitura: false, releitura: true };
  // 'leiturarelitura': "todos" da aba Monitoramento de Livros — leitura + releitura,
  // nunca massiva (essa tem aba própria, ver ADR 0010).
  if (tipoServico === 'leiturarelitura') return { massiva: false, leitura: true, releitura: true };
  return { massiva: true, leitura: true, releitura: true }; // 'todos' ou vazio
}

// O prazo oficial da massiva não vem do dado raspado (dt_prev_limite, por
// item e pouco confiável) e sim de calendario_leitura.prazo_massiva, um
// prazo único por etapa+mes_ref. Requer JOIN calendario_leitura cal ON
// cal.etapa = t.etapa AND cal.mes_ref = t.mes_ref (ver joinCalendario).
function condicaoSqlPrazo(tipo) {
  if (tipo === 'final') {
    return `to_date(cal.prazo_massiva, 'YYYY-MM-DD') = to_date(t.dt_import, 'DD/MM/YYYY')`;
  }
  if (tipo === 'atrasada') {
    return `to_date(cal.prazo_massiva, 'YYYY-MM-DD') < to_date(t.dt_import, 'DD/MM/YYYY')`;
  }
  if (tipo === 'noPrazo') {
    return `to_date(cal.prazo_massiva, 'YYYY-MM-DD') > to_date(t.dt_import, 'DD/MM/YYYY')`;
  }
  return null;
}

// Equivalente ao condicaoSqlPrazo, mas pro dado de leitura/releitura.
// PRAZO_CONTR_SQL já é hora-a-hora pra releitura (recebimento + 24h/48h) e
// fim-do-dia pra leitura/pendente (calendário) — "atrasada" por isso compara
// timestamp cheio contra IMPORT_TS_CONTR_SQL, não só a data. "final"/"noPrazo"
// continuam por dia (mesmo dia do prazo / depois do prazo), pra bater com o
// resto do app (cards e cores da tabela).
function condicaoSqlPrazoContr(tipo) {
  if (tipo === 'final') {
    return `date_trunc('day', ${PRAZO_CONTR_SQL}) = date_trunc('day', ${IMPORT_TS_CONTR_SQL}) AND ${PRAZO_CONTR_SQL} >= ${IMPORT_TS_CONTR_SQL}`;
  }
  if (tipo === 'atrasada') {
    return `${PRAZO_CONTR_SQL} < ${IMPORT_TS_CONTR_SQL}`;
  }
  if (tipo === 'noPrazo') {
    return `date_trunc('day', ${PRAZO_CONTR_SQL}) > date_trunc('day', ${IMPORT_TS_CONTR_SQL})`;
  }
  return null;
}

function joinCalendario(aliasTabela) {
  return `LEFT JOIN calendario_leitura cal ON cal.etapa = ${aliasTabela}.etapa AND to_date(cal.mes_ref, 'YYYY-MM-DD') = to_date(${aliasTabela}.mes_ref, 'YYYY/MM/DD')`;
}

function construirCondicoes({ regional, livro, etapa, colaborador, temLeiturista, prazo, condicaoPrazo }) {
  const condicoes = [];
  const parametros = [];

  if (regional) {
    parametros.push(regional);
    condicoes.push(`cl.regional = $${parametros.length + 2}`);
  }
  if (livro) {
    parametros.push(`%${livro}%`);
    condicoes.push(`t.livro ILIKE $${parametros.length + 2}`);
  }
  if (etapa) {
    parametros.push(etapa);
    condicoes.push(`t.etapa = $${parametros.length + 2}`);
  }
  if (colaborador) {
    if (!temLeiturista) {
      return { semResultado: true };
    }
    parametros.push(`%${colaborador}%`);
    condicoes.push(`t.leiturista ILIKE $${parametros.length + 2}`);
  }
  // "prazo" é o filtro escolhido pelo usuário na barra de filtros/cards;
  // "condicaoPrazo" é usado internamente para calcular os números dos
  // cards "Prazo final" e "Atraso". Os dois podem coexistir (ex.: usuário
  // filtrou por Atraso e ainda assim queremos saber quantos desses estão
  // no prazo final — resultado será sempre 0, o que é correto).
  const condicaoExterna = condicaoSqlPrazo(prazo);
  if (condicaoExterna) condicoes.push(condicaoExterna);
  const condicaoInterna = condicaoSqlPrazo(condicaoPrazo);
  if (condicaoInterna) condicoes.push(condicaoInterna);

  return { condicoes, parametros };
}

// A raspagem pode gravar mais de uma linha pro mesmo livro dentro do mesmo
// lote (mesmo dt_import/hr_import), com qtd_digitados_nao_digitados
// diferente entre elas. Pra não inflar os totais, fica só com a linha de
// menor quantidade (digitados + não digitados) por livro.
function condicaoQuantidade(coluna) {
  return `CASE WHEN ${coluna} ~ '^[0-9]+/[0-9]+$' THEN split_part(${coluna}, '/', 1)::int ELSE 0 END`;
}

function condicaoQuantidadeNao(coluna) {
  return `CASE WHEN ${coluna} ~ '^[0-9]+/[0-9]+$' THEN split_part(${coluna}, '/', 2)::int ELSE 0 END`;
}

// Progresso da fonte leitura/releitura: uma UC (uma linha de
// contr_execucao_leitura) é "realizada" quando a coluna `codigo` está
// preenchida (o import já converte string vazia em NULL — ver
// copelImportService.js), "não realizada" quando está NULL.
//
// Duas versões de cada — CRUA (por linha/UC) e agregada POR LIVRO (via
// window function `SUM(...) OVER (PARTITION BY c.livro)`) — porque um
// livro agora tem várias linhas (uma por UC, ver ADR 0018 Adendo 2) e as
// duas formas de consultar essa tabela precisam de uma ou de outra:
// queries com `GROUP BY` de verdade (historicoContrLivro) usam a crua
// dentro do próprio SUM; queries com `DISTINCT ON (c.livro)` (que
// escolhem UMA linha pra representar o livro, mas ainda assim precisam do
// total de TODAS as UCs dele) usam a agregada. Nunca reaproveitar uma no
// lugar da outra: a crua sozinha numa DISTINCT ON reintroduz o mesmo bug
// que isso corrige (conta só a UC escolhida, não o livro inteiro); a
// agregada dentro de um SUM (agregado sobre agregado) é erro de sintaxe.
//
// Essa agregação só fica correta enquanto nenhum filtro do WHERE dessas
// queries discriminar por UC (hoje todos — tipoServico, prazo, faixaDias,
// regional, livro, etapa — vêm de campos de cabeçalho, idênticos em toda
// UC do mesmo livro): um filtro por UC no futuro faria a window function
// refletir só o subconjunto filtrado, não o livro inteiro.
//
// Fonte massiva (t.qtd_digitados_nao_digitados, pendentes_im/atribuidas_im/
// em_execucao_im) não foi tocada — continua usando
// condicaoQuantidade/condicaoQuantidadeNao normalmente.
const CONTR_REALIZADO_LINHA_SQL = 'CASE WHEN c.codigo IS NOT NULL THEN 1 ELSE 0 END';
const CONTR_NAO_REALIZADO_LINHA_SQL = 'CASE WHEN c.codigo IS NULL THEN 1 ELSE 0 END';
// `SUM(...) OVER(...)` devolve bigint no Postgres — sem o cast, o driver
// `pg` manda esse valor pro Node como STRING (pra não perder precisão em
// bigint grande), e "169" + "12" vira concatenação ("16912"), não soma
// (169+12=181). Resultado visto ao vivo: progresso de livros com muitas
// UCs saindo grosseiramente errado (169/12 mostrando 1% em vez de ~93%).
// `::int` aqui garante que o valor chega no JS já como number.
const CONTR_REALIZADO_LIVRO_SQL = `(SUM(${CONTR_REALIZADO_LINHA_SQL}) OVER (PARTITION BY c.livro))::int`;
const CONTR_NAO_REALIZADO_LIVRO_SQL = `(SUM(${CONTR_NAO_REALIZADO_LINHA_SQL}) OVER (PARTITION BY c.livro))::int`;

// Deduplica contr_execucao_leitura por UC dentro do lote que gerou cada
// linha (mesmo livro + data_import + hora_import) — bug real encontrado em
// produção: o scraper podia gravar a MESMA UC mais de uma vez no mesmo lote
// (uma exceção dentro do `finally` de abrirEExtrairOs descartava o retorno
// de sucesso e fazia o worker reprocessar um livro que já tinha extraído
// com êxito — corrigido em copelScraperService.js, ver ADR 0018 Adendo 18).
// Sem deduplicar aqui, toda contagem que soma linhas cruas desta tabela
// (CONTR_REALIZADO_LIVRO_SQL/CONTR_NAO_REALIZADO_LIVRO_SQL e o SUM() de
// historicoContrLivro) conta UC duplicada mais de uma vez, inflando
// Realizados/Não realizados/Leituras. `id` (bigserial, estritamente
// cronológico) escolhe a cópia mais recente de cada UC dentro do lote —
// pode haver diferença de `codigo` entre cópias, já que minutos podem se
// passar entre a extração original e a retentativa que causou a duplicata.
//
// Recebe as duas condições de escopo que cada chamador já teria posto no
// WHERE de qualquer forma (por livro+lote, ou só por livro pra
// historicoContrLivro) — dedupilcar SÓ dentro desse escopo, não a tabela
// inteira, mantém a operação barata (a tabela não tem índice que ajude uma
// deduplicação global, mas cada lote tem só uma fração das linhas).
function contrDedupSql(condicaoEscopo) {
  return `(
    SELECT DISTINCT ON (c2.livro, c2.data_import, c2.hora_import, c2.uc) c2.*
    FROM contr_execucao_leitura c2
    WHERE ${condicaoEscopo}
    ORDER BY c2.livro, c2.data_import, c2.hora_import, c2.uc, c2.id DESC
  )`;
}

async function contarTabela(db, chave, dataImport, horaImport, filtros) {
  const { nome, temLeiturista } = TABELAS_MASSIVA[chave];
  const { semResultado, condicoes, parametros } = construirCondicoes({ ...filtros, temLeiturista });

  if (semResultado) {
    return { ...CONTAGEM_ZERO };
  }

  const digitados = condicaoQuantidade('t.qtd_digitados_nao_digitados');
  const naoDigitados = condicaoQuantidadeNao('t.qtd_digitados_nao_digitados');

  const sql = `
    SELECT COUNT(*)::int AS livros, COALESCE(SUM(digitados) + SUM(nao_digitados), 0)::int AS leituras
    FROM (
      SELECT DISTINCT ON (t.livro) t.livro, ${digitados} AS digitados, ${naoDigitados} AS nao_digitados
      FROM ${nome} t
      LEFT JOIN cidades_localidades cl ON cl.local = t.local
      ${joinCalendario('t')}
      WHERE t.dt_import = $1 AND t.hr_import = $2
        ${condicoes.length ? 'AND ' + condicoes.join(' AND ') : ''}
      ORDER BY t.livro, (${digitados} + ${naoDigitados}) ASC
    ) escolhido
  `;

  const { rows: [linha] } = await db.query(sql, [dataImport, horaImport, ...parametros]);
  return { livros: linha?.livros ?? 0, leituras: linha?.leituras ?? 0 };
}

// Contagem da fonte leitura/releitura (contr_execucao_leitura) — uma linha
// por livro já basta (não tem "tabela por status" pra deduplicar entre si
// como na massiva; status vem todo da coluna situacao).
async function contarFonteContr(db, statusChave, tipoServico, dataImport, horaImport, filtros) {
  const rotulo = statusChave ? ROTULO_STATUS[statusChave] : null;
  const temLeiturista = statusChave !== 'pendentes'; // "Pendente" nunca tem leiturista
  if (filtros.colaborador && !temLeiturista) {
    return { ...CONTAGEM_ZERO };
  }

  const condicoesExtras = [];
  const parametros = [];

  if (filtros.regional) {
    parametros.push(filtros.regional);
    condicoesExtras.push(`cl.regional = $${parametros.length + 2}`);
  }
  if (filtros.livro) {
    parametros.push(`%${filtros.livro}%`);
    condicoesExtras.push(`c.livro ILIKE $${parametros.length + 2}`);
  }
  if (filtros.etapa) {
    parametros.push(filtros.etapa);
    condicoesExtras.push(`c.etapa = $${parametros.length + 2}`);
  }

  const condicaoTipo = condicaoTipoServico(tipoServico);
  if (condicaoTipo) condicoesExtras.push(condicaoTipo);
  const condicaoPrazoExterna = condicaoSqlPrazoContr(filtros.prazo);
  if (condicaoPrazoExterna) condicoesExtras.push(condicaoPrazoExterna);
  const condicaoPrazoInterna = condicaoSqlPrazoContr(filtros.condicaoPrazo);
  if (condicaoPrazoInterna) condicoesExtras.push(condicaoPrazoInterna);

  // Realizados/não realizados agregados por LIVRO (todas as UCs dele),
  // não só da UC que o DISTINCT ON abaixo escolhe pra representar o livro
  // — ver comentário de CONTR_REALIZADO_LIVRO_SQL.
  const digitados = CONTR_REALIZADO_LIVRO_SQL;
  const naoDigitados = CONTR_NAO_REALIZADO_LIVRO_SQL;

  const sql = `
    SELECT COUNT(*)::int AS livros, COALESCE(SUM(digitados) + SUM(nao_digitados), 0)::int AS leituras
    FROM (
      SELECT DISTINCT ON (c.livro) c.livro, ${digitados} AS digitados, ${naoDigitados} AS nao_digitados,
        ${STATUS_CONTR_SQL} AS status_calc,
        ${LEITURISTA_CONTR_SQL} AS leiturista_calc
      FROM ${contrDedupSql('c2.data_import = $1 AND c2.hora_import = $2')} c
      LEFT JOIN cidades_localidades cl ON cl.local = c.localidade
      ${joinCalendarioContr()}
      WHERE c.data_import = $1 AND c.hora_import = $2
        ${condicoesExtras.length ? 'AND ' + condicoesExtras.join(' AND ') : ''}
      ORDER BY c.livro, c.id ASC
    ) escolhido
    WHERE 1 = 1
      ${rotulo ? `AND status_calc = '${rotulo}'` : ''}
      ${filtros.colaborador ? `AND leiturista_calc ILIKE $${parametros.length + 3}` : ''}
  `;
  if (filtros.colaborador) parametros.push(`%${filtros.colaborador}%`);

  const { rows: [linha] } = await db.query(sql, [dataImport, horaImport, ...parametros]);
  return { livros: linha?.livros ?? 0, leituras: linha?.leituras ?? 0 };
}

function somarContagens(...contagens) {
  return contagens.reduce(
    (soma, c) => ({ livros: soma.livros + c.livros, leituras: soma.leituras + c.leituras }),
    { ...CONTAGEM_ZERO },
  );
}

const PRIORIDADE_STATUS = { emExecucao: 3, atribuidas: 2, pendentes: 1 };

// Um livro pode aparecer em mais de uma categoria ao mesmo tempo (ex.: parte
// pendente, parte já em execução). Somar as 3 tabelas direto conta esse
// livro mais de uma vez no total; aqui dedupe mantendo só a categoria mais
// avançada (em execução > atribuída > pendente) antes de contar/somar. Só
// vale pra fonte massiva — a de leitura/releitura já tem uma linha só por
// livro (contarFonteContr sem `statusChave` já dá o total sem duplicar).
async function contarTotalMassivaDeduplicado(db, chaves, dataImport, horaImport, filtros) {
  if (chaves.length === 1) {
    return contarTabela(db, chaves[0], dataImport, horaImport, filtros);
  }

  const partes = [];
  const parametros = [];

  for (const chave of chaves) {
    const { nome, temLeiturista } = TABELAS_MASSIVA[chave];
    const { semResultado, condicoes, parametros: paramsTabela } = construirCondicoes({ ...filtros, temLeiturista });
    if (semResultado) continue;

    const condicoesAjustadas = condicoes.map(c => c.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + parametros.length}`));
    const digitados = condicaoQuantidade('t.qtd_digitados_nao_digitados');
    const naoDigitados = condicaoQuantidadeNao('t.qtd_digitados_nao_digitados');

    partes.push(`
      (SELECT DISTINCT ON (t.livro) t.livro, ${digitados} AS digitados, ${naoDigitados} AS nao_digitados,
        ${PRIORIDADE_STATUS[chave]} AS prioridade
      FROM ${nome} t
      LEFT JOIN cidades_localidades cl ON cl.local = t.local
      ${joinCalendario('t')}
      WHERE t.dt_import = $1 AND t.hr_import = $2
        ${condicoesAjustadas.length ? 'AND ' + condicoesAjustadas.join(' AND ') : ''}
      ORDER BY t.livro, (${digitados} + ${naoDigitados}) ASC)
    `);
    parametros.push(...paramsTabela);
  }

  if (!partes.length) return { ...CONTAGEM_ZERO };

  // Cada subconsulta já escolheu a linha de menor quantidade por livro
  // dentro da própria categoria; aqui só falta escolher, por livro, a
  // categoria de maior prioridade.
  const sql = `
    SELECT COUNT(*)::int AS livros, COALESCE(SUM(digitados) + SUM(nao_digitados), 0)::int AS leituras
    FROM (
      SELECT DISTINCT ON (livro) livro, digitados, nao_digitados
      FROM (${partes.join(' UNION ALL ')}) u
      ORDER BY livro, prioridade DESC
    ) dedup
  `;

  const { rows: [linha] } = await db.query(sql, [dataImport, horaImport, ...parametros]);
  return { livros: linha?.livros ?? 0, leituras: linha?.leituras ?? 0 };
}

// Faixas de "dias efetivos" por livro. prazo_reg_livros é só uma tabela de
// CONSULTA (confirmado com o usuário) — nunca fonte de linhas por si só. O
// ponto de partida é sempre o livro de contr_execucao_leitura (mesmo "último
// lote" usado no resto da tela); só entra na contagem quando esse livro TEM
// correspondência em prazo_reg_livros (por número do livro — os dois lados
// são sempre numéricos, mas prazo_reg_livros grava sem zero à esquerda
// enquanto contr_execucao_leitura usa 6 dígitos, daí o ::int em vez de
// comparar as strings). Livro sem linha correspondente em prazo_reg_livros
// simplesmente não aparece em nenhuma faixa — não é "zero", é "não avaliado".
//
// dias_finais é o nº de dias entre a primeira leitura e o prazo regulatório
// (prazo_calendario) — um valor fixo por livro, não "dias em atraso ao
// vivo". Pra saber a situação de hoje, ajusta esse valor pela diferença
// entre "hoje" e prazo_calendario: cada dia depois do prazo soma 1, cada dia
// antes subtrai 1. "Hoje" aqui é o dia do último lote importado
// (c.data_import), não CURRENT_DATE — mesmo princípio já usado em
// IMPORT_TS_CONTR_SQL/PRAZO_CONTR_SQL: o "agora" do app é o momento do
// último scrape, não o relógio real.
//
// Reaproveitada em detalheContr() pro filtro clicável das faixas <27/33/34+
// dias — mesma fórmula, join com LEFT (não INNER) porque aqui o filtro é
// opcional: sem faixaDias selecionada, o join não deve excluir nenhum livro.
//
// Confirmado com o usuário: o prazo regulatório 27/33/34+ dias só vale pra
// LEITURA urbana (etapas 01-19) — releitura e etapa rural (21-38) ficam de
// fora do cálculo inteiramente, mesmo quando o número do livro bate com uma
// linha de prazo_reg_livros (o que pode acontecer: o mesmo livro de leitura
// pode reaparecer como releitura depois). Verificado contra dado real: 275
// dos ~1330 livros com correspondência no último lote eram releitura — sem
// esse filtro, entravam incorretamente na conta. prazo_reg_livros.etapa já
// só tem 01-19 na prática (conferido: 0 linhas rurais no join), então o
// filtro de etapa aqui é defensivo (não muda o resultado hoje, mas deixa a
// regra de negócio explícita em vez de depender só de a planilha nunca ter
// etapa rural por acaso).
const EFETIVO_PRAZO_REG_SQL = `
  CASE WHEN ${TIPO_SERVICO_CONTR_SQL} = 'leitura' AND ${ETAPA_URBANA_CONTR_SQL}
    THEN preg.dias_finais::int + (to_date(c.data_import, 'DD/MM/YYYY') - to_date(preg.prazo_calendario, 'YYYY-MM-DD'))
    ELSE NULL
  END
`;

function joinPrazoRegLivros() {
  return `LEFT JOIN prazo_reg_livros preg
    ON preg.livro::int = c.livro::int
    AND preg.mes_ref = to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM-DD')`;
}

function condicaoFaixaDias(faixa) {
  if (faixa === 'menor27') return `${EFETIVO_PRAZO_REG_SQL} < 27`;
  if (faixa === 'igual33') return `${EFETIVO_PRAZO_REG_SQL} = 33`;
  if (faixa === 'maior34') return `${EFETIVO_PRAZO_REG_SQL} >= 34`;
  return null;
}

async function obterFaixasDias(db, dataImport, horaImport, filtros) {
  const condicoesExtras = [];
  const parametros = [];
  if (filtros.regional) {
    parametros.push(filtros.regional);
    condicoesExtras.push(`cl.regional = $${parametros.length + 2}`);
  }

  // Realizados/não realizados agregados por LIVRO — ver comentário de
  // CONTR_REALIZADO_LIVRO_SQL.
  const digitados = CONTR_REALIZADO_LIVRO_SQL;
  const naoDigitados = CONTR_NAO_REALIZADO_LIVRO_SQL;

  // livros = 1 linha por livro (contagem direta); leituras = soma de
  // digitados+não digitados do próprio livro — mesma dupla {livros,
  // leituras} das outras contagens da tela, pro toggle Livros/Leituras
  // valer aqui também.
  const sql = `
    SELECT faixa, COUNT(*)::int AS livros, COALESCE(SUM(leituras), 0)::int AS leituras
    FROM (
      SELECT
        CASE
          WHEN efetivo < 27 THEN 'menor27'
          WHEN efetivo = 33 THEN 'igual33'
          WHEN efetivo >= 34 THEN 'maior34'
        END AS faixa,
        leituras
      FROM (
        SELECT DISTINCT ON (c.livro)
          c.livro,
          (${digitados} + ${naoDigitados}) AS leituras,
          ${EFETIVO_PRAZO_REG_SQL} AS efetivo
        FROM ${contrDedupSql('c2.data_import = $1 AND c2.hora_import = $2')} c
        LEFT JOIN cidades_localidades cl ON cl.local = c.localidade
        JOIN prazo_reg_livros preg
          ON preg.livro::int = c.livro::int
          AND preg.mes_ref = to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM-DD')
        WHERE c.data_import = $1 AND c.hora_import = $2
          ${condicoesExtras.length ? 'AND ' + condicoesExtras.join(' AND ') : ''}
        ORDER BY c.livro, c.id ASC
      ) x
    ) classificado
    WHERE faixa IS NOT NULL
    GROUP BY faixa
  `;

  const { rows } = await db.query(sql, [dataImport, horaImport, ...parametros]);
  const mapa = Object.fromEntries(rows.map(r => [r.faixa, { livros: r.livros, leituras: r.leituras }]));
  return {
    menor27: mapa.menor27 ?? { ...CONTAGEM_ZERO },
    igual33: mapa.igual33 ?? { ...CONTAGEM_ZERO },
    maior34: mapa.maior34 ?? { ...CONTAGEM_ZERO },
  };
}

async function obterResumo(db, filtros) {
  await desligarNestedLoop(db);
  const fontes = fontesAtivas(filtros.tipoServico);
  const [ultimoBatchMassiva, ultimoBatchLeitura] = await Promise.all([
    fontes.massiva ? obterUltimoBatchMassiva(db) : null,
    fontes.leitura || fontes.releitura ? obterUltimoBatchLeitura(db) : null,
  ]);

  if (!ultimoBatchMassiva && !ultimoBatchLeitura) {
    return {
      dataImport: null,
      horaImport: null,
      pendentes: { ...CONTAGEM_ZERO },
      atribuidas: { ...CONTAGEM_ZERO },
      emExecucao: { ...CONTAGEM_ZERO },
      total: { ...CONTAGEM_ZERO },
      noPrazo: { ...CONTAGEM_ZERO },
      prazoFinal: { ...CONTAGEM_ZERO },
      atrasadas: { ...CONTAGEM_ZERO },
      faixasDias: { menor27: { ...CONTAGEM_ZERO }, igual33: { ...CONTAGEM_ZERO }, maior34: { ...CONTAGEM_ZERO } },
    };
  }

  const chaves = chavesAtivas(filtros.status);

  async function contarStatus(statusChave) {
    const partes = [];
    if (fontes.massiva && ultimoBatchMassiva) {
      partes.push(contarTabela(db, statusChave, ultimoBatchMassiva.dt_import, ultimoBatchMassiva.hr_import, filtros));
    }
    if ((fontes.leitura || fontes.releitura) && ultimoBatchLeitura) {
      const tipo = fontes.leitura && fontes.releitura ? null : fontes.leitura ? 'leitura' : 'releitura';
      partes.push(contarFonteContr(db, statusChave, tipo, ultimoBatchLeitura.data_import, ultimoBatchLeitura.hora_import, filtros));
    }
    return somarContagens(...(await Promise.all(partes)));
  }

  async function contarTotal(filtrosExtra = {}) {
    const combinados = { ...filtros, ...filtrosExtra };
    const partes = [];
    if (fontes.massiva && ultimoBatchMassiva) {
      partes.push(contarTotalMassivaDeduplicado(db, chaves, ultimoBatchMassiva.dt_import, ultimoBatchMassiva.hr_import, combinados));
    }
    if ((fontes.leitura || fontes.releitura) && ultimoBatchLeitura) {
      const tipo = fontes.leitura && fontes.releitura ? null : fontes.leitura ? 'leitura' : 'releitura';
      partes.push(contarFonteContr(db, null, tipo, ultimoBatchLeitura.data_import, ultimoBatchLeitura.hora_import, combinados));
    }
    return somarContagens(...(await Promise.all(partes)));
  }

  // Faixas de dias só fazem sentido pro livro de leitura/releitura (é o que
  // tem correspondência possível em prazo_reg_livros) — sem esse lote, não
  // há o que comparar.
  const faixasDiasPromise =
    (fontes.leitura || fontes.releitura) && ultimoBatchLeitura
      ? obterFaixasDias(db, ultimoBatchLeitura.data_import, ultimoBatchLeitura.hora_import, filtros)
      : Promise.resolve({ menor27: { ...CONTAGEM_ZERO }, igual33: { ...CONTAGEM_ZERO }, maior34: { ...CONTAGEM_ZERO } });

  const [pendentes, atribuidas, emExecucao, total, noPrazo, prazoFinal, atrasadas, faixasDias] = await Promise.all([
    contarStatus('pendentes'),
    contarStatus('atribuidas'),
    contarStatus('emExecucao'),
    contarTotal(),
    contarTotal({ condicaoPrazo: 'noPrazo' }),
    contarTotal({ condicaoPrazo: 'final' }),
    contarTotal({ condicaoPrazo: 'atrasada' }),
    faixasDiasPromise,
  ]);

  return {
    dataImport: ultimoBatchMassiva?.dt_import ?? ultimoBatchLeitura?.data_import ?? null,
    horaImport: ultimoBatchMassiva?.hr_import ?? ultimoBatchLeitura?.hora_import ?? null,
    pendentes,
    atribuidas,
    emExecucao,
    total,
    noPrazo,
    prazoFinal,
    atrasadas,
    faixasDias,
  };
}

async function obterOpcoesFiltro(db, filtros = {}) {
  const fontes = fontesAtivas(filtros.tipoServico);
  const consultas = [];

  if (fontes.massiva) {
    consultas.push(
      db.query(`
        SELECT DISTINCT cl.regional
        FROM (
          SELECT local, dt_import, hr_import FROM pendentes_im
          UNION ALL SELECT local, dt_import, hr_import FROM atribuidas_im
          UNION ALL SELECT local, dt_import, hr_import FROM em_execucao_im
        ) t
        JOIN cidades_localidades cl ON cl.local = t.local
        WHERE cl.regional IS NOT NULL
        ORDER BY cl.regional
      `),
      db.query(`
        SELECT DISTINCT etapa FROM (
          SELECT etapa FROM pendentes_im
          UNION ALL SELECT etapa FROM atribuidas_im
          UNION ALL SELECT etapa FROM em_execucao_im
        ) t
        WHERE etapa IS NOT NULL
        ORDER BY etapa
      `),
    );
  }
  if (fontes.leitura || fontes.releitura) {
    consultas.push(
      db.query(`
        SELECT DISTINCT cl.regional
        FROM contr_execucao_leitura c
        JOIN cidades_localidades cl ON cl.local = c.localidade
        WHERE cl.regional IS NOT NULL
        ORDER BY cl.regional
      `),
      db.query(`SELECT DISTINCT etapa FROM contr_execucao_leitura WHERE etapa IS NOT NULL ORDER BY etapa`),
    );
  }

  const resultados = await Promise.all(consultas);
  const regionais = new Set();
  const etapas = new Set();
  resultados.forEach((r, i) => {
    const alvo = i % 2 === 0 ? regionais : etapas;
    const campo = i % 2 === 0 ? 'regional' : 'etapa';
    r.rows.forEach(linha => alvo.add(linha[campo]));
  });

  return {
    regionais: [...regionais].sort(),
    etapas: [...etapas].sort(),
  };
}

async function obterDetalhe(db, filtros) {
  await desligarNestedLoop(db);
  const fontes = fontesAtivas(filtros.tipoServico);
  const [ultimoBatchMassiva, ultimoBatchLeitura] = await Promise.all([
    fontes.massiva ? obterUltimoBatchMassiva(db) : null,
    fontes.leitura || fontes.releitura ? obterUltimoBatchLeitura(db) : null,
  ]);

  if (!ultimoBatchMassiva && !ultimoBatchLeitura) {
    return { dataImport: null, horaImport: null, linhas: [] };
  }

  const [linhasMassiva, linhasContr] = await Promise.all([
    fontes.massiva && ultimoBatchMassiva
      ? detalheMassiva(db, ultimoBatchMassiva.dt_import, ultimoBatchMassiva.hr_import, filtros)
      : [],
    (fontes.leitura || fontes.releitura) && ultimoBatchLeitura
      ? detalheContr(db, fontes.leitura && fontes.releitura ? null : fontes.leitura ? 'leitura' : 'releitura', ultimoBatchLeitura.data_import, ultimoBatchLeitura.hora_import, filtros)
      : [],
  ]);

  return {
    dataImport: ultimoBatchMassiva?.dt_import ?? ultimoBatchLeitura?.data_import ?? null,
    horaImport: ultimoBatchMassiva?.hr_import ?? ultimoBatchLeitura?.hora_import ?? null,
    linhas: [...linhasMassiva, ...linhasContr],
  };
}

async function detalheMassiva(db, dataImport, horaImport, filtros) {
  const chaves = chavesAtivas(filtros.status);

  const subconsultas = chaves
    .map(chave => {
      const { nome, temLeiturista, rotulo } = TABELAS_MASSIVA[chave];
      const leituristaSelect = temLeiturista ? 't.leiturista' : 'NULL::text';
      return `
        SELECT '${rotulo}' AS status, 'massiva' AS tipo_servico, t.livro, t.etapa, t.local, cal.prazo_massiva AS dt_prev_limite,
          CASE WHEN t.qtd_digitados_nao_digitados ~ '^[0-9]+/[0-9]+$' THEN split_part(t.qtd_digitados_nao_digitados, '/', 1)::int ELSE 0 END AS digitados,
          CASE WHEN t.qtd_digitados_nao_digitados ~ '^[0-9]+/[0-9]+$' THEN split_part(t.qtd_digitados_nao_digitados, '/', 2)::int ELSE 0 END AS nao_digitados,
          ${leituristaSelect} AS leiturista,
          t.dt_rec_abertura AS data_recebimento
        FROM ${nome} t
        ${joinCalendario('t')}
        WHERE t.dt_import = $1 AND t.hr_import = $2
      `;
    })
    .join(' UNION ALL ');

  const condicoesExtras = [];
  const parametros = [];

  if (filtros.regional) {
    parametros.push(filtros.regional);
    condicoesExtras.push(`cl.regional = $${parametros.length + 2}`);
  }
  if (filtros.livro) {
    parametros.push(`%${filtros.livro}%`);
    condicoesExtras.push(`u.livro ILIKE $${parametros.length + 2}`);
  }
  if (filtros.etapa) {
    parametros.push(filtros.etapa);
    condicoesExtras.push(`u.etapa = $${parametros.length + 2}`);
  }
  if (filtros.colaborador) {
    parametros.push(`%${filtros.colaborador}%`);
    condicoesExtras.push(`u.leiturista ILIKE $${parametros.length + 2}`);
  }

  let condicaoPrazoDetalhe = '';
  if (filtros.prazo === 'final') {
    condicaoPrazoDetalhe = `WHERE escolhido.dt_prev_limite = to_date($1, 'DD/MM/YYYY')`;
  } else if (filtros.prazo === 'atrasada') {
    condicaoPrazoDetalhe = `WHERE escolhido.dt_prev_limite < to_date($1, 'DD/MM/YYYY')`;
  } else if (filtros.prazo === 'noPrazo') {
    condicaoPrazoDetalhe = `WHERE escolhido.dt_prev_limite > to_date($1, 'DD/MM/YYYY')`;
  }

  const sql = `
    SELECT status, tipo_servico, livro, etapa, regional, dt_prev_limite, digitados, nao_digitados, leiturista, data_recebimento
    FROM (
      SELECT DISTINCT ON (u.status, u.livro)
        u.status, u.tipo_servico, u.livro, u.etapa, cl.regional,
        to_date(u.dt_prev_limite, 'YYYY-MM-DD') AS dt_prev_limite,
        u.digitados, u.nao_digitados, u.leiturista, u.data_recebimento
      FROM (${subconsultas}) u
      LEFT JOIN cidades_localidades cl ON cl.local = u.local
      WHERE 1 = 1
        ${condicoesExtras.length ? 'AND ' + condicoesExtras.join(' AND ') : ''}
      ORDER BY u.status, u.livro, (u.digitados + u.nao_digitados) ASC
    ) escolhido
    ${condicaoPrazoDetalhe}
    ORDER BY dt_prev_limite ASC NULLS LAST, livro ASC
  `;

  const { rows } = await db.query(sql, [dataImport, horaImport, ...parametros]);
  return rows;
}

async function detalheContr(db, tipoServico, dataImport, horaImport, filtros) {
  const condicoesExtras = [];
  const parametros = [];

  if (filtros.regional) {
    parametros.push(filtros.regional);
    condicoesExtras.push(`cl.regional = $${parametros.length + 2}`);
  }
  if (filtros.livro) {
    parametros.push(`%${filtros.livro}%`);
    condicoesExtras.push(`c.livro ILIKE $${parametros.length + 2}`);
  }
  if (filtros.etapa) {
    parametros.push(filtros.etapa);
    condicoesExtras.push(`c.etapa = $${parametros.length + 2}`);
  }

  const condicaoTipo = condicaoTipoServico(tipoServico);
  if (condicaoTipo) condicoesExtras.push(condicaoTipo);

  const status = filtros.status && filtros.status !== 'todos' ? ROTULO_STATUS[filtros.status] : null;
  // Realizados/não realizados agregados por LIVRO — ver comentário de
  // CONTR_REALIZADO_LIVRO_SQL.
  const digitados = CONTR_REALIZADO_LIVRO_SQL;
  const naoDigitados = CONTR_NAO_REALIZADO_LIVRO_SQL;

  const condicaoPrazoExterna = condicaoSqlPrazoContr(filtros.prazo);
  if (condicaoPrazoExterna) condicoesExtras.push(condicaoPrazoExterna);

  // Filtro clicável das faixas <27/33/34+ dias (mesma fórmula de
  // obterFaixasDias). O join com prazo_reg_livros sempre entra agora (não só
  // quando o filtro está ativo) porque dias_prazo_regulatorio também é
  // exposto como coluna pro FRONTEND mostrar o valor bruto na tabela.
  const condicaoFaixa = condicaoFaixaDias(filtros.faixaDias);
  if (condicaoFaixa) condicoesExtras.push(condicaoFaixa);

  let filtroColaborador = '';
  if (filtros.colaborador) {
    parametros.push(`%${filtros.colaborador}%`);
    filtroColaborador = `AND leiturista_calc ILIKE $${parametros.length + 2}`;
  }

  const sql = `
    SELECT status_calc AS status, tipo_calc AS tipo_servico, livro, etapa, regional, dt_prev_limite, digitados, nao_digitados, leiturista_calc AS leiturista, dias_prazo_regulatorio, data_recebimento
    FROM (
      SELECT DISTINCT ON (c.livro) c.livro, c.etapa, cl.regional,
        to_char(${PRAZO_CONTR_SQL}, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS dt_prev_limite,
        ${digitados} AS digitados, ${naoDigitados} AS nao_digitados,
        ${STATUS_CONTR_SQL} AS status_calc,
        ${LEITURISTA_CONTR_SQL} AS leiturista_calc,
        ${TIPO_SERVICO_CONTR_SQL} AS tipo_calc,
        ${EFETIVO_PRAZO_REG_SQL} AS dias_prazo_regulatorio,
        CASE WHEN c.data_recebimento IS NOT NULL THEN c.data_recebimento || COALESCE(' ' || c.hora_recebimento, '') ELSE NULL END AS data_recebimento
      FROM ${contrDedupSql('c2.data_import = $1 AND c2.hora_import = $2')} c
      LEFT JOIN cidades_localidades cl ON cl.local = c.localidade
      ${joinCalendarioContr()}
      ${joinPrazoRegLivros()}
      WHERE c.data_import = $1 AND c.hora_import = $2
        ${condicoesExtras.length ? 'AND ' + condicoesExtras.join(' AND ') : ''}
      ORDER BY c.livro, c.id ASC
    ) escolhido
    WHERE 1 = 1
      ${status ? `AND status_calc = '${status}'` : ''}
      ${filtroColaborador}
    ORDER BY dt_prev_limite ASC NULLS LAST, livro ASC
  `;

  const { rows } = await db.query(sql, [dataImport, horaImport, ...parametros]);
  return rows;
}

// "DD/MM/YYYY" + "HH:MM:SS" -> epoch, pra ordenar direito entre meses/anos
// diferentes (string simples ordena "01/12" antes de "15/01", que é errado).
function paraEpoch(dataImport, horaImport) {
  const [dia, mes, ano] = (dataImport || '').split('/').map(Number);
  const [h, m, s] = (horaImport || '0:0:0').split(':').map(Number);
  if (!dia || !mes || !ano) return 0;
  return new Date(ano, mes - 1, dia, h || 0, m || 0, s || 0).getTime();
}

async function obterHistoricoLivro(db, livro) {
  const [historicoMassiva, historicoContr] = await Promise.all([
    historicoMassivaLivro(db, livro),
    historicoContrLivro(db, livro),
  ]);

  const linhas = [...historicoMassiva, ...historicoContr].sort(
    (a, b) => paraEpoch(a.dataImport, a.horaImport) - paraEpoch(b.dataImport, b.horaImport),
  );

  const eventos = [];
  let anterior = null;

  for (const linha of linhas) {
    const mudancaStatus = anterior !== null && anterior.status !== linha.status;
    const mudancaColaborador = anterior !== null && !!anterior.leiturista && !!linha.leiturista && anterior.leiturista !== linha.leiturista;

    if (anterior === null || mudancaStatus || mudancaColaborador) {
      eventos.push({
        status: linha.status,
        tipoServico: linha.tipoServico,
        etapa: linha.etapa,
        regional: linha.regional,
        dataImport: linha.dataImport,
        horaImport: linha.horaImport,
        dtPrevLimite: linha.dtPrevLimite,
        digitados: linha.digitados,
        naoDigitados: linha.naoDigitados,
        leiturista: linha.leiturista,
        primeiraAparicao: anterior === null,
        mudancaStatus,
        mudancaColaborador,
      });
    }

    anterior = linha;
  }

  return { livro, eventos };
}

// Todas as linhas de UC de um livro, sem nenhuma agregação — ao contrário
// de historicoContrLivro (que soma tudo por lote via GROUP BY e perde a
// identidade de cada UC), aqui cada linha é uma UC específica num ciclo de
// coleta específico. Um livro coletado em vários ciclos pode ter a mesma
// UC aparecendo mais de uma vez (codigo NULL num ciclo, preenchido no
// seguinte, quando o leiturista finalmente lança a leitura) — é essa
// repetição que permite reconstruir tanto "estado atual de cada UC" quanto
// "quando cada UC virou realizada" a partir da mesma consulta.
async function consultarUcsBrutasDoLivro(db, livro) {
  const { rows } = await db.query(
    `
    SELECT id, uc, codigo, equipamento, tipo_especificacao, faturamento, leitura_atual,
      situacao, colaborador, data_import, hora_import, etapa
    FROM contr_execucao_leitura
    WHERE livro = $1 AND uc IS NOT NULL
    `,
    [livro],
  );
  return rows;
}

// Estado ATUAL de cada UC do livro — pega, por UC, a linha mais recente
// (não importa se realizada ou não, só a mais nova). Serve pra mostrar
// "como está o livro agora, UC por UC" (Monitoramento de Livros).
//
// Desempate por `id` (bigserial, estritamente cronológico), não por
// data_import/hora_import: o scraper às vezes grava a MESMA UC mais de uma
// vez dentro do mesmo lote (mesmo hora_import — só tem granularidade de
// segundo, incapaz de distinguir duplicatas do mesmo lote), às vezes com
// `codigo` diferente entre as cópias. Usuário reportou o sintoma real: card
// do colaborador (que soma linhas cruas do lote) e este painel (que já
// deduplicava por UC, mas com desempate ambíguo pela hora) mostrando
// totais de impedimentos diferentes pro mesmo livro único.
async function listarUcsAtuaisDoLivro(db, livro) {
  const brutas = await consultarUcsBrutasDoLivro(db, livro);
  const porUc = new Map();
  for (const linha of brutas) {
    const atual = porUc.get(linha.uc);
    if (!atual || linha.id >= atual.id) {
      porUc.set(linha.uc, linha);
    }
  }
  return [...porUc.values()]
    .sort((a, b) => a.uc.localeCompare(b.uc))
    .map(({ id, ...resto }) => resto);
}

// Quando cada UC do livro virou realizada — por UC, pega a linha de MENOR
// id em que `codigo` já aparece preenchido (a primeira vez que a leitura
// daquela UC foi vista lançada), ordenado da mais antiga pra mais recente
// (mesmo motivo de usar `id` em vez de hora_import — ver
// listarUcsAtuaisDoLivro). UC que nunca teve `codigo` preenchido em nenhum
// ciclo (ainda não realizada) fica de fora — não tem "quando" pra uma
// coisa que não aconteceu. Serve pra reconstruir a timeline "da primeira
// UC realizada até a última execução" (aba Trilho, painel de livro
// específico).
async function listarTimelineUcsRealizadasDoLivro(db, livro) {
  const brutas = await consultarUcsBrutasDoLivro(db, livro);
  const primeiraRealizacaoPorUc = new Map();
  for (const linha of brutas) {
    if (!linha.codigo) continue;
    const atual = primeiraRealizacaoPorUc.get(linha.uc);
    if (!atual || linha.id < atual.id) {
      primeiraRealizacaoPorUc.set(linha.uc, linha);
    }
  }
  return [...primeiraRealizacaoPorUc.values()]
    .sort((a, b) => a.id - b.id)
    .map(({ id, ...resto }) => resto);
}

// Anexa endereço/coordenada de cada UC (vindos de coordenadas_ucs_mineradas,
// ADR 0021) às linhas já montadas por listarUcsAtuaisDoLivro/
// listarTimelineUcsRealizadasDoLivro — usado tanto pra mostrar o endereço
// embaixo de cada UC na timeline (aba Trilho) quanto pra desenhar a rota no
// mapa (sequencia + lat/long).
//
// Cruza só por unidade_consumidora, sem também filtrar por
// coordenadas_ucs_mineradas.livro: verificado ao vivo que esse `livro`
// diverge do livro operacional em ~99,5% dos casos só por formatação (zeros
// à esquerda, "002435" vs "2435") — a coordenada/endereço de uma UC não muda
// por causa de reatribuição de livro, então filtrar por livro só reduziria
// cobertura sem ganho real. Confirmado também que não há UC duplicada em
// coordenadas_ucs_mineradas (GROUP BY unidade_consumidora HAVING COUNT(*) >
// 1 = 0 linhas), então o Map abaixo nunca precisa desempatar.
async function buscarMapaCoordenadas(db, ucs) {
  if (!ucs.length) return new Map();
  const { rows } = await db.query(
    `
    SELECT unidade_consumidora, latitude, longitude, nom_municipio, localidade,
      endereco, classe_principal, sequencia
    FROM coordenadas_ucs_mineradas
    WHERE unidade_consumidora = ANY($1::text[])
    `,
    [ucs],
  );
  return new Map(rows.map(r => [r.unidade_consumidora, r]));
}

function comCoordenadas(linha, mapaCoordenadas) {
  const coord = mapaCoordenadas.get(linha.uc);
  return {
    ...linha,
    latitude: coord?.latitude ?? null,
    longitude: coord?.longitude ?? null,
    nom_municipio: coord?.nom_municipio ?? null,
    localidade: coord?.localidade ?? null,
    endereco: coord?.endereco ?? null,
    classe_principal: coord?.classe_principal ?? null,
    sequencia: coord?.sequencia ?? null,
  };
}

// Ordem de rota (sequencia) — mesma regra de
// FRONTEND/src/app/services/colaboradores.service.ts#ordenarPorSequencia,
// replicada aqui em JS puro (não dá pra compartilhar módulo entre os dois
// runtimes). `sequencia == null` (UC sem correspondência em
// coordenadas_ucs_mineradas, ~4% dos casos) tem que ir pro FIM via Infinity
// explícito — checar `== null` ANTES de `Number(...)` importa porque
// `Number(null)` é `0` (finito), não `NaN`.
function ordenarPorSequencia(itens) {
  const valor = seq => {
    if (seq == null) return Infinity;
    const n = Number(seq);
    return Number.isFinite(n) ? n : Infinity;
  };
  return [...itens].sort((a, b) => valor(a.sequencia) - valor(b.sequencia) || a.uc.localeCompare(b.uc));
}

// Percorre as UCs do livro na ordem de ROTA (sequencia, não a ordem
// alfabética que `atuais` já vem) calculando o segmento (distância/tempo/
// tipo) entre cada UC realizada e a ÚLTIMA UC realizada antes dela nessa
// mesma ordem — pula UCs ainda pendentes no meio (não têm data/hora pra
// servir de ponto de partida/chegada). Devolve `atuais` na mesma ordem
// ORIGINAL (alfabética, pra não quebrar quem já consome esse array), só com
// os 4 campos novos anexados por UC, mais a distância total do livro.
function anexarSegmentosDeslocamento(atuaisComCoordenadas) {
  const ordenados = ordenarPorSequencia(atuaisComCoordenadas);
  const segmentoPorUc = new Map();
  let ultimoRealizado = null;
  let distanciaTotalMetros = 0;

  for (const item of ordenados) {
    if (!item.codigo) continue;
    const segmento = ultimoRealizado ? calcularSegmento(ultimoRealizado, item) : null;
    if (segmento) {
      segmentoPorUc.set(item.uc, segmento);
      distanciaTotalMetros += segmento.distanciaMetros;
    }
    ultimoRealizado = item;
  }

  const atuais = atuaisComCoordenadas.map(item => {
    const segmento = segmentoPorUc.get(item.uc);
    return {
      ...item,
      intervalo_anterior_segundos: segmento?.intervaloSegundos ?? null,
      distancia_anterior_metros: segmento?.distanciaMetros ?? null,
      velocidade_m_por_min: segmento?.velocidadeMetrosPorMinuto ?? null,
      tipo_intervalo: segmento?.tipo ?? null,
    };
  });

  return { atuais, distanciaTotalMetros };
}

// "Regime sucessivo": quantos MESES consecutivos (não passadas do scraper —
// confirmado com o usuário) uma UC recebeu o MESMO código de impedimento.
// "Ciclo" = mês de leitura: a UC reaparece num livro novo todo mês, e o
// scraper roda 24h contínuo dentro de cada livro — contar passadas do
// scraper deixaria esse número sempre alto pra qualquer UC lida há um
// tempo, sem sentido de alerta. Pega o ÚLTIMO código de cada mês
// (DISTINCT ON), ordena mês DESC, e conta a partir do mais recente enquanto
// o código continuar o mesmo E o mês anterior for exatamente 1 mês antes do
// contado (a query só devolve meses com leitura — sem esse segundo check,
// um mês pulado por atraso de coleta contaria como "consecutivo" mesmo
// sendo um buraco no calendário).
async function obterRegimeSucessivo(db, uc) {
  const { rows } = await db.query(
    `
    SELECT DISTINCT ON (date_trunc('month', to_date(data_import, 'DD/MM/YYYY')))
      date_trunc('month', to_date(data_import, 'DD/MM/YYYY')) AS mes, codigo
    FROM contr_execucao_leitura
    WHERE uc = $1 AND codigo IS NOT NULL
    ORDER BY mes DESC, id DESC
    `,
    [uc],
  );

  if (!rows.length) return { uc, codigoAtual: null, ciclosConsecutivos: 0 };

  const codigoAtual = rows[0].codigo;
  let ciclos = 0;
  let mesEsperado = null;

  for (const linha of rows) {
    if (linha.codigo !== codigoAtual) break;
    if (mesEsperado && linha.mes.getTime() !== mesEsperado.getTime()) break;
    ciclos++;
    mesEsperado = new Date(linha.mes.getFullYear(), linha.mes.getMonth() - 1, 1);
  }

  return { uc, codigoAtual, ciclosConsecutivos: ciclos };
}

async function obterUcsDoLivro(db, livro) {
  const [atuaisBrutas, timelineBruta] = await Promise.all([
    listarUcsAtuaisDoLivro(db, livro),
    listarTimelineUcsRealizadasDoLivro(db, livro),
  ]);

  // Uma única consulta de coordenadas cobrindo os UCs das duas listas juntas
  // (timeline é subconjunto de atuais na prática, mas junta os dois sets por
  // segurança) — mas a APLICAÇÃO do mapa de coordenadas em cada linha é
  // feita separadamente por lista (comCoordenadas), nunca misturando as
  // duas listas num Map só por `uc`: `atuais` e `timeline` podem ter
  // `codigo`/`data_import`/`hora_import` DIFERENTES pra mesma UC (atuais =
  // linha mais recente, timeline = primeira realização) — juntar as duas
  // num único Map por uc faria uma lista sobrescrever o codigo/data da
  // outra, um bug real encontrado e corrigido antes de subir isso.
  const ucs = [...new Set([...atuaisBrutas, ...timelineBruta].map(l => l.uc))];
  const mapaCoordenadas = await buscarMapaCoordenadas(db, ucs);

  const atuaisComCoordenadas = atuaisBrutas.map(l => comCoordenadas(l, mapaCoordenadas));
  const timeline = timelineBruta.map(l => comCoordenadas(l, mapaCoordenadas));
  const { atuais, distanciaTotalMetros } = anexarSegmentosDeslocamento(atuaisComCoordenadas);

  return { livro, atuais, timeline, distanciaTotalMetros };
}

// Um livro pode ter mais de uma linha no mesmo lote (ex.: dois leituristas
// trabalhando nele ao mesmo tempo em em_execucao_im). Agrupa por lote antes
// de comparar, senão a alternância entre as linhas gera falsas trocas de
// colaborador no timeline (mesmo bug já visto na timeline de colaboradores).
async function historicoMassivaLivro(db, livro) {
  const subconsultas = Object.values(TABELAS_MASSIVA)
    .map(({ nome, temLeiturista, rotulo }) => {
      const leituristaSelect = temLeiturista ? 't.leiturista' : 'NULL::text';
      return `
        SELECT '${rotulo}' AS status, 'massiva' AS tipo_servico, t.livro, t.etapa, t.local, t.dt_import, t.hr_import, cal.prazo_massiva AS dt_prev_limite,
          CASE WHEN t.qtd_digitados_nao_digitados ~ '^[0-9]+/[0-9]+$' THEN split_part(t.qtd_digitados_nao_digitados, '/', 1)::int ELSE 0 END AS digitados,
          CASE WHEN t.qtd_digitados_nao_digitados ~ '^[0-9]+/[0-9]+$' THEN split_part(t.qtd_digitados_nao_digitados, '/', 2)::int ELSE 0 END AS nao_digitados,
          ${leituristaSelect} AS leiturista
        FROM ${nome} t
        ${joinCalendario('t')}
        WHERE t.livro = $1
      `;
    })
    .join(' UNION ALL ');

  const sql = `
    SELECT u.status, u.tipo_servico, u.etapa, cl.regional, u.dt_import, u.hr_import,
      MIN(u.dt_prev_limite) AS dt_prev_limite,
      SUM(u.digitados)::int AS digitados,
      SUM(u.nao_digitados)::int AS nao_digitados,
      STRING_AGG(DISTINCT u.leiturista, ', ' ORDER BY u.leiturista) AS leiturista
    FROM (${subconsultas}) u
    LEFT JOIN cidades_localidades cl ON cl.local = u.local
    GROUP BY u.status, u.tipo_servico, u.etapa, cl.regional, u.dt_import, u.hr_import
  `;

  const { rows } = await db.query(sql, [livro]);
  return rows.map(linha => ({
    status: linha.status,
    tipoServico: linha.tipo_servico,
    etapa: linha.etapa,
    regional: linha.regional,
    dataImport: linha.dt_import,
    horaImport: linha.hr_import,
    dtPrevLimite: linha.dt_prev_limite ? String(linha.dt_prev_limite).split(' ')[0] : null,
    digitados: linha.digitados,
    naoDigitados: linha.nao_digitados,
    leiturista: linha.leiturista,
  }));
}

async function historicoContrLivro(db, livro) {
  // Versão CRUA (por linha/UC), não a agregada por livro — esta query já
  // tem GROUP BY de verdade, o SUM() abaixo já agrega sozinho. Usar a
  // versão com window function aqui seria agregado-sobre-agregado (erro de
  // sintaxe) — ver comentário de CONTR_REALIZADO_LIVRO_SQL.
  const digitados = CONTR_REALIZADO_LINHA_SQL;
  const naoDigitados = CONTR_NAO_REALIZADO_LINHA_SQL;

  const sql = `
    SELECT ${STATUS_CONTR_SQL} AS status,
      ${TIPO_SERVICO_CONTR_SQL} AS tipo_servico,
      c.etapa, cl.regional, c.data_import, c.hora_import,
      to_char(${PRAZO_CONTR_SQL}, 'YYYY-MM-DD') AS dt_prev_limite,
      SUM(${digitados})::int AS digitados,
      SUM(${naoDigitados})::int AS nao_digitados,
      STRING_AGG(DISTINCT ${LEITURISTA_CONTR_SQL}, ', ' ORDER BY ${LEITURISTA_CONTR_SQL}) AS leiturista
    FROM ${contrDedupSql('c2.livro = $1')} c
    LEFT JOIN cidades_localidades cl ON cl.local = c.localidade
    ${joinCalendarioContr()}
    WHERE c.livro = $1
    GROUP BY status, tipo_servico, c.etapa, cl.regional, c.data_import, c.hora_import, dt_prev_limite
  `;

  const { rows } = await db.query(sql, [livro]);
  return rows.map(linha => ({
    status: linha.status,
    tipoServico: linha.tipo_servico,
    etapa: linha.etapa,
    regional: linha.regional,
    dataImport: linha.data_import,
    horaImport: linha.hora_import,
    dtPrevLimite: linha.dt_prev_limite ? String(linha.dt_prev_limite).split(' ')[0] : null,
    digitados: linha.digitados,
    naoDigitados: linha.nao_digitados,
    leiturista: linha.leiturista,
  }));
}

module.exports = {
  obterResumo,
  obterOpcoesFiltro,
  obterDetalhe,
  obterHistoricoLivro,
  obterUcsDoLivro,
  obterRegimeSucessivo,
  contrDedupSql,
};
