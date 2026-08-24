const { coletarDadosAcompanhamento } = require('./copelScraperService');
const { importarParaPostgres } = require('./copelImportService');
const { calcularLeituraUrbana } = require('./leituraUrbanaService');
const dashboardCache = require('./dashboardCacheService');

async function executarColetaCopel() {
  console.log('[Coleta Acomp] 🟡 Iniciando coleta de acompanhamento...');
  const registros = await coletarDadosAcompanhamento();
  const resultado = await importarParaPostgres(registros);

  try {
    console.log('[Coleta Acomp] 🔄 Recalculando painel (Leitura Urbana)...');
    const leituraUrbana = await calcularLeituraUrbana();
    dashboardCache.definir({ leituraUrbana });
    console.log('[Coleta Acomp] ✅ Cache do painel atualizado.');
  } catch (erro) {
    console.error('[Coleta Acomp] ❌ Erro ao recalcular painel:', erro);
  }

  console.log('[Coleta Acomp] ✅ Coleta finalizada.');
  return resultado;
}

module.exports = { executarColetaCopel };