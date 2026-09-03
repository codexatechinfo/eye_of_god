const { log } = require('../utils/logTempo');

async function inserirEmMassa(db, tabela, linhas, empresaId) {
  if (!linhas.length) return 0;

  const colunas = [...Object.keys(linhas[0]), 'empresa_id'];
  const valores = [];
  const placeholders = linhas.map((linha, i) => {
    valores.push(...colunas.map(coluna => (coluna === 'empresa_id' ? empresaId : linha[coluna] ?? null)));
    const base = i * colunas.length;
    return `(${colunas.map((_, j) => `$${base + j + 1}`).join(', ')})`;
  });

  const sql = `INSERT INTO ${tabela} (${colunas.join(', ')}) VALUES ${placeholders.join(', ')}`;
  const { rowCount } = await db.query(sql, valores);
  return rowCount;
}

async function importarMassivas(db, { pendentes, atribuidas, emExecucao }, empresaId) {
  const resultado = { pendentes: 0, atribuidas: 0, emExecucao: 0 };

  if (pendentes.length) {
    resultado.pendentes = await inserirEmMassa(db, 'pendentes_im', pendentes, empresaId);
    log(`[Massivas] ${resultado.pendentes} linhas importadas em 'pendentes_im'`);
  }

  if (atribuidas.length) {
    resultado.atribuidas = await inserirEmMassa(db, 'atribuidas_im', atribuidas, empresaId);
    log(`[Massivas] ${resultado.atribuidas} linhas importadas em 'atribuidas_im'`);
  }

  if (emExecucao.length) {
    resultado.emExecucao = await inserirEmMassa(db, 'em_execucao_im', emExecucao, empresaId);
    log(`[Massivas] ${resultado.emExecucao} linhas importadas em 'em_execucao_im'`);
  }

  return resultado;
}

module.exports = { importarMassivas };
