const { executarColetaMassivas } = require('../services/coletaMassivasService');

async function executarColeta(req, res) {
  try {
    const resultado = await executarColetaMassivas();
    res.json({ sucesso: true, ...resultado });
  } catch (erro) {
    console.error('❌ Erro na coleta de massivas:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

module.exports = { executarColeta };