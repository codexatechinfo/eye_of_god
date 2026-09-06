const { coletarPosicoes } = require('../services/scalefusionService');
const { abrirContextoTenant, fecharContextoTenant } = require('../config/db');
const { log, logWarn, logErro } = require('../utils/logTempo');

// A API Scalefusion cacheia /devices por 5min no servidor deles (ver
// especificação) — consultar mais rápido que isso só repete o mesmo
// retrato. coletarPosicoes() já ignora posição repetida (mesmo
// data_hora_posicao já gravado), então mesmo que o intervalo real varie um
// pouco (reinício do servidor, watchdog) não duplica linha à toa.
const PAUSA_ENTRE_CICLOS_MS = 5 * 60 * 1000;

const EMPRESA_JOB_ID = process.env.EMPRESA_PRINCIPAL_ID;

let emAndamento = false;
let loopAtivo = false;

async function executarUmCiclo() {
  if (emAndamento) {
    log('[Scalefusion] ⏭️ Já em andamento, ignorando chamada concorrente.');
    return;
  }
  emAndamento = true;
  log('[Scalefusion] ⏰ Iniciando ciclo...');
  let client;
  try {
    client = await abrirContextoTenant({ empresaId: EMPRESA_JOB_ID, nivel: 'ADMINISTRADOR' });
    await coletarPosicoes(client, EMPRESA_JOB_ID);
    await fecharContextoTenant(client, true);
  } catch (erro) {
    logErro('[Scalefusion] ❌ Erro na coleta:', erro);
    if (client) await fecharContextoTenant(client, false);
  } finally {
    emAndamento = false;
  }
}

async function loopContinuo() {
  if (loopAtivo) return;
  loopAtivo = true;
  log('[Scalefusion] 🔁 Iniciando loop contínuo (a cada 5min, sem janela de horário).');

  while (true) {
    await executarUmCiclo();
    await new Promise(r => setTimeout(r, PAUSA_ENTRE_CICLOS_MS));
  }
}

// Mesmo padrão de watchdog dos outros jobs (coletaJob.js/coletaMassivasJob.js)
// — rede de segurança caso o loop pare por algum motivo não previsto.
const INTERVALO_WATCHDOG_MS = 2 * 60 * 1000;

function iniciarJobScalefusion() {
  if (!EMPRESA_JOB_ID) {
    logErro('[Scalefusion] ❌ EMPRESA_PRINCIPAL_ID não definido no .env — job não iniciado.');
    return;
  }
  if (!process.env.SCALEFUSION_API_TOKEN) {
    logWarn('[Scalefusion] ⚠️ SCALEFUSION_API_TOKEN não definido no .env — job não iniciado.');
    return;
  }
  loopContinuo();

  setInterval(() => {
    if (!loopAtivo && !emAndamento) {
      logWarn('[Scalefusion] 🩹 Watchdog: loop não estava rodando — reiniciando.');
      loopContinuo();
    }
  }, INTERVALO_WATCHDOG_MS);
}

function obterStatus() {
  return { ativo: loopAtivo, emAndamento };
}

module.exports = { iniciarJobScalefusion, obterStatus };
