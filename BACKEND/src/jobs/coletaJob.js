const cron = require('node-cron');
const { executarColetaCopel } = require('../services/coletaCopelService');
const { abrirContextoTenant, fecharContextoTenant } = require('../config/db');

const HORA_INICIO = 7;
const HORA_FIM = 19;
const PAUSA_ENTRE_CICLOS_MS = 5000; // pequena folga entre um ciclo e o próximo

// Job roda fora de requisição HTTP, sem token — usa a empresa configurada em
// EMPRESA_PRINCIPAL_ID como identidade fixa (ver docs/adr/0003-rbac-multi-tenant.md).
const EMPRESA_JOB_ID = process.env.EMPRESA_PRINCIPAL_ID;

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
  const client = await abrirContextoTenant({ empresaId: EMPRESA_JOB_ID, nivel: 'ADMINISTRADOR' });
  try {
    await executarColetaCopel(client, EMPRESA_JOB_ID);
    await fecharContextoTenant(client, true);
  } catch (erro) {
    console.error('[Coleta Acomp] ❌ Erro na coleta:', erro);
    await fecharContextoTenant(client, false);
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
  if (!EMPRESA_JOB_ID) {
    console.error('[Coleta Acomp] ❌ EMPRESA_PRINCIPAL_ID não definido no .env — job não iniciado.');
    return;
  }
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
