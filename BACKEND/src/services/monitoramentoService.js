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
// `cal.mes_ref ~ '^\d{4}-\d{2}-\d{2}$'` é defesa contra formato malformado —
// achado ao vivo: uma importação de planilha gravou 37 linhas de
// calendario_leitura (etapa 01-38, aparentando ser o lote de um mês novo)
// com mes_ref = "31/07/2026" (formato DD/MM/YYYY, igual toda outra coluna de
// data do schema) em vez do "YYYY-MM-DD" que esta coluna especificamente
// exige — `to_date(cal.mes_ref, 'YYYY-MM-DD')` sem essa guarda lançava
// "date/time field value out of range" e derrubava a aba Monitoramento de
// Livros inteira (usuário reportou com print). Mesmo padrão de defesa já
// usado em buscarEventosLeitura/obterJornadaColaborador (ADR 0025) — sem o
// filtro, uma única linha malformada quebra a consulta inteira; com ele, só
// essa linha específica de calendario_leitura fica sem match no LEFT JOIN
// (prazo/faixa de dias saem null pro livro daquela etapa, resto continua
// funcionando).
function joinCalendarioContr() {
  return `LEFT JOIN calendario_leitura cal
    ON cal.etapa::int = ${ETAPA_NUM_CONTR_SQL}
    AND cal.mes_ref ~ '^\\d{4}-\\d{2}-\\d{2}$'
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

// contarTabela/contarTotalMassivaDeduplicado (fonte massiva) fazem DISTINCT
// ON e depois LEFT JOIN com cidades_localidades (657 linhas) e
// calendario_leitura (74 linhas) — tabelas minúsculas. O planner do
// Postgres não consegue estimar direito a cardinalidade de saída de um
// DISTINCT ON sobre subquery (chuta ~1 linha) e escolhe Nested Loop pros
// dois LEFT JOIN, mesmo quando a saída real é de milhares de linhas (~13
// mil no lote mais recente, medido ao vivo) — um Nested Loop de 13 mil ×
// (657+74) é o que travava a query por 8-11 MINUTOS (confirmado ao vivo,
// viraram pilha de sessões travadas no banco). `SET LOCAL` (só vale pra
// transação da requisição atual, criada por anexarContextoTenant) força
// Hash Join, que não depende dessa estimativa errada pra ser rápido —
// mesma query caiu pra ~600ms depois de testado ao vivo. Ver ADR 0023.
// (contarFonteContr/obterFaixasDias/detalheContr, fonte leitura/releitura,
// deixaram de precisar de DISTINCT ON quando o scraper parou de abrir OS —
// contr_execucao_leitura já tem 1 linha por livro — mas continuam sob o
// mesmo SET LOCAL, chamado uma vez só no início de obterResumo/obterDetalhe.)
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

// Mesma guarda de formato de cal.mes_ref que joinCalendarioContr (achado ao
// vivo na mesma investigação — calendario_leitura é a mesma tabela nos dois
// casos, o dado malformado quebraria aqui também).
function joinCalendario(aliasTabela) {
  return `LEFT JOIN calendario_leitura cal ON cal.etapa = ${aliasTabela}.etapa
    AND cal.mes_ref ~ '^\\d{4}-\\d{2}-\\d{2}$'
    AND to_date(cal.mes_ref, 'YYYY-MM-DD') = to_date(${aliasTabela}.mes_ref, 'YYYY/MM/DD')`;
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
  if (filtros.colaborador) {
    parametros.push(`%${filtros.colaborador}%`);
    condicoesExtras.push(`${LEITURISTA_CONTR_SQL} ILIKE $${parametros.length + 2}`);
  }
  if (rotulo) condicoesExtras.push(`${STATUS_CONTR_SQL} = '${rotulo}'`);

  // Um livro já tem 1 linha só por lote (desde que o scraper de
  // Acompanhamento parou de abrir OS, ver copelScraperService.js) — sem
  // dedup nem window function pra "escolher" uma UC representante, só lê
  // o cabeçalho do livro direto. Digitados/naoDigitados (progresso real de
  // UC) vêm à parte, de obterProgressoPorLivro (coordenadas_ucs_mineradas
  // + base_dados_leitura), não mais de c.codigo.
  const sql = `
    SELECT c.livro
    FROM contr_execucao_leitura c
    LEFT JOIN cidades_localidades cl ON cl.local = c.localidade
    ${joinCalendarioContr()}
    WHERE c.data_import = $1 AND c.hora_import = $2
      ${condicoesExtras.length ? 'AND ' + condicoesExtras.join(' AND ') : ''}
  `;

  const { rows } = await db.query(sql, [dataImport, horaImport, ...parametros]);
  if (!rows.length) return { ...CONTAGEM_ZERO };

  const progresso = await obterProgressoPorLivro(db, rows.map(r => r.livro), dataImport);
  let leituras = 0;
  for (const linha of rows) {
    const p = progresso.get(linha.livro);
    if (p) leituras += p.digitados + p.naoDigitados;
  }
  return { livros: rows.length, leituras };
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

  // Já 1 linha por livro (ver comentário de contarFonteContr) — sem dedup
  // nem window function. `leituras` de cada livro vem de
  // obterProgressoPorLivro (coordenadas_ucs_mineradas + base_dados_leitura),
  // classificação de faixa e agregação por faixa em JS.
  const sql = `
    SELECT c.livro, ${EFETIVO_PRAZO_REG_SQL} AS efetivo
    FROM contr_execucao_leitura c
    LEFT JOIN cidades_localidades cl ON cl.local = c.localidade
    JOIN prazo_reg_livros preg
      ON preg.livro::int = c.livro::int
      AND preg.mes_ref = to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM-DD')
    WHERE c.data_import = $1 AND c.hora_import = $2
      ${condicoesExtras.length ? 'AND ' + condicoesExtras.join(' AND ') : ''}
  `;

  const { rows } = await db.query(sql, [dataImport, horaImport, ...parametros]);
  const progresso = await obterProgressoPorLivro(db, rows.map(r => r.livro), dataImport);

  const mapa = { menor27: { ...CONTAGEM_ZERO }, igual33: { ...CONTAGEM_ZERO }, maior34: { ...CONTAGEM_ZERO } };
  for (const linha of rows) {
    const efetivo = linha.efetivo;
    if (efetivo == null) continue;
    const faixa = efetivo < 27 ? 'menor27' : efetivo === 33 ? 'igual33' : efetivo >= 34 ? 'maior34' : null;
    if (!faixa) continue;
    const p = progresso.get(linha.livro);
    mapa[faixa].livros += 1;
    mapa[faixa].leituras += p ? p.digitados + p.naoDigitados : 0;
  }
  return mapa;
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
  if (status) condicoesExtras.push(`${STATUS_CONTR_SQL} = '${status}'`);

  const condicaoPrazoExterna = condicaoSqlPrazoContr(filtros.prazo);
  if (condicaoPrazoExterna) condicoesExtras.push(condicaoPrazoExterna);

  // Filtro clicável das faixas <27/33/34+ dias (mesma fórmula de
  // obterFaixasDias). O join com prazo_reg_livros sempre entra agora (não só
  // quando o filtro está ativo) porque dias_prazo_regulatorio também é
  // exposto como coluna pro FRONTEND mostrar o valor bruto na tabela.
  const condicaoFaixa = condicaoFaixaDias(filtros.faixaDias);
  if (condicaoFaixa) condicoesExtras.push(condicaoFaixa);

  if (filtros.colaborador) {
    parametros.push(`%${filtros.colaborador}%`);
    condicoesExtras.push(`${LEITURISTA_CONTR_SQL} ILIKE $${parametros.length + 2}`);
  }

  // Já 1 linha por livro (ver comentário de contarFonteContr) — sem dedup
  // nem window function. digitados/nao_digitados entram depois via
  // obterProgressoPorLivro (coordenadas_ucs_mineradas + base_dados_leitura).
  const sql = `
    SELECT c.livro, c.etapa, cl.regional,
      to_char(${PRAZO_CONTR_SQL}, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS dt_prev_limite,
      ${STATUS_CONTR_SQL} AS status,
      ${LEITURISTA_CONTR_SQL} AS leiturista,
      ${TIPO_SERVICO_CONTR_SQL} AS tipo_servico,
      ${EFETIVO_PRAZO_REG_SQL} AS dias_prazo_regulatorio,
      CASE WHEN c.data_recebimento IS NOT NULL THEN c.data_recebimento || COALESCE(' ' || c.hora_recebimento, '') ELSE NULL END AS data_recebimento
    FROM contr_execucao_leitura c
    LEFT JOIN cidades_localidades cl ON cl.local = c.localidade
    ${joinCalendarioContr()}
    ${joinPrazoRegLivros()}
    WHERE c.data_import = $1 AND c.hora_import = $2
      ${condicoesExtras.length ? 'AND ' + condicoesExtras.join(' AND ') : ''}
    ORDER BY dt_prev_limite ASC NULLS LAST, c.livro ASC
  `;

  const { rows } = await db.query(sql, [dataImport, horaImport, ...parametros]);
  if (!rows.length) return [];

  const progresso = await obterProgressoPorLivro(db, rows.map(r => r.livro), dataImport);
  return rows.map(linha => {
    const p = progresso.get(linha.livro) ?? { digitados: 0, naoDigitados: 0 };
    return {
      status: linha.status,
      tipo_servico: linha.tipo_servico,
      livro: linha.livro,
      etapa: linha.etapa,
      regional: linha.regional,
      dt_prev_limite: linha.dt_prev_limite,
      digitados: p.digitados,
      nao_digitados: p.naoDigitados,
      leiturista: linha.leiturista,
      dias_prazo_regulatorio: linha.dias_prazo_regulatorio,
      data_recebimento: linha.data_recebimento,
    };
  });
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
// `ateData` opcional ("DD/MM/YYYY") — quando informado, restringe às linhas
// digitadas até aquela data (data_import), pra que o fallback de `codigo`
// em montarUcsAtuais (usado quando não há evento de base_dados_leitura até
// `ateData`) também respeite o corte temporal, em vez de sempre mostrar o
// código mais recente independente da data selecionada.
// Desde que o scraper de Acompanhamento parou de abrir OS (ele só lê a
// situação do livro, ver copelScraperService.js), contr_execucao_leitura
// não tem mais `uc` nenhuma — a lista de UCs do livro vem de
// `coordenadas_ucs_mineradas` (minerada à parte, tem unidade_consumidora
// por livro) e o cabeçalho (situação/colaborador/datas) vem da linha mais
// recente de `contr_execucao_leitura` pra este livro (1 linha por ciclo,
// não mais 1 por UC). `codigo` sai sempre NULL daqui — quem preenche de
// verdade é o merge com `eventosUltimaPorUc` (base_dados_leitura) logo
// depois em `montarUcsAtuais`, sem mudança nessa parte.
// Cast numérico (`livro::int`) pro mesmo motivo do comentário de
// buscarMapaCoordenadas: o formato diverge de contr_execucao_leitura só
// por zero à esquerda.
async function consultarUcsBrutasDoLivro(db, livro, ateData) {
  const condicaoData = ateData ? `AND to_date(data_import, 'DD/MM/YYYY') <= to_date($2, 'DD/MM/YYYY')` : '';
  const [{ rows: ucs }, { rows: cabecalhoRows }] = await Promise.all([
    db.query(
      `
      SELECT unidade_consumidora AS uc
      FROM coordenadas_ucs_mineradas
      WHERE livro ~ '^[0-9]+$' AND livro::int = $1::int
      `,
      [livro],
    ),
    db.query(
      `
      SELECT situacao, colaborador, data_import, hora_import, etapa
      FROM contr_execucao_leitura
      WHERE livro = $1
        ${condicaoData}
      ORDER BY id DESC
      LIMIT 1
      `,
      ateData ? [livro, ateData] : [livro],
    ),
  ]);

  const cabecalho = cabecalhoRows[0] || {
    situacao: null,
    colaborador: null,
    data_import: null,
    hora_import: null,
    etapa: null,
  };

  return ucs.map((linha, i) => ({
    id: i,
    uc: linha.uc,
    codigo: null,
    equipamento: null,
    tipo_especificacao: null,
    faturamento: null,
    leitura_atual: null,
    situacao: cabecalho.situacao,
    colaborador: cabecalho.colaborador,
    data_import: cabecalho.data_import,
    hora_import: cabecalho.hora_import,
    etapa: cabecalho.etapa,
  }));
}

// Extrai o código numérico do prefixo de `mensagem` (base_dados_leitura,
// ex.: "094 - LEITURA TELEMEDIDA" -> "094") — substitui o `codigo` de
// contr_execucao_leitura (coluna própria já numérica) como fonte de
// verdade pra UC com evento de leitura real disponível. Ver ADR 0025.
function extrairCodigoDeMensagem(mensagem) {
  const m = /^(\d+)\s*-/.exec(mensagem ?? '');
  return m ? m[1] : null;
}

// Réplica server-side de ehCodigoDeImpedimento
// (FRONTEND/src/app/services/colaboradores.service.ts) — mesma lista de
// códigos administrativos (não é obstrução de campo: telemedida, leitura
// do cliente, plurimensal, troca de medidor, UC fora de rota,
// cadastrar/descadastrar cão feroz), confirmada com o usuário na ADR 0025.
// Não dá pra compartilhar módulo entre os dois runtimes (mesmo padrão já
// visto em deslocamentoService.js) — se a lista mudar num lado, mudar no
// outro. Precisa existir aqui porque listarAtividadeHoje
// (atividadeColaboradoresService.js) computa `impedimentos` no servidor.
const CODIGOS_ADMINISTRATIVOS = new Set(['094', '059', '037', '027', '054', '055', '056']);

function ehImpedimentoReal(codigo) {
  return !!codigo && codigo !== '000' && codigo !== '099' && !CODIGOS_ADMINISTRATIVOS.has(codigo);
}

// "DD/MM/YYYY" + "HH:MM:SS" -> "YYYY-MM-DDTHH:MM:SS", só pra comparar
// cronologicamente — string "DD/MM/YYYY" não ordena certo (confirmado ao
// vivo: MIN/MAX de data_da_leitura como texto devolvia o mês errado).
function chaveDataHoraOrdenavel(evento) {
  const [dia, mes, ano] = (evento.data_da_leitura || '').split('/').map(Number);
  const anoStr = Number.isFinite(ano) ? String(ano).padStart(4, '0') : '0000';
  const mesStr = Number.isFinite(mes) ? String(mes).padStart(2, '0') : '00';
  const diaStr = Number.isFinite(dia) ? String(dia).padStart(2, '0') : '00';
  return `${anoStr}-${mesStr}-${diaStr}T${evento.hora_da_leitura || ''}`;
}

// Escolhe UMA linha por UC entre os eventos de leitura de base_dados_leitura
// — 'primeira' pra saber QUANDO a UC virou realizada pela primeira vez
// (timeline), 'ultima' pro estado mais recente (enriquece `atuais`).
// Desempata por especificacao='CON' quando duas linhas têm exatamente a
// mesma data+hora — confirmado ao vivo que a mesma leitura gera um par
// CON/GTP (grandezas de medição distintas do mesmo evento, mesmo padrão de
// tipo_especificacao já visto em contr_execucao_leitura).
function escolherPorUc(linhas, ordem) {
  const porUc = new Map();
  for (const linha of linhas) {
    const chave = chaveDataHoraOrdenavel(linha);
    const atual = porUc.get(linha.unidade_consumidora);
    if (!atual) {
      porUc.set(linha.unidade_consumidora, { linha, chave });
      continue;
    }
    if (chave === atual.chave) {
      if (linha.especificacao === 'CON' && atual.linha.especificacao !== 'CON') {
        porUc.set(linha.unidade_consumidora, { linha, chave });
      }
      continue;
    }
    const substitui = ordem === 'primeira' ? chave < atual.chave : chave > atual.chave;
    if (substitui) porUc.set(linha.unidade_consumidora, { linha, chave });
  }
  return new Map([...porUc].map(([uc, { linha }]) => [uc, linha]));
}

// Eventos de leitura reais (base_dados_leitura, ADR 0024/0025) do livro —
// data/hora de verdade por UC, não o instante do ciclo de raspagem
// (contr_execucao_leitura.hora_import). `livro` diverge em formato entre as
// duas tabelas (contr_execucao_leitura tem zero à esquerda, "040980";
// base_dados_leitura não, "40980" — confirmado ao vivo), por isso o cast
// ::int dos dois lados em vez de comparação de string — ver índice
// idx_base_dados_leitura_livro_int.
// data_da_leitura/hora_da_leitura em branco existe nos dados reais (achado
// ao vivo, algumas linhas do CSV original vêm sem esses dois campos) —
// sem excluir aqui, chaveDataHoraOrdenavel trata "" como "0000-00-00T",
// que vence QUALQUER data real na comparação `<` e a linha em branco rouba
// o lugar de "primeira realização" de uma UC que na verdade tem data boa
// em outra linha (ou nenhuma, caindo certo no fallback de
// contr_execucao_leitura em montarUcsAtuais). Uma linha sem os dois campos
// não serve pra nada aqui — nunca teria "quando" nem "instante" válido.
//
// O filtro `~ '^\d{2}/\d{2}/\d{4}$'` é por outro achado ao vivo: as 132
// linhas importadas do .xlsx vieram com data_da_leitura em formato ISO
// ("2026-08-31", o ExcelJS devolveu string já formatada assim pra essa
// coluna, não um objeto Date — a conversão de lerXlsx só cobria o caso
// Date) em vez de "DD/MM/YYYY" como o resto da tabela (corrigido direto no
// banco pra essa leva específica). Sem essa validação de formato aqui,
// chaveDataHoraOrdenavel (que faz split('/') na mão, sem to_date) trataria
// uma data malformada futura como "0000-00-00" — mesmo problema da linha
// em branco, silencioso — em vez de simplesmente excluir a linha ruim.
// `ateData` ("DD/MM/YYYY", opcional): quando informado, só considera
// eventos até essa data — visão "ponto no tempo" do livro (ver ADR sobre
// unificar contagens da barra lateral com o painel). Sem `ateData`,
// comportamento idêntico a antes (sempre o estado mais atual).
async function buscarEventosLeitura(db, livro, ateData) {
  const condicaoData = ateData ? `AND to_date(data_da_leitura, 'DD/MM/YYYY') <= to_date($2, 'DD/MM/YYYY')` : '';
  const { rows } = await db.query(
    `
    SELECT unidade_consumidora, data_da_leitura, hora_da_leitura, especificacao, mensagem, equipamento, etapa
    FROM base_dados_leitura
    WHERE livro::int = $1::int
      AND data_da_leitura ~ '^\\d{2}/\\d{2}/\\d{4}$'
      AND hora_da_leitura ~ '^\\d{2}:\\d{2}:\\d{2}$'
      ${condicaoData}
    `,
    ateData ? [livro, ateData] : [livro],
  );
  return rows;
}

// Igual buscarEventosLeitura, mas pra VÁRIOS livros de uma vez, cruzados
// contra o roster completo de contr_execucao_leitura (não só os eventos) —
// usada por listarAtividadeHoje (atividadeColaboradoresService.js) pra
// recalcular digitados/naoDigitados/impedimentos de todo livro que aparece
// na barra lateral num corte só, sem N+1 (uma chamada por livro seria lenta
// com dezenas/centenas de livros ativos). Devolve uma linha por UC de cada
// livro do roster, com `codigo_contr` (contr_execucao_leitura, sempre
// presente) e `mensagem` (base_dados_leitura até `dataBr`, null se não
// achou evento) — quem chama decide o `codigo` final
// (extrairCodigoDeMensagem(mensagem) ?? codigo_contr, mesma regra de
// montarUcsAtuais) e a classificação de impedimento (ehImpedimentoReal).
// Cache em memória (processo) do resultado de obterEventosPorLivrosAteData —
// a consulta varre as 3,5 milhões de linhas de base_dados_leitura inteiras
// (444+ livros no ANY() faz o planner preferir Bitmap Heap Scan a índice, ver
// Adendo 2 da ADR 0025) e a barra lateral chama isso a cada poll de 60s.
// base_dados_leitura só recebe carga em IMPORTAÇÃO EM LOTE DIÁRIA, não muda
// minuto a minuto — TTL de alguns minutos é folga suficiente pra nunca
// pegar dado realmente desatualizado dessa fonte. O lado
// contr_execucao_leitura (`codigo_contr`, roster) fica igualmente cacheado
// por essa janela, mas ele só é USADO como fallback pra UC sem evento em
// base_dados_leitura, e o próprio scraper só revisita um livro a cada
// ~35-50min (ver ADR 0022 Adendo 1) — a defasagem do cache fica bem dentro
// da granularidade natural dessa fonte. Decisão de aceitar essa defasagem
// (não só técnica) confirmada com o usuário antes de implementar.
const CACHE_EVENTOS_TTL_MS = 3 * 60 * 1000;
const cacheEventosPorLivros = new Map();

async function obterEventosPorLivrosAteData(db, livros, dataBr) {
  if (!livros.length) return [];
  // RLS de contr_execucao_leitura/base_dados_leitura decide visibilidade por
  // app.nivel/app.empresa_id (SET LOCAL na transação, ver abrirContextoTenant
  // em config/db.js) — SEM isso na chave, duas empresas diferentes pedindo o
  // mesmo livro/data compartilhariam cache uma da outra, furando o
  // isolamento por tenant. Lidos de volta da própria transação (não
  // recebidos por parâmetro) pra não depender de quem chama passar isso
  // certo.
  const { rows: contextoRows } = await db.query(
    "SELECT current_setting('app.nivel', true) AS nivel, current_setting('app.empresa_id', true) AS empresa_id",
  );
  const { nivel, empresa_id: empresaId } = contextoRows[0];
  // Ordena antes de montar a chave — `livros` chega em ordem de iteração de
  // Map/Set no chamador, não determinística entre chamadas mesmo com o
  // mesmo conjunto de livros.
  const chaveCache = `${nivel}|${empresaId}|${dataBr}|${[...livros].sort().join(',')}`;
  const agora = Date.now();
  const emCache = cacheEventosPorLivros.get(chaveCache);
  if (emCache && emCache.expiraEm > agora) return emCache.rows;

  // livrosInt como parâmetro PRÓPRIO (não um `IN (SELECT ... FROM roster)`)
  // — achado ao vivo com EXPLAIN: passar a lista de livros como subquery de
  // uma CTE faz o planner tratar a cardinalidade como desconhecida e cair
  // pra Seq Scan nos 3,5 milhões de linhas de base_dados_leitura (8s pra 1
  // livro só, mesmo com o índice idx_base_dados_leitura_livro_int
  // existindo). Com o array de inteiros direto como parâmetro, o planner
  // sabe exatamente quais valores buscar e usa o índice de verdade.
  const livrosInt = [...new Set(livros.map(l => Number(l)).filter(Number.isFinite))];
  // work_mem padrão do servidor (4MB) força os dois DISTINCT ON abaixo (até
  // 1,3 milhão de linhas do lado de contr_execucao_leitura) a fazer sort
  // externo em disco — medido ao vivo com EXPLAIN (ANALYZE, BUFFERS): ~2,5s
  // a mais por causa do spill. SET LOCAL vale só para esta transação (cada
  // requisição já roda dentro de uma, via abrirContextoTenant) e não exige
  // privilégio de superusuário — ALTER SYSTEM (mudança global, permanente)
  // tentado primeiro, mas o papel de conexão da aplicação não tem esse
  // privilégio no Supabase self-hosted (só supabase_admin tem).
  await db.query("SET LOCAL work_mem = '160MB'");
  const { rows } = await db.query(
    `
    WITH roster AS (
      -- Roster de UCs por livro vem de coordenadas_ucs_mineradas desde que
      -- o scraper de Acompanhamento parou de abrir OS (contr_execucao_leitura
      -- não tem mais uc). codigo_contr fica sempre NULL — codigo só existe
      -- via base_dados_leitura (join com eventos abaixo). livro reformatado
      -- pro padrão de 6 dígitos de contr_execucao_leitura (mesmo LPAD de
      -- obterUltimaUcRealizadaPorColaborador, atividadeColaboradoresService.js)
      -- pra bater com o formato que quem chama esta função já espera.
      SELECT LPAD(m.livro::int::text, 6, '0') AS livro, m.unidade_consumidora AS uc, NULL::text AS codigo_contr
      FROM coordenadas_ucs_mineradas m
      WHERE m.livro ~ '^[0-9]+$' AND m.livro::int = ANY($2::int[])
    ), eventos AS (
      SELECT DISTINCT ON (b.livro::int, b.unidade_consumidora)
        b.livro::int AS livro_int, b.unidade_consumidora AS uc, b.mensagem
      FROM base_dados_leitura b
      WHERE b.livro::int = ANY($2::int[])
        AND b.data_da_leitura ~ '^\\d{2}/\\d{2}/\\d{4}$'
        AND b.hora_da_leitura ~ '^\\d{2}:\\d{2}:\\d{2}$'
        AND to_date(b.data_da_leitura, 'DD/MM/YYYY') <= to_date($1, 'DD/MM/YYYY')
      ORDER BY b.livro::int, b.unidade_consumidora,
        to_date(b.data_da_leitura, 'DD/MM/YYYY') DESC, b.hora_da_leitura DESC, (b.especificacao = 'CON') DESC
    )
    SELECT r.livro, r.uc, r.codigo_contr, ev.mensagem
    FROM roster r
    LEFT JOIN eventos ev ON ev.livro_int = (r.livro)::int AND ev.uc = r.uc
    `,
    [dataBr, livrosInt],
  );

  cacheEventosPorLivros.set(chaveCache, { rows, expiraEm: agora + CACHE_EVENTOS_TTL_MS });
  // Limpeza simples: se a lista de livros ativos variar muito entre polls
  // (chaves diferentes a cada vez), evita crescer sem limite — o cache
  // perde valor mesmo quando isso acontece, então zerar tudo é seguro.
  if (cacheEventosPorLivros.size > 20) {
    for (const [chave, valor] of cacheEventosPorLivros) {
      if (valor.expiraEm <= agora) cacheEventosPorLivros.delete(chave);
    }
  }

  return rows;
}

// Progresso (digitados/naoDigitados) por LIVRO, pra telas que listam vários
// livros de uma vez (obterResumo/obterFaixasDias/detalheContr aqui e
// calcularLeituraUrbana em leituraUrbanaService.js) — reaproveita
// obterEventosPorLivrosAteData (já cacheado, já tunado pra não cair em Seq
// Scan) em vez de escrever outra consulta em lote do zero: cada UC do
// roster (coordenadas_ucs_mineradas) é "digitada" quando tem evento em
// base_dados_leitura até `dataImport`, mesma regra de
// extrairCodigoDeMensagem(mensagem) ?? codigo_contr já usada em
// atividadeColaboradoresService.js (`codigo_contr` sempre NULL agora que o
// scraper não abre mais OS, mas o fallback não precisa saber disso).
// `dataImport` (não hora_import) como corte é suficiente na prática:
// base_dados_leitura só recebe carga em importação diária, granularidade
// de hora dentro do mesmo dia não muda o resultado.
async function obterProgressoPorLivro(db, livros, dataImport) {
  const eventos = await obterEventosPorLivrosAteData(db, livros, dataImport);
  const mapa = new Map();
  for (const linha of eventos) {
    if (!mapa.has(linha.livro)) mapa.set(linha.livro, { digitados: 0, naoDigitados: 0 });
    const contagem = mapa.get(linha.livro);
    const codigo = extrairCodigoDeMensagem(linha.mensagem) ?? linha.codigo_contr;
    if (codigo) contagem.digitados++;
    else contagem.naoDigitados++;
  }
  return mapa;
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
//
// `eventosUltimaPorUc`: Map<uc, evento de base_dados_leitura> (a leitura
// mais recente de cada UC, ver escolherPorUc) — quando existe, sobrescreve
// codigo/data_import/hora_import/tipo_especificacao com o dado real (ADR
// 0025); UC sem evento lá (import ainda não chegou, ou pendente de
// verdade) mantém o dado original de contr_execucao_leitura, nunca quebra.
// `extrairCodigoDeMensagem` pode devolver null se `mensagem` vier num
// formato inesperado — nesse caso mantém o `codigo` original em vez de
// apagar um código já sabido (`?? resto.codigo`).
function montarUcsAtuais(brutas, eventosUltimaPorUc) {
  const porUc = new Map();
  for (const linha of brutas) {
    const atual = porUc.get(linha.uc);
    if (!atual || linha.id >= atual.id) {
      porUc.set(linha.uc, linha);
    }
  }
  return [...porUc.values()]
    .sort((a, b) => a.uc.localeCompare(b.uc))
    .map(({ id, ...resto }) => {
      const evento = eventosUltimaPorUc.get(resto.uc);
      if (!evento) return resto;
      return {
        ...resto,
        codigo: extrairCodigoDeMensagem(evento.mensagem) ?? resto.codigo,
        data_import: evento.data_da_leitura,
        hora_import: evento.hora_da_leitura,
        tipo_especificacao: evento.especificacao,
      };
    });
}

// Quando cada UC do livro virou realizada — a primeira vez (data+hora REAL
// de leitura, base_dados_leitura, não o ciclo de raspagem) que cada UC
// aparece com um evento. Serve pra reconstruir a timeline "da primeira UC
// realizada até a última execução" (aba Trilho, painel de livro
// específico) com horários de verdade, o que também alimenta corretamente
// o cálculo de deslocamento/pausa (ver anexarSegmentosDeslocamento) e a
// classificação de impedimento (ver ehCodigoDeImpedimento no frontend).
function listarTimelineUcsRealizadasDoLivro(eventosPrimeiraPorUc) {
  return [...eventosPrimeiraPorUc.entries()]
    .sort(([, a], [, b]) => (chaveDataHoraOrdenavel(a) < chaveDataHoraOrdenavel(b) ? -1 : 1))
    .map(([uc, evento]) => ({
      uc,
      codigo: extrairCodigoDeMensagem(evento.mensagem),
      equipamento: evento.equipamento,
      tipo_especificacao: evento.especificacao,
      faturamento: null,
      leitura_atual: null,
      situacao: null,
      colaborador: null,
      data_import: evento.data_da_leitura,
      hora_import: evento.hora_da_leitura,
      etapa: evento.etapa,
    }));
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
// Desde que o scraper de Acompanhamento parou de abrir OS,
// contr_execucao_leitura não tem mais `codigo` por UC — o código de cada
// mês vem de base_dados_leitura (mensagem, mesma extração de
// extrairCodigoDeMensagem usada em todo o resto do arquivo).
async function obterRegimeSucessivo(db, uc) {
  const { rows } = await db.query(
    `
    SELECT DISTINCT ON (date_trunc('month', to_date(data_da_leitura, 'DD/MM/YYYY')))
      date_trunc('month', to_date(data_da_leitura, 'DD/MM/YYYY')) AS mes, mensagem
    FROM base_dados_leitura
    WHERE unidade_consumidora = $1
      AND data_da_leitura ~ '^\\d{2}/\\d{2}/\\d{4}$'
      AND mensagem IS NOT NULL
    ORDER BY mes DESC, to_date(data_da_leitura, 'DD/MM/YYYY') DESC, hora_da_leitura DESC
    `,
    [uc],
  );

  const linhasComCodigo = rows
    .map(linha => ({ mes: linha.mes, codigo: extrairCodigoDeMensagem(linha.mensagem) }))
    .filter(linha => linha.codigo);

  if (!linhasComCodigo.length) return { uc, codigoAtual: null, ciclosConsecutivos: 0, mesesConsecutivos: [] };

  const codigoAtual = linhasComCodigo[0].codigo;
  let ciclos = 0;
  let mesEsperado = null;
  const meses = [];

  for (const linha of linhasComCodigo) {
    if (linha.codigo !== codigoAtual) break;
    if (mesEsperado && linha.mes.getTime() !== mesEsperado.getTime()) break;
    ciclos++;
    meses.push(`${String(linha.mes.getMonth() + 1).padStart(2, '0')}/${linha.mes.getFullYear()}`);
    mesEsperado = new Date(linha.mes.getFullYear(), linha.mes.getMonth() - 1, 1);
  }

  return { uc, codigoAtual, ciclosConsecutivos: ciclos, mesesConsecutivos: meses };
}

// `ateData` opcional ("DD/MM/YYYY") — repassado pra buscarEventosLeitura,
// congela o painel "como o livro estava" naquela data em vez do estado mais
// atual. Frontend manda o dia selecionado no calendário da barra lateral
// (filtroData), pra bater com o mesmo corte que listarAtividadeHoje usa.
async function obterUcsDoLivro(db, livro, ateData) {
  // eventos (base_dados_leitura) e brutas (contr_execucao_leitura) são
  // consultas independentes — buscadas em paralelo, combinadas só depois.
  const [eventos, brutas] = await Promise.all([
    buscarEventosLeitura(db, livro, ateData),
    consultarUcsBrutasDoLivro(db, livro, ateData),
  ]);
  const eventosPrimeiraPorUc = escolherPorUc(eventos, 'primeira');
  const eventosUltimaPorUc = escolherPorUc(eventos, 'ultima');

  const atuaisBrutas = montarUcsAtuais(brutas, eventosUltimaPorUc);
  const timelineBruta = listarTimelineUcsRealizadasDoLivro(eventosPrimeiraPorUc);

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

// Desde que o scraper de Acompanhamento parou de abrir OS,
// contr_execucao_leitura passou a gravar 1 linha por LIVRO por ciclo (não
// mais 1 por UC) — cada linha já É um "ponto no tempo" direto, sem
// precisar de dedup por UC nem SUM/GROUP BY (a versão antiga, que reagia a
// c.codigo por linha, ficaria sempre com digitados=0 agora). O que muda de
// verdade ao longo do tempo (digitados/naoDigitados) passa a vir de
// cruzar o roster de UCs do livro (coordenadas_ucs_mineradas) com a
// primeira leitura real de cada UC (base_dados_leitura, via
// buscarEventosLeitura/escolherPorUc — mesmo par já usado por
// obterUcsDoLivro pra montar a timeline): pra cada ponto, `digitados` é
// quantas UCs do roster já tinham leitura registrada até aquele instante.
async function historicoContrLivro(db, livro) {
  const sqlPontos = `
    SELECT ${STATUS_CONTR_SQL} AS status,
      ${TIPO_SERVICO_CONTR_SQL} AS tipo_servico,
      c.etapa, cl.regional, c.data_import, c.hora_import,
      to_char(${PRAZO_CONTR_SQL}, 'YYYY-MM-DD') AS dt_prev_limite,
      ${LEITURISTA_CONTR_SQL} AS leiturista
    FROM contr_execucao_leitura c
    LEFT JOIN cidades_localidades cl ON cl.local = c.localidade
    ${joinCalendarioContr()}
    WHERE c.livro = $1
    ORDER BY c.data_import, c.hora_import
  `;

  const sqlTotalUcs = `
    SELECT count(*)::int AS total
    FROM coordenadas_ucs_mineradas
    WHERE livro ~ '^[0-9]+$' AND livro::int = $1::int
  `;

  const [{ rows: pontos }, { rows: totalRows }, eventos] = await Promise.all([
    db.query(sqlPontos, [livro]),
    db.query(sqlTotalUcs, [livro]),
    buscarEventosLeitura(db, livro),
  ]);

  const totalUcs = totalRows[0]?.total ?? 0;
  const primeiraPorUc = escolherPorUc(eventos, 'primeira');
  // Chaves ordenáveis (YYYY-MM-DDTHH:MM:SS) de cada primeira leitura, já
  // extraídas uma vez — evita recalcular por UC a cada ponto do histórico.
  const chavesLeitura = [...primeiraPorUc.values()].map(chaveDataHoraOrdenavel);

  return pontos.map(linha => {
    const chavePonto = chaveDataHoraOrdenavel({ data_da_leitura: linha.data_import, hora_da_leitura: linha.hora_import });
    const digitados = chavesLeitura.filter(chave => chave <= chavePonto).length;
    return {
      status: linha.status,
      tipoServico: linha.tipo_servico,
      etapa: linha.etapa,
      regional: linha.regional,
      dataImport: linha.data_import,
      horaImport: linha.hora_import,
      dtPrevLimite: linha.dt_prev_limite ? String(linha.dt_prev_limite).split(' ')[0] : null,
      digitados,
      naoDigitados: Math.max(0, totalUcs - digitados),
      leiturista: linha.leiturista,
    };
  });
}

module.exports = {
  obterResumo,
  obterOpcoesFiltro,
  obterDetalhe,
  obterHistoricoLivro,
  obterUcsDoLivro,
  obterRegimeSucessivo,
  ehImpedimentoReal,
  extrairCodigoDeMensagem,
  obterEventosPorLivrosAteData,
  obterProgressoPorLivro,
};
