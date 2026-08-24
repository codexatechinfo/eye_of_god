const cron = require('node-cron');
const { executarColetaCopel } = require('../services/coletaCopelService');

const HORA_INICIO = 7;
const HORA_FIM = 19;
const PAUSA_ENTRE_CICLOS_MS = 5000; // pequena folga entre um ciclo e o próximo

let emAndamento = false;
let loopAtivo = false;

function dentroDaJanela() {
  const hora = new Date().getHours();
  return hora >= HORA_INICIO && hora < HORA_FIM;
}

async function executarUmCiclo() {
  if (emAndamento) {
    console.log('[Coleta Acomp] ⏭️ Já em andamento, ignorando chamada concorrente.');
    return;
  }
  emAndamento = true;
  console.log('[Coleta Acomp] ⏰ Iniciando ciclo...');
  try {
    await executarColetaCopel();
  } catch (erro) {
    console.error('[Coleta Acomp] ❌ Erro na coleta:', erro);
  } finally {
    emAndamento = false;
  }
}

async function loopContinuo() {
  if (loopAtivo) return;
  loopAtivo = true;
  console.log('[Coleta Acomp] 🔁 Iniciando loop contínuo (07h–19h).');

  while (dentroDaJanela()) {
    await executarUmCiclo();
    await new Promise(r => setTimeout(r, PAUSA_ENTRE_CICLOS_MS));
  }

  loopAtivo = false;
  console.log('[Coleta Acomp] 🌙 Fora da janela (19h), loop pausado até amanhã às 07h.');
}

function iniciarJobColeta() {
  cron.schedule('0 7 * * *', loopContinuo);
  console.log('[Coleta Acomp] 📅 Loop agendado para iniciar todo dia às 07h e rodar até 19h.');

  if (dentroDaJanela()) {
    loopContinuo();
  }
}

function obterStatus() {
  return { ativo: loopAtivo, emAndamento, dentroDaJanela: dentroDaJanela() };
}

module.exports = { iniciarJobColeta, obterStatus };
