// ── fontes "massiva" (tabelas de staging do scraper de massivas) ──
const TABELAS_MASSIVA = {
  pendentes: { nome: 'pendentes_im', temLeiturista: false, rotulo: 'Pendente' },
  atribuidas: { nome: 'atribuidas_im', temLeiturista: true, rotulo: 'Atribuída' },
  emExecucao: { nome: 'em_execucao_im', temLeiturista: true, rotulo: 'Em Execução' },
};

const CONTAGEM_ZERO = { livros: 0, leituras: 0 };
const ROTULO_STATUS = { pendentes: 'Pendente', atribuidas: 'Atribuída', emExecucao: 'Em Execução' };

// ── status/leiturista de leitura/releitura vêm da coluna situacao de
// contr_execucao_leitura, não de qual tabela a linha está — mesmo formato
// "Em Execução (X - NOME)" / "Atribuída (X - NOME)" já usado em
// atividadeColaboradoresService.js, só que calculado em SQL aqui.
const STATUS_CONTR_SQL = `
  CASE
    WHEN c.situacao ~ '^Em Execução' THEN 'Em Execução'
    WHEN c.situacao ~ '^Atribuída' THEN 'Atribuída'
    ELSE 'Pendente'
  END
`;
const LEITURISTA_CONTR_SQL = `
  CASE
    WHEN c.situacao ~ '^(Em Execução|Atribuída)'
    THEN trim(regexp_replace(c.situacao, '^(?:Em Execução|Atribuída)\\s*\\([^-]*-(.*)\\)$', '\\1'))
    ELSE NULL
  END
`;

// ── leitura vs releitura: só a data manda, independente da situação ──
// tudo que foi recebido até o prazo é leitura; depois do prazo é releitura;
// sem data_recebimento ainda (situação em aberto) não bate em nenhum dos
// dois quando o filtro pede um tipo específico — só aparece em "todos".
function condicaoTipoServico(tipo) {
  if (tipo === 'leitura') {
    return `c.data_recebimento IS NOT NULL AND to_date(c.data_recebimento, 'DD/MM/YYYY') <= to_date(split_part(c.data_prevista_limite, ' ', 1), 'DD/MM/YYYY')`;
  }
  if (tipo === 'releitura') {
    return `c.data_recebimento IS NOT NULL AND to_date(c.data_recebimento, 'DD/MM/YYYY') > to_date(split_part(c.data_prevista_limite, ' ', 1), 'DD/MM/YYYY')`;
  }
  return null;
}

// Mesma regra de condicaoTipoServico, como expressão reaproveitável (o
// prazo de cada linha também depende do tipo — ver PRAZO_CONTR_SQL).
const TIPO_SERVICO_CONTR_SQL = `
  CASE
    WHEN c.data_recebimento IS NULL THEN NULL
    WHEN to_date(c.data_recebimento, 'DD/MM/YYYY') <= to_date(split_part(c.data_prevista_limite, ' ', 1), 'DD/MM/YYYY') THEN 'leitura'
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

  const digitados = condicaoQuantidade('c.qtd_digitados_nao_digitados');
  const naoDigitados = condicaoQuantidadeNao('c.qtd_digitados_nao_digitados');

  const sql = `
    SELECT COUNT(*)::int AS livros, COALESCE(SUM(digitados) + SUM(nao_digitados), 0)::int AS leituras
    FROM (
      SELECT DISTINCT ON (c.livro) c.livro, ${digitados} AS digitados, ${naoDigitados} AS nao_digitados,
        ${STATUS_CONTR_SQL} AS status_calc,
        ${LEITURISTA_CONTR_SQL} AS leiturista_calc
      FROM contr_execucao_leitura c
      LEFT JOIN cidades_localidades cl ON cl.local = c.localidade
      ${joinCalendarioContr()}
      WHERE c.data_import = $1 AND c.hora_import = $2
        ${condicoesExtras.length ? 'AND ' + condicoesExtras.join(' AND ') : ''}
      ORDER BY c.livro, (${digitados} + ${naoDigitados}) ASC
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

// Faixas de "dias efetivos" por livro, a partir de prazo_reg_livros — tabela
// separada das outras fontes (massiva/leitura/releitura), sem relação com
// tipoServico. Regra dada pelo usuário: dias_finais é o nº de dias entre a
// primeira leitura e o prazo regulatório (prazo_calendario) — um valor fixo
// por livro, não "dias em atraso ao vivo". Pra saber o atraso de hoje, ajusta
// esse valor pela diferença entre hoje e prazo_calendario: cada dia depois
// do prazo soma 1, cada dia antes subtrai 1. Ex.: dias_finais=33,
// prazo_calendario ontem → hoje conta 34; prazo_calendario daqui 6 dias →
// hoje conta 27.
async function obterFaixasDias(db, filtros) {
  const condicoes = [`mes_ref = to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM-DD')`];
  const parametros = [];
  if (filtros.regional) {
    parametros.push(filtros.regional);
    condicoes.push(`regional = $${parametros.length}`);
  }

  const sql = `
    SELECT faixa, COUNT(*)::int AS total
    FROM (
      SELECT
        CASE
          WHEN efetivo < 27 THEN 'menor27'
          WHEN efetivo = 33 THEN 'igual33'
          WHEN efetivo >= 34 THEN 'maior34'
        END AS faixa
      FROM (
        SELECT dias_finais::int + (CURRENT_DATE - to_date(prazo_calendario, 'YYYY-MM-DD')) AS efetivo
        FROM prazo_reg_livros
        WHERE ${condicoes.join(' AND ')}
      ) calc
    ) classificado
    WHERE faixa IS NOT NULL
    GROUP BY faixa
  `;

  const { rows } = await db.query(sql, parametros);
  const mapa = Object.fromEntries(rows.map(r => [r.faixa, r.total]));
  return { menor27: mapa.menor27 ?? 0, igual33: mapa.igual33 ?? 0, maior34: mapa.maior34 ?? 0 };
}

async function obterResumo(db, filtros) {
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
      faixasDias: { menor27: 0, igual33: 0, maior34: 0 },
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

  const [pendentes, atribuidas, emExecucao, total, noPrazo, prazoFinal, atrasadas, faixasDias] = await Promise.all([
    contarStatus('pendentes'),
    contarStatus('atribuidas'),
    contarStatus('emExecucao'),
    contarTotal(),
    contarTotal({ condicaoPrazo: 'noPrazo' }),
    contarTotal({ condicaoPrazo: 'final' }),
    contarTotal({ condicaoPrazo: 'atrasada' }),
    obterFaixasDias(db, filtros),
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
          ${leituristaSelect} AS leiturista
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
    SELECT status, tipo_servico, livro, etapa, regional, dt_prev_limite, digitados, nao_digitados, leiturista
    FROM (
      SELECT DISTINCT ON (u.status, u.livro)
        u.status, u.tipo_servico, u.livro, u.etapa, cl.regional,
        to_date(u.dt_prev_limite, 'YYYY-MM-DD') AS dt_prev_limite,
        u.digitados, u.nao_digitados, u.leiturista
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
  const digitados = condicaoQuantidade('c.qtd_digitados_nao_digitados');
  const naoDigitados = condicaoQuantidadeNao('c.qtd_digitados_nao_digitados');

  const condicaoPrazoExterna = condicaoSqlPrazoContr(filtros.prazo);
  if (condicaoPrazoExterna) condicoesExtras.push(condicaoPrazoExterna);

  let filtroColaborador = '';
  if (filtros.colaborador) {
    parametros.push(`%${filtros.colaborador}%`);
    filtroColaborador = `AND leiturista_calc ILIKE $${parametros.length + 2}`;
  }

  const sql = `
    SELECT status_calc AS status, tipo_calc AS tipo_servico, livro, etapa, regional, dt_prev_limite, digitados, nao_digitados, leiturista_calc AS leiturista
    FROM (
      SELECT DISTINCT ON (c.livro) c.livro, c.etapa, cl.regional,
        to_char(${PRAZO_CONTR_SQL}, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS dt_prev_limite,
        ${digitados} AS digitados, ${naoDigitados} AS nao_digitados,
        ${STATUS_CONTR_SQL} AS status_calc,
        ${LEITURISTA_CONTR_SQL} AS leiturista_calc,
        ${TIPO_SERVICO_CONTR_SQL} AS tipo_calc
      FROM contr_execucao_leitura c
      LEFT JOIN cidades_localidades cl ON cl.local = c.localidade
      ${joinCalendarioContr()}
      WHERE c.data_import = $1 AND c.hora_import = $2
        ${condicoesExtras.length ? 'AND ' + condicoesExtras.join(' AND ') : ''}
      ORDER BY c.livro, (${digitados} + ${naoDigitados}) ASC
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
  const digitados = condicaoQuantidade('c.qtd_digitados_nao_digitados');
  const naoDigitados = condicaoQuantidadeNao('c.qtd_digitados_nao_digitados');

  const sql = `
    SELECT ${STATUS_CONTR_SQL} AS status,
      ${TIPO_SERVICO_CONTR_SQL} AS tipo_servico,
      c.etapa, cl.regional, c.data_import, c.hora_import,
      to_char(${PRAZO_CONTR_SQL}, 'YYYY-MM-DD') AS dt_prev_limite,
      SUM(${digitados})::int AS digitados,
      SUM(${naoDigitados})::int AS nao_digitados,
      STRING_AGG(DISTINCT ${LEITURISTA_CONTR_SQL}, ', ' ORDER BY ${LEITURISTA_CONTR_SQL}) AS leiturista
    FROM contr_execucao_leitura c
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

module.exports = { obterResumo, obterOpcoesFiltro, obterDetalhe, obterHistoricoLivro };
