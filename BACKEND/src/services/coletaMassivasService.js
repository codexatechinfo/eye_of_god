const { coletarMassivas } = require('./copelMassivasScraperService');
const { importarMassivas } = require('./copelMassivasImportService');
const { comSessaoExclusiva } = require('./copelSessaoLock');

async function executarColetaMassivas(db, empresaId) {
  console.log('[Massivas] 🟡 Iniciando coleta de massivas...');
  const dados = await comSessaoExclusiva(() => coletarMassivas());
  const resultado = await importarMassivas(db, dados, empresaId);
  console.log('[Massivas] ✅ Coleta de massivas finalizada.');
  return resultado;
}

module.exports = { executarColetaMassivas };
