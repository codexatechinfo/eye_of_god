const { coletarDadosAcompanhamento } = require('./copelScraperService');
const { importarParaPostgres } = require('./copelImportService');
const { calcularLeituraUrbana } = require('./leituraUrbanaService');
const dashboardCache = require('./dashboardCacheService');
const { comSessaoExclusiva } = require('./copelSessaoLock');

async function executarColetaCopel(db, empresaId) {
  console.log('[Coleta Acomp] 🟡 Iniciando coleta de acompanhamento...');
  const registros = await comSessaoExclusiva(() => coletarDadosAcompanhamento());
  const resultado = await importarParaPostgres(db, registros, empresaId);

  try {
    console.log('[Coleta Acomp] 🔄 Recalculando painel (Leitura Urbana)...');
    const leituraUrbana = await calcularLeituraUrbana(db);
    dashboardCache.definir(empresaId, { leituraUrbana });
    console.log('[Coleta Acomp] ✅ Cache do painel atualizado.');
  } catch (erro) {
    console.error('[Coleta Acomp] ❌ Erro ao recalcular painel:', erro);
  }

  console.log('[Coleta Acomp] ✅ Coleta finalizada.');
  return resultado;
}

module.exports = { executarColetaCopel };
