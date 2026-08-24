const FILTRO_LEITURA = `
  c.data_recebimento IS NOT NULL
  AND c.data_prevista_limite IS NOT NULL
  AND to_date(c.data_recebimento, 'DD/MM/YYYY') <= to_date(split_part(c.data_prevista_limite, ' ', 1), 'DD/MM/YYYY')
`;

function numeroEtapa(etapaNum) {
  const valor = parseInt(etapaNum, 10);
  return Number.isNaN(valor) ? 9999 : valor;
}

async function obterUltimoBatch(db) {
  const { rows } = await db.query(`
    SELECT data_import, hora_import
    FROM contr_execucao_leitura
    ORDER BY id DESC
    LIMIT 1
  `);
  return rows[0] || null;
}

async function calcularLeituraUrbana(db) {
  const ultimoBatch = await obterUltimoBatch(db);
  if (!ultimoBatch) {
    return { dataImport: null, horaImport: null, etapas: [] };
  }

  const { data_import: dataImport, hora_import: horaImport } = ultimoBatch;

  const { rows: atual } = await db.query(
    `
    SELECT
      substring(c.etapa from '\\d+') AS etapa_num,
      COALESCE(cl.regional, 'SEM BASE') AS base,
      MIN(to_date(split_part(c.data_prevista_limite, ' ', 1), 'DD/MM/YYYY')) AS prazo_min,
      MAX(to_date(split_part(c.data_prevista_limite, ' ', 1), 'DD/MM/YYYY')) AS prazo_max,
      COUNT(*)::int AS livros,
      SUM(CASE WHEN c.qtd_digitados_nao_digitados ~ '^[0-9]+/[0-9]+$'
          THEN split_part(c.qtd_digitados_nao_digitados, '/', 1)::int ELSE 0 END)::int AS digitados,
      SUM(CASE WHEN c.qtd_digitados_nao_digitados ~ '^[0-9]+/[0-9]+$'
          THEN split_part(c.qtd_digitados_nao_digitados, '/', 2)::int ELSE 0 END)::int AS nao_digitados,
      COUNT(DISTINCT CASE WHEN c.situacao LIKE 'Em Execução%'
          THEN regexp_replace(c.situacao, '^Em Execução \\([^-]*-(.*)\\)$', '\\1')
          END)::int AS leituristas_ativos
    FROM contr_execucao_leitura c
    LEFT JOIN cidades_localidades cl ON cl.local = c.localidade
    WHERE c.data_import = $1 AND c.hora_import = $2
      AND ${FILTRO_LEITURA}
      AND substring(c.etapa from '\\d+') IS NOT NULL
      AND substring(c.etapa from '\\d+')::int BETWEEN 1 AND 19
    GROUP BY substring(c.etapa from '\\d+'), COALESCE(cl.regional, 'SEM BASE')
    `,
    [dataImport, horaImport],
  );

  const { rows: historico } = await db.query(`
    SELECT DISTINCT substring(c.etapa from '\\d+') AS etapa_num, COALESCE(cl.regional, 'SEM BASE') AS base
    FROM contr_execucao_leitura c
    LEFT JOIN cidades_localidades cl ON cl.local = c.localidade
    WHERE ${FILTRO_LEITURA}
      AND substring(c.etapa from '\\d+') IS NOT NULL
      AND substring(c.etapa from '\\d+')::int BETWEEN 1 AND 19
  `);

  const chave = (etapa, base) => `${etapa}::${base}`;
  const atualPorChave = new Map(atual.map(linha => [chave(linha.etapa_num, linha.base), linha]));

  const etapasMap = new Map();

  for (const { etapa_num: etapa, base } of historico) {
    if (!etapasMap.has(etapa)) {
      etapasMap.set(etapa, { etapa, bases: new Map() });
    }
    const etapaEntry = etapasMap.get(etapa);
    if (etapaEntry.bases.has(base)) continue;

    const linhaAtual = atualPorChave.get(chave(etapa, base));

    if (linhaAtual) {
      const digitados = Number(linhaAtual.digitados);
      const naoDigitados = Number(linhaAtual.nao_digitados);
      const total = digitados + naoDigitados;
      etapaEntry.bases.set(base, {
        base,
        livros: Number(linhaAtual.livros),
        digitados,
        naoDigitados,
        percentualExecutado: total > 0 ? Number(((digitados / total) * 100).toFixed(1)) : 100,
        leituristasAtivos: Number(linhaAtual.leituristas_ativos),
        finalizada: false,
        prazoMin: linhaAtual.prazo_min,
        prazoMax: linhaAtual.prazo_max,
      });
    } else {
      etapaEntry.bases.set(base, {
        base,
        livros: 0,
        digitados: 0,
        naoDigitados: 0,
        percentualExecutado: 100,
        leituristasAtivos: 0,
        finalizada: true,
        prazoMin: null,
        prazoMax: null,
      });
    }
  }

  const etapas = Array.from(etapasMap.values())
    .map(({ etapa, bases }) => {
      const listaBases = Array.from(bases.values()).sort((a, b) => a.base.localeCompare(b.base));

      const prazosValidos = listaBases.map(b => b.prazoMin).filter(Boolean);
      const prazoMin = prazosValidos.length ? prazosValidos.reduce((a, b) => (a < b ? a : b)) : null;
      const prazosMax = listaBases.map(b => b.prazoMax).filter(Boolean);
      const prazoMax = prazosMax.length ? prazosMax.reduce((a, b) => (a > b ? a : b)) : null;

      const totalDigitados = listaBases.reduce((soma, b) => soma + b.digitados, 0);
      const totalNaoDigitados = listaBases.reduce((soma, b) => soma + b.naoDigitados, 0);
      const totalLivros = listaBases.reduce((soma, b) => soma + b.livros, 0);
      const totalGeral = totalDigitados + totalNaoDigitados;

      return {
        etapa: `ETAPA ${String(etapa).padStart(2, '0')}`,
        etapaNumero: numeroEtapa(etapa),
        prazoMin,
        prazoMax,
        totalLivros,
        totalDigitados,
        totalNaoDigitados,
        percentualExecutado: totalGeral > 0 ? Number(((totalDigitados / totalGeral) * 100).toFixed(1)) : 100,
        totalLeituristasAtivos: listaBases.reduce((soma, b) => soma + b.leituristasAtivos, 0),
        bases: listaBases.map(({ prazoMin: _pMin, prazoMax: _pMax, ...resto }) => resto),
      };
    })
    .sort((a, b) => a.etapaNumero - b.etapaNumero);

  return { dataImport, horaImport, etapas };
}

module.exports = { calcularLeituraUrbana };
