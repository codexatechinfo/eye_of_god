const TABELAS = {
  pendentes: { nome: 'pendentes_im', temLeiturista: false, rotulo: 'Pendente' },
  atribuidas: { nome: 'atribuidas_im', temLeiturista: true, rotulo: 'Atribuída' },
  emExecucao: { nome: 'em_execucao_im', temLeiturista: true, rotulo: 'Em Execução' },
};

const CONTAGEM_ZERO = { livros: 0, leituras: 0 };

async function obterUltimoBatch(db) {
  const { rows } = await db.query(`
    SELECT dt_import, hr_import
    FROM pendentes_im
    ORDER BY id DESC
    LIMIT 1
  `);
  return rows[0] || null;
}

function chavesAtivas(status) {
  return status && status !== 'todos' ? [status] : ['pendentes', 'atribuidas', 'emExecucao'];
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
  const { nome, temLeiturista } = TABELAS[chave];
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

const PRIORIDADE_STATUS = { emExecucao: 3, atribuidas: 2, pendentes: 1 };

// Um livro pode aparecer em mais de uma categoria ao mesmo tempo (ex.: parte
// pendente, parte já em execução). Somar as 3 tabelas direto conta esse
// livro mais de uma vez no total; aqui dedupe mantendo só a categoria mais
// avançada (em execução > atribuída > pendente) antes de contar/somar.
async function contarTotalDeduplicado(db, chaves, dataImport, horaImport, filtros) {
  if (chaves.length === 1) {
    return contarTabela(db, chaves[0], dataImport, horaImport, filtros);
  }

  const partes = [];
  const parametros = [];

  for (const chave of chaves) {
    const { nome, temLeiturista } = TABELAS[chave];
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

async function obterResumo(db, filtros) {
  const ultimoBatch = await obterUltimoBatch(db);
  if (!ultimoBatch) {
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
    };
  }

  const { dt_import: dataImport, hr_import: horaImport } = ultimoBatch;

  const [pendentes, atribuidas, emExecucao] = await Promise.all([
    contarTabela(db, 'pendentes', dataImport, horaImport, filtros),
    contarTabela(db, 'atribuidas', dataImport, horaImport, filtros),
    contarTabela(db, 'emExecucao', dataImport, horaImport, filtros),
  ]);

  const chaves = chavesAtivas(filtros.status);

  const [total, noPrazo, prazoFinal, atrasadas] = await Promise.all([
    contarTotalDeduplicado(db, chaves, dataImport, horaImport, filtros),
    contarTotalDeduplicado(db, chaves, dataImport, horaImport, { ...filtros, condicaoPrazo: 'noPrazo' }),
    contarTotalDeduplicado(db, chaves, dataImport, horaImport, { ...filtros, condicaoPrazo: 'final' }),
    contarTotalDeduplicado(db, chaves, dataImport, horaImport, { ...filtros, condicaoPrazo: 'atrasada' }),
  ]);

  return {
    dataImport,
    horaImport,
    pendentes,
    atribuidas,
    emExecucao,
    total,
    noPrazo,
    prazoFinal,
    atrasadas,
  };
}

async function obterOpcoesFiltro(db) {
  const ultimoBatch = await obterUltimoBatch(db);
  if (!ultimoBatch) {
    return { regionais: [], etapas: [] };
  }
  const { dt_import: dataImport, hr_import: horaImport } = ultimoBatch;

  const [regionais, etapas] = await Promise.all([
    db.query(
      `
      SELECT DISTINCT cl.regional
      FROM (
        SELECT local, dt_import, hr_import FROM pendentes_im
        UNION ALL SELECT local, dt_import, hr_import FROM atribuidas_im
        UNION ALL SELECT local, dt_import, hr_import FROM em_execucao_im
      ) t
      JOIN cidades_localidades cl ON cl.local = t.local
      WHERE t.dt_import = $1 AND t.hr_import = $2 AND cl.regional IS NOT NULL
      ORDER BY cl.regional
      `,
      [dataImport, horaImport],
    ),
    db.query(
      `
      SELECT DISTINCT etapa FROM (
        SELECT etapa, dt_import, hr_import FROM pendentes_im
        UNION ALL SELECT etapa, dt_import, hr_import FROM atribuidas_im
        UNION ALL SELECT etapa, dt_import, hr_import FROM em_execucao_im
      ) t
      WHERE t.dt_import = $1 AND t.hr_import = $2 AND etapa IS NOT NULL
      ORDER BY etapa
      `,
      [dataImport, horaImport],
    ),
  ]);

  return {
    regionais: regionais.rows.map(r => r.regional),
    etapas: etapas.rows.map(e => e.etapa),
  };
}

async function obterDetalhe(db, filtros) {
  const ultimoBatch = await obterUltimoBatch(db);
  if (!ultimoBatch) {
    return { dataImport: null, horaImport: null, linhas: [] };
  }
  const { dt_import: dataImport, hr_import: horaImport } = ultimoBatch;

  const chaves = chavesAtivas(filtros.status);

  const subconsultas = chaves
    .map(chave => {
      const { nome, temLeiturista, rotulo } = TABELAS[chave];
      const leituristaSelect = temLeiturista ? 't.leiturista' : 'NULL::text';
      return `
        SELECT '${rotulo}' AS status, t.livro, t.etapa, t.local, cal.prazo_massiva AS dt_prev_limite,
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
    SELECT status, livro, etapa, regional, dt_prev_limite, digitados, nao_digitados, leiturista
    FROM (
      SELECT DISTINCT ON (u.status, u.livro)
        u.status, u.livro, u.etapa, cl.regional,
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

  const { rows: linhas } = await db.query(sql, [dataImport, horaImport, ...parametros]);

  return { dataImport, horaImport, linhas };
}

async function obterHistoricoLivro(db, livro) {
  const subconsultas = Object.values(TABELAS)
    .map(({ nome, temLeiturista, rotulo }) => {
      const leituristaSelect = temLeiturista ? 't.leiturista' : 'NULL::text';
      return `
        SELECT '${rotulo}' AS status, t.livro, t.etapa, t.local, t.dt_import, t.hr_import, cal.prazo_massiva AS dt_prev_limite,
          CASE WHEN t.qtd_digitados_nao_digitados ~ '^[0-9]+/[0-9]+$' THEN split_part(t.qtd_digitados_nao_digitados, '/', 1)::int ELSE 0 END AS digitados,
          CASE WHEN t.qtd_digitados_nao_digitados ~ '^[0-9]+/[0-9]+$' THEN split_part(t.qtd_digitados_nao_digitados, '/', 2)::int ELSE 0 END AS nao_digitados,
          ${leituristaSelect} AS leiturista
        FROM ${nome} t
        ${joinCalendario('t')}
        WHERE t.livro = $1
      `;
    })
    .join(' UNION ALL ');

  // Um livro pode ter mais de uma linha no mesmo lote (ex.: dois leituristas
  // trabalhando nele ao mesmo tempo em em_execucao_im). Agrupa por lote antes
  // de comparar, senão a alternância entre as linhas gera falsas trocas de
  // colaborador no timeline (mesmo bug já visto na timeline de colaboradores).
  const sql = `
    SELECT u.status, u.etapa, cl.regional, u.dt_import, u.hr_import,
      MIN(u.dt_prev_limite) AS dt_prev_limite,
      SUM(u.digitados)::int AS digitados,
      SUM(u.nao_digitados)::int AS nao_digitados,
      STRING_AGG(DISTINCT u.leiturista, ', ' ORDER BY u.leiturista) AS leiturista
    FROM (${subconsultas}) u
    LEFT JOIN cidades_localidades cl ON cl.local = u.local
    GROUP BY u.status, u.etapa, cl.regional, u.dt_import, u.hr_import
    ORDER BY to_timestamp(u.dt_import || ' ' || u.hr_import, 'DD/MM/YYYY HH24:MI:SS') ASC
  `;

  const { rows: linhas } = await db.query(sql, [livro]);

  const eventos = [];
  let anterior = null;

  for (const linha of linhas) {
    const mudancaStatus = anterior !== null && anterior.status !== linha.status;
    // Só conta como "mudou de colaborador" quando de fato troca de um
    // leiturista pra outro. Sair de "Pendente" (sem leiturista) pra
    // "Atribuída"/"Em Execução" (primeiro leiturista) é mudança de situação,
    // não de colaborador — antes não tinha leiturista nenhum.
    const mudancaColaborador = anterior !== null && !!anterior.leiturista && !!linha.leiturista && anterior.leiturista !== linha.leiturista;

    if (anterior === null || mudancaStatus || mudancaColaborador) {
      eventos.push({
        status: linha.status,
        etapa: linha.etapa,
        regional: linha.regional,
        dataImport: linha.dt_import,
        horaImport: linha.hr_import,
        dtPrevLimite: linha.dt_prev_limite ? linha.dt_prev_limite.split(' ')[0] : null,
        digitados: linha.digitados,
        naoDigitados: linha.nao_digitados,
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

module.exports = { obterResumo, obterOpcoesFiltro, obterDetalhe, obterHistoricoLivro };
