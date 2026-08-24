const ExcelJS = require('exceljs');
const { CONFIG_IMPORTACAO } = require('../config/importacaoConfig');

function normalizar(texto) {
  return String(texto ?? '').trim();
}

// Primeira linha da planilha é o cabeçalho e tem que bater exatamente (sem
// acento/caixa não importa) com uma coluna conhecida da tabela — nunca aceita
// nome de coluna vindo do arquivo sem checar contra o allowlist, pra não virar
// injeção de SQL via cabeçalho malicioso.
async function extrairLinhas(buffer, colunasValidas) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const planilha = workbook.worksheets[0];
  if (!planilha) {
    throw new Error('A planilha não tem nenhuma aba.');
  }

  const mapaColunas = new Map(colunasValidas.map(c => [c.toLowerCase(), c]));
  const cabecalho = [];
  const linhaCabecalho = planilha.getRow(1);
  linhaCabecalho.eachCell({ includeEmpty: true }, (celula, indice) => {
    const valor = normalizar(celula.value);
    const colunaReal = mapaColunas.get(valor.toLowerCase());
    if (valor && !colunaReal) {
      throw new Error(
        `Coluna "${valor}" (posição ${indice}) não existe nessa tabela. Colunas aceitas: ${colunasValidas.join(', ')}`,
      );
    }
    cabecalho[indice] = colunaReal || null;
  });

  if (!cabecalho.some(Boolean)) {
    throw new Error('Nenhuma coluna reconhecida na primeira linha da planilha.');
  }

  const linhas = [];
  planilha.eachRow((linha, numeroLinha) => {
    if (numeroLinha === 1) return;
    const objeto = {};
    let temAlgumValor = false;
    linha.eachCell({ includeEmpty: true }, (celula, indice) => {
      const coluna = cabecalho[indice];
      if (!coluna) return;
      let valor = celula.value;
      if (valor && typeof valor === 'object' && 'result' in valor) valor = valor.result; // fórmula
      // Todas as colunas de data/hora do schema são texto livre no formato
      // DD/MM/YYYY (mesmo padrão que o scraper grava) — se a célula do Excel
      // estiver formatada como data, o ExcelJS entrega um objeto Date, que
      // precisa virar essa mesma string, senão quebra os to_date(...) do
      // resto do app.
      if (valor instanceof Date) {
        valor = valor.toLocaleDateString('pt-BR');
      }
      if (valor !== null && valor !== undefined && valor !== '') temAlgumValor = true;
      objeto[coluna] = valor === '' ? null : valor;
    });
    if (temAlgumValor) linhas.push(objeto);
  });

  return linhas;
}

function montarInsert(tabela, colunas, linhas, empresaId, temEmpresa) {
  const colunasFinais = temEmpresa ? [...colunas, 'empresa_id'] : colunas;
  const valores = [];
  const placeholders = linhas.map((linha, i) => {
    const valoresLinha = colunas.map(c => linha[c] ?? null);
    if (temEmpresa) valoresLinha.push(empresaId);
    valores.push(...valoresLinha);
    const base = i * colunasFinais.length;
    return `(${colunasFinais.map((_, j) => `$${base + j + 1}`).join(', ')})`;
  });

  const sql = `INSERT INTO ${tabela} (${colunasFinais.map(c => `"${c}"`).join(', ')}) VALUES ${placeholders.join(', ')}`;
  return { sql, valores };
}

async function importarArquivo(db, tabela, empresaId, buffer) {
  const config = CONFIG_IMPORTACAO[tabela];
  if (!config) {
    throw new Error(`Tabela "${tabela}" não está habilitada para importação.`);
  }

  const linhas = await extrairLinhas(buffer, config.colunas);
  if (!linhas.length) {
    return { linhasProcessadas: 0, modo: config.modo, tabela };
  }

  if (config.modo === 'substituir') {
    if (config.temEmpresa) {
      await db.query(`DELETE FROM ${tabela} WHERE empresa_id = $1`, [empresaId]);
    } else {
      await db.query(`DELETE FROM ${tabela}`);
    }
  } else {
    // upsert: remove as linhas cuja chave (tupla, não coluna por coluna —
    // por isso o DELETE...USING unnest, e não vários "= ANY()" separados,
    // que combinariam valores de linhas diferentes do arquivo entre si)
    // bate com alguma linha do arquivo — o INSERT logo depois recria elas
    // (com o dado novo) e insere as que não existiam. Sem depender de
    // constraint UNIQUE na tabela (o scraper grava a mesma "chave de
    // negócio" várias vezes ao dia de propósito, em ciclos diferentes).
    const arraysChave = config.chave.map((c, i) => linhas.map(l => (l[c] ?? null) === null ? null : String(l[c])));
    const aliasChave = config.chave.map((c, i) => `k${i}`).join(', ');
    const unnestParams = config.chave.map((c, i) => `$${i + (config.temEmpresa ? 2 : 1)}::text[]`).join(', ');
    const condicoesChave = config.chave.map((c, i) => `t."${c}" = u.k${i}`).join(' AND ');
    const paramsBase = config.temEmpresa ? [empresaId, ...arraysChave] : arraysChave;

    await db.query(
      `DELETE FROM ${tabela} t
       USING unnest(${unnestParams}) AS u(${aliasChave})
       WHERE ${condicoesChave} ${config.temEmpresa ? 'AND t.empresa_id = $1' : ''}`,
      paramsBase,
    );
  }

  const { sql, valores } = montarInsert(tabela, config.colunas, linhas, empresaId, config.temEmpresa);
  const { rowCount } = await db.query(sql, valores);

  return { linhasProcessadas: rowCount, modo: config.modo, tabela, compartilhada: !config.temEmpresa };
}

module.exports = { importarArquivo, CONFIG_IMPORTACAO };
