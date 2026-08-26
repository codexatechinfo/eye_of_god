const cron = require('node-cron');
const { executarColetaMassivas } = require('../services/coletaMassivasService');
const { abrirContextoTenant, fecharContextoTenant } = require('../config/db');

const HORA_INICIO = 7;
const HORA_FIM = 19;
const PAUSA_ENTRE_CICLOS_MS = 5000;

const EMPRESA_JOB_ID = process.env.EMPRESA_PRINCIPAL_ID;

let emAndamento = false;
let loopAtivo = false;

function dentroDaJanela() {
  const hora = new Date().getHours();
  return hora >= HORA_INICIO && hora < HORA_FIM;
}

async function executarUmCiclo() {
  if (emAndamento) {
    console.log('[Massivas] ⏭️ Já em andamento, ignorando chamada concorrente.');
    return;
  }
  emAndamento = true;
  console.log('[Massivas] ⏰ Iniciando ciclo...');
  // abrirContextoTenant() também dentro do try — ver mesmo comentário em
  // coletaJob.js (evita travar o loop pro resto do dia se a conexão falhar
  // de forma transitória).
  let client;
  try {
    client = await abrirContextoTenant({ empresaId: EMPRESA_JOB_ID, nivel: 'ADMINISTRADOR' });
    await executarColetaMassivas(client, EMPRESA_JOB_ID);
    await fecharContextoTenant(client, true);
  } catch (erro) {
    console.error('[Massivas] ❌ Erro na coleta:', erro);
    if (client) await fecharContextoTenant(client, false);
  } finally {
    emAndamento = false;
  }
}

async function loopContinuo() {
  if (loopAtivo) return;
  loopAtivo = true;
  console.log('[Massivas] 🔁 Iniciando loop contínuo (07h–19h).');

  while (dentroDaJanela()) {
    await executarUmCiclo();
    await new Promise(r => setTimeout(r, PAUSA_ENTRE_CICLOS_MS));
  }

  loopAtivo = false;
  console.log('[Massivas] 🌙 Fora da janela (19h), loop pausado até amanhã às 07h.');
}

// Ver mesmo comentário em coletaJob.js — node-cron não faz retry quando
// perde o disparo agendado (log real visto em produção: node-cron perdeu a
// execução das 07h porque o processo estava reiniciando naquele exato
// minuto). Watchdog reinicia sozinho se detectar que deveria estar rodando.
const INTERVALO_WATCHDOG_MS = 2 * 60 * 1000;

function iniciarJobMassivas() {
  if (!EMPRESA_JOB_ID) {
    console.error('[Massivas] ❌ EMPRESA_PRINCIPAL_ID não definido no .env — job não iniciado.');
    return;
  }
  cron.schedule('0 7 * * *', loopContinuo);
  console.log('[Massivas] 📅 Loop agendado para iniciar todo dia às 07h e rodar até 19h.');

  if (dentroDaJanela()) {
    loopContinuo();
  }

  setInterval(() => {
    if (dentroDaJanela() && !loopAtivo && !emAndamento) {
      console.warn('[Massivas] 🩹 Watchdog: deveria estar rodando (dentro da janela) mas não estava — reiniciando o loop.');
      loopContinuo();
    }
  }, INTERVALO_WATCHDOG_MS);
}

function obterStatus() {
  return { ativo: loopAtivo, emAndamento, dentroDaJanela: dentroDaJanela() };
}

module.exports = { iniciarJobMassivas, obterStatus };
