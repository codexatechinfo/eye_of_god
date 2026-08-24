const dashboardCache = require('../services/dashboardCacheService');
const { calcularLeituraUrbana } = require('../services/leituraUrbanaService');

async function leituraUrbana(req, res) {
  try {
    let cache = dashboardCache.obter();
    if (!cache) {
      const dados = await calcularLeituraUrbana();
      dashboardCache.definir({ leituraUrbana: dados });
      cache = dashboardCache.obter();
    }
    res.json({ sucesso: true, atualizadoEm: cache.atualizadoEm, ...cache.payload.leituraUrbana });
  } catch (erro) {
    console.error('❌ Erro ao obter Leitura Urbana:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

module.exports = { leituraUrbana };
