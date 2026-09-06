const { coletarPosicoes } = require('../services/segsatFrotaService');
const { abrirContextoTenant, fecharContextoTenant } = require('../config/db');
const { log, logWarn, logErro } = require('../utils/logTempo');

// Mesmo intervalo do job da Scalefusion (ADR 0033) — a especificação da
// SEGSAT não documenta um TTL de cache como a Scalefusion, mas 5min já é
// granularidade suficiente pra "onde a moto está agora" e mantém os dois
// jobs de posição consistentes entre si.
const PAUSA_ENTRE_CICLOS_MS = 5 * 60 * 1000;

const EMPRESA_JOB_ID = process.env.EMPRESA_PRINCIPAL_ID;

let emAndamento = false;
let loopAtivo = false;

async function executarUmCiclo() {
  if (emAndamento) {
    log('[SEGSAT] ⏭️ Já em andamento, ignorando chamada concorrente.');
    return;
  }
  emAndamento = true;
  log('[SEGSAT] ⏰ Iniciando ciclo...');
  let client;
  try {
    client = await abrirContextoTenant({ empresaId: EMPRESA_JOB_ID, nivel: 'ADMINISTRADOR' });
    await coletarPosicoes(client, EMPRESA_JOB_ID);
    await fecharContextoTenant(client, true);
  } catch (erro) {
    logErro('[SEGSAT] ❌ Erro na coleta:', erro);
    if (client) await fecharContextoTenant(client, false);
  } finally {
    emAndamento = false;
  }
}

async function loopContinuo() {
  if (loopAtivo) return;
  loopAtivo = true;
  log('[SEGSAT] 🔁 Iniciando loop contínuo (a cada 5min, sem janela de horário).');

  while (true) {
    await executarUmCiclo();
    await new Promise(r => setTimeout(r, PAUSA_ENTRE_CICLOS_MS));
  }
}

const INTERVALO_WATCHDOG_MS = 2 * 60 * 1000;

function iniciarJobSegsatFrota() {
  if (!EMPRESA_JOB_ID) {
    logErro('[SEGSAT] ❌ EMPRESA_PRINCIPAL_ID não definido no .env — job não iniciado.');
    return;
  }
  if (!process.env.SEGSAT_FROTA_TOKEN) {
    logWarn('[SEGSAT] ⚠️ SEGSAT_FROTA_TOKEN não definido no .env — job não iniciado.');
    return;
  }
  loopContinuo();

  setInterval(() => {
    if (!loopAtivo && !emAndamento) {
      logWarn('[SEGSAT] 🩹 Watchdog: loop não estava rodando — reiniciando.');
      loopContinuo();
    }
  }, INTERVALO_WATCHDOG_MS);
}

function obterStatus() {
  return { ativo: loopAtivo, emAndamento };
}

module.exports = { iniciarJobSegsatFrota, obterStatus };
