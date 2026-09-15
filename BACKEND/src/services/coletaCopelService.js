const { coletarDadosAcompanhamento } = require('./copelScraperService');
const { importarParaPostgres } = require('./copelImportService');
const { precisaExtracaoProfundaHoje, gravarRosterDiario } = require('./rosterUcsAcompanhamentoService');
const { calcularLeituraUrbana } = require('./leituraUrbanaService');
const dashboardCache = require('./dashboardCacheService');
const { comSessaoExclusiva } = require('./copelSessaoLock');
const { abrirContextoTenant, fecharContextoTenant } = require('../config/db');
const { log, logErro } = require('../utils/logTempo');

// A tentativa de usar contas Copel dedicadas (uma por sessão paralela) foi
// abandonada — o site se mostrou instável sob abertura repetida de OS
// mesmo com contas 100% isoladas entre si (mesma taxa de "sessão perdida"
// com 1 ou com 10 contas simultâneas). Voltou a usar COPEL_USERNAME/
// COPEL_PASSWORD — a MESMA conta de Massivas/Controle de Empreiteiras —
// então `comSessaoExclusiva` é necessário aqui: login de um job derruba a
// sessão do outro no servidor Copel se rodarem ao mesmo tempo (ver
// copelSessaoLock.js). Isso vale tanto pro modo rápido (todo ciclo) quanto
// pro modo profundo (só a 1ª extração bem-sucedida do dia, ver abaixo) —
// os dois passam pela MESMA chamada, só muda quanto tempo ela demora.
//
// A transação com o Postgres NÃO fica aberta durante o scraping — achado ao
// vivo (2026-09-15): antes, `db` vinha aberto (BEGIN) do chamador ANTES
// desta função começar e só era fechado no final, cobrindo o scraping
// inteiro. No modo profundo isso são 30-75min com a transação parada
// (nenhuma query rodando, só esperando o Playwright/HTTP) — o Postgres
// enxerga isso como "idle in transaction" e o
// idle_in_transaction_session_timeout (db.js, 10min — rede de segurança
// contra conexão HTTP vazada, ver comentário lá) mata a conexão bem no
// meio do scraping. O ciclo só descobre 20-65min depois, na hora de
// gravar: "Client has encountered a connection error and is not
// queryable" — perde a extração inteira e tenta nova extração de
// novo do zero no próximo ciclo. Por isso aqui abrimos e fechamos DUAS
// transações curtas — uma só pra decidir o modo, outra só pra gravar no
// final — nenhuma delas segura o client durante o scraping.
async function executarColetaCopel(empresaId) {
  const inicioCiclo = Date.now();
  log('[Coleta Acomp] 🟡 Iniciando coleta de acompanhamento...');

  // Decide ANTES de abrir o browser: se já existe roster de hoje (mesmo
  // que parcial — ver rosterUcsAcompanhamentoService.js), este ciclo fica
  // no modo rápido de sempre. Senão, este é o ciclo que vai abrir OS livro
  // a livro (pode levar 30-75min) pra aprender o roster real de hoje.
  // Transação curta, fechada antes do scraping começar.
  const dbCheck = await abrirContextoTenant({ empresaId, nivel: 'ADMINISTRADOR' });
  let modoProfundo;
  try {
    modoProfundo = await precisaExtracaoProfundaHoje(dbCheck);
    await fecharContextoTenant(dbCheck, true);
  } catch (erro) {
    await fecharContextoTenant(dbCheck, false);
    throw erro;
  }
  if (modoProfundo) {
    log('[Coleta Acomp] 🔬 Nenhum roster de hoje ainda — este ciclo entra em modo profundo (abre OS por livro).');
  }

  const { livros, roster } = await comSessaoExclusiva(() => coletarDadosAcompanhamento(modoProfundo));
  log(`[Coleta Acomp] 🕸️ Scraping concluído (${Date.now() - inicioCiclo}ms desde o início do ciclo).`);

  // Transação nova, aberta só agora — depois do scraping, não antes.
  const db = await abrirContextoTenant({ empresaId, nivel: 'ADMINISTRADOR' });
  let resultado;
  try {
    resultado = await importarParaPostgres(db, livros, empresaId);
    log(`[Coleta Acomp] 💾 Importação concluída (${Date.now() - inicioCiclo}ms desde o início do ciclo).`);

    if (roster.length > 0) {
      try {
        await gravarRosterDiario(db, roster, empresaId);
      } catch (erro) {
        // Não deixa escapar: um erro aqui não pode derrubar a transação do
        // ciclo inteiro e perder os registros de contr_execucao_leitura já
        // importados acima (mesmo raciocínio do try/catch do recálculo do
        // painel, logo abaixo). Se isso acontecer, nenhuma UC de hoje fica
        // gravada — o próximo ciclo tenta o modo profundo de novo do zero.
        logErro('[Coleta Acomp] ❌ Erro ao gravar roster diário de UCs:', erro);
      }
    }

    try {
      log('[Coleta Acomp] 🔄 Recalculando painel (Leitura Urbana)...');
      const leituraUrbana = await calcularLeituraUrbana(db);
      dashboardCache.definir(empresaId, { leituraUrbana });
      log('[Coleta Acomp] ✅ Cache do painel atualizado.');
    } catch (erro) {
      logErro('[Coleta Acomp] ❌ Erro ao recalcular painel:', erro);
    }

    await fecharContextoTenant(db, true);
  } catch (erro) {
    await fecharContextoTenant(db, false);
    throw erro;
  }

  log(`[Coleta Acomp] ✅ Coleta finalizada — ciclo completo em ${Date.now() - inicioCiclo}ms.`);
  return resultado;
}

module.exports = { executarColetaCopel };
