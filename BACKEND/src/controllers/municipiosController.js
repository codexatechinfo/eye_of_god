const { listarLimites } = require('../services/municipiosService');

async function limites(req, res) {
  try {
    const dados = await listarLimites(req.db);
    res.json({ sucesso: true, municipios: dados });
  } catch (erro) {
    console.error('❌ Erro ao listar limites municipais:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

module.exports = { limites };
