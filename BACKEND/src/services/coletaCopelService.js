const { coletarDadosAcompanhamento } = require('./copelScraperService');
const { importarParaPostgres } = require('./copelImportService');
const { calcularLeituraUrbana } = require('./leituraUrbanaService');
const dashboardCache = require('./dashboardCacheService');
const { comSessaoExclusiva } = require('./copelSessaoLock');
const { log, logErro } = require('../utils/logTempo');

// A tentativa de usar contas Copel dedicadas (uma por sessão paralela) foi
// abandonada — o site se mostrou instável sob abertura repetida de OS
// mesmo com contas 100% isoladas entre si (mesma taxa de "sessão perdida"
// com 1 ou com 10 contas simultâneas), e a extração parou de precisar
// abrir OS de qualquer forma (só lê a lista já carregada, ver
// copelScraperService.js). Voltou a usar COPEL_USERNAME/COPEL_PASSWORD —
// a MESMA conta de Massivas/Controle de Empreiteiras — então
// `comSessaoExclusiva` volta a ser necessário aqui: login de um job
// derruba a sessão do outro no servidor Copel se rodarem ao mesmo tempo
// (ver copelSessaoLock.js).
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
