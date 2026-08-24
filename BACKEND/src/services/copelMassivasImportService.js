const { pool } = require('../config/db');

async function inserirEmMassa(tabela, linhas) {
  if (!linhas.length) return 0;

  const colunas = Object.keys(linhas[0]);
  const valores = [];
  const placeholders = linhas.map((linha, i) => {
    valores.push(...colunas.map(coluna => linha[coluna] ?? null));
    const base = i * colunas.length;
    return `(${colunas.map((_, j) => `$${base + j + 1}`).join(', ')})`;
  });

  const sql = `INSERT INTO ${tabela} (${colunas.join(', ')}) VALUES ${placeholders.join(', ')}`;
  const { rowCount } = await pool.query(sql, valores);
  return rowCount;
}

async function importarMassivas({ pendentes, atribuidas, emExecucao }) {
  const resultado = { pendentes: 0, atribuidas: 0, emExecucao: 0 };

  if (pendentes.length) {
    resultado.pendentes = await inserirEmMassa('pendentes_im', pendentes);
    console.log(`[Massivas] ${resultado.pendentes} linhas importadas em 'pendentes_im'`);
  }

  if (atribuidas.length) {
    resultado.atribuidas = await inserirEmMassa('atribuidas_im', atribuidas);
    console.log(`[Massivas] ${resultado.atribuidas} linhas importadas em 'atribuidas_im'`);
  }

  if (emExecucao.length) {
    resultado.emExecucao = await inserirEmMassa('em_execucao_im', emExecucao);
    console.log(`[Massivas] ${resultado.emExecucao} linhas importadas em 'em_execucao_im'`);
  }

  return resultado;
}

module.exports = { importarMassivas };
