const { obterProgressoPorLivro } = require('./monitoramentoService');

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

  // Desde que o scraper de Acompanhamento parou de abrir OS,
  // contr_execucao_leitura tem 1 linha por LIVRO por lote (não mais 1 por
  // UC) — sem dedup nem SUM/GROUP BY de codigo por UC (sempre NULL agora).
  // O progresso real (digitados/naoDigitados) vem à parte, de
  // obterProgressoPorLivro (coordenadas_ucs_mineradas + base_dados_leitura),
  // agregado por etapa+base aqui embaixo em JS.
  const { rows: linhas } = await db.query(
    `
    SELECT
      substring(c.etapa from '\\d+') AS etapa_num,
      COALESCE(cl.regional, 'SEM BASE') AS base,
      c.livro,
      split_part(c.data_prevista_limite, ' ', 1) AS data_prevista_limite,
      c.situacao,
      c.colaborador
    FROM contr_execucao_leitura c
    LEFT JOIN cidades_localidades cl ON cl.local = c.localidade
    WHERE c.data_import = $1 AND c.hora_import = $2
      AND ${FILTRO_LEITURA}
      AND substring(c.etapa from '\\d+') IS NOT NULL
      AND substring(c.etapa from '\\d+')::int BETWEEN 1 AND 19
    `,
    [dataImport, horaImport],
  );

  const progresso = await obterProgressoPorLivro(db, linhas.map(l => l.livro), dataImport);

  // "DD/MM/YYYY" -> Date local, só pra poder comparar min/max corretamente
  // (string simples não ordena certo entre meses/anos diferentes).
  function paraData(dataBr) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dataBr || '');
    return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
  }

  const grupos = new Map();
  for (const linha of linhas) {
    const chave = `${linha.etapa_num}::${linha.base}`;
    if (!grupos.has(chave)) {
      grupos.set(chave, {
        etapa_num: linha.etapa_num,
        base: linha.base,
        livros: new Set(),
        prazos: [],
        digitados: 0,
        nao_digitados: 0,
        leituristasAtivos: new Set(),
      });
    }
    const g = grupos.get(chave);
    g.livros.add(linha.livro);
    const prazo = paraData(linha.data_prevista_limite);
    if (prazo) g.prazos.push(prazo);
    const p = progresso.get(linha.livro);
    if (p) {
      g.digitados += p.digitados;
      g.nao_digitados += p.naoDigitados;
    }
    if (linha.situacao === 'Em Execução' && linha.colaborador) g.leituristasAtivos.add(linha.colaborador);
  }

  const atual = [...grupos.values()].map(g => ({
    etapa_num: g.etapa_num,
    base: g.base,
    prazo_min: g.prazos.length ? g.prazos.reduce((a, b) => (a < b ? a : b)) : null,
    prazo_max: g.prazos.length ? g.prazos.reduce((a, b) => (a > b ? a : b)) : null,
    livros: g.livros.size,
    digitados: g.digitados,
    nao_digitados: g.nao_digitados,
    leituristas_ativos: g.leituristasAtivos.size,
  }));

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
