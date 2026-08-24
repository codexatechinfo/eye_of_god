const dashboardCache = require('../services/dashboardCacheService');
const { calcularLeituraUrbana } = require('../services/leituraUrbanaService');

async function leituraUrbana(req, res) {
  try {
    // ROOT não tem empresa própria — precisa dizer qual quer ver.
    const empresaId = req.usuario.nivel === 'ROOT' ? req.query.empresaId : req.usuario.empresaId;
    if (!empresaId) {
      return res.status(400).json({ sucesso: false, erro: 'empresaId é obrigatório para ROOT' });
    }

    let cache = dashboardCache.obter(empresaId);
    if (!cache) {
      const dados = await calcularLeituraUrbana(req.db);
      dashboardCache.definir(empresaId, { leituraUrbana: dados });
      cache = dashboardCache.obter(empresaId);
    }
    res.json({ sucesso: true, atualizadoEm: cache.atualizadoEm, ...cache.payload.leituraUrbana });
  } catch (erro) {
    console.error('❌ Erro ao obter Leitura Urbana:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

module.exports = { leituraUrbana };
