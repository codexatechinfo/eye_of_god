const { coletarDadosAcompanhamento } = require('./copelScraperService');
const { importarParaPostgres } = require('./copelImportService');
const { calcularLeituraUrbana } = require('./leituraUrbanaService');
const dashboardCache = require('./dashboardCacheService');
const { comSessaoExclusiva } = require('./copelSessaoLock');
const { log, logErro } = require('../utils/logTempo');

async function executarColetaCopel(db, empresaId) {
  const inicioCiclo = Date.now();
  log('[Coleta Acomp] 🟡 Iniciando coleta de acompanhamento...');
  const registros = await comSessaoExclusiva(() => coletarDadosAcompanhamento());
  log(`[Coleta Acomp] 🕸️ Scraping concluído (${Date.now() - inicioCiclo}ms desde o início do ciclo).`);

  const resultado = await importarParaPostgres(db, registros, empresaId);
  log(`[Coleta Acomp] 💾 Importação concluída (${Date.now() - inicioCiclo}ms desde o início do ciclo).`);

  try {
    log('[Coleta Acomp] 🔄 Recalculando painel (Leitura Urbana)...');
    const leituraUrbana = await calcularLeituraUrbana(db);
    dashboardCache.definir(empresaId, { leituraUrbana });
    log('[Coleta Acomp] ✅ Cache do painel atualizado.');
  } catch (erro) {
    logErro('[Coleta Acomp] ❌ Erro ao recalcular painel:', erro);
  }

  log(`[Coleta Acomp] ✅ Coleta finalizada — ciclo completo em ${Date.now() - inicioCiclo}ms.`);
  return resultado;
}

module.exports = { executarColetaCopel };
