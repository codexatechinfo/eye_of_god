const { pool } = require('../config/db');
const { executarColetaCopel } = require('../services/coletaCopelService');
const { obterStatus: obterStatusAcomp } = require('../jobs/coletaJob');
const { obterStatus: obterStatusMassivas } = require('../jobs/coletaMassivasJob');

async function executarColeta(req, res) {
  try {
    const resultado = await executarColetaCopel();
    res.json({ sucesso: true, ...resultado });
  } catch (erro) {
    console.error('❌ Erro na coleta:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

async function status(req, res) {
  try {
    const { rows: [ultimoImport] } = await pool.query(`
      SELECT data_import, hora_import
      FROM contr_execucao_leitura
      ORDER BY id DESC
      LIMIT 1
    `);

    res.json({
      sucesso: true,
      coletaAcomp: obterStatusAcomp(),
      coletaMassivas: obterStatusMassivas(),
      ultimoImport: ultimoImport
        ? { dataImport: ultimoImport.data_import, horaImport: ultimoImport.hora_import }
        : null,
    });
  } catch (erro) {
    console.error('❌ Erro ao obter status da coleta:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

module.exports = { executarColeta, status };
