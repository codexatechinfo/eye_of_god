const { executarColetaCopel } = require('../services/coletaCopelService');
const { obterStatus: obterStatusAcomp } = require('../jobs/coletaJob');
const { obterStatus: obterStatusMassivas } = require('../jobs/coletaMassivasJob');

function empresaAlvo(req) {
  return req.usuario.nivel === 'ROOT' ? req.query.empresaId : req.usuario.empresaId;
}

async function executarColeta(req, res) {
  try {
    const empresaId = empresaAlvo(req);
    if (!empresaId) {
      return res.status(400).json({ sucesso: false, erro: 'empresaId é obrigatório para ROOT' });
    }
    const resultado = await executarColetaCopel(req.db, empresaId);
    res.json({ sucesso: true, ...resultado });
  } catch (erro) {
    console.error('❌ Erro na coleta:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

async function status(req, res) {
  try {
    const { rows: [ultimoImport] } = await req.db.query(`
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
