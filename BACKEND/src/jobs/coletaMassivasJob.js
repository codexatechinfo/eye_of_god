const { executarColetaMassivas } = require('../services/coletaMassivasService');
const { log, logWarn, logErro } = require('../utils/logTempo');

const PAUSA_ENTRE_CICLOS_MS = 5000;

const EMPRESA_JOB_ID = process.env.EMPRESA_PRINCIPAL_ID;

let emAndamento = false;
let loopAtivo = false;

async function executarUmCiclo() {
  if (emAndamento) {
    log('[Massivas] ⏭️ Já em andamento, ignorando chamada concorrente.');
    return;
  }
  emAndamento = true;
  log('[Massivas] ⏰ Iniciando ciclo...');
  // executarColetaMassivas agora gerencia sua própria transação, aberta só
  // depois do scraping (ver comentário em coletaMassivasService.js) — não
  // há client pra abrir/fechar aqui. O try/catch continua necessário: ver
  // mesmo comentário em coletaJob.js (evita travar o loop pro resto do dia
  // se algo falhar de forma transitória).
  try {
    await executarColetaMassivas(EMPRESA_JOB_ID);
  } catch (erro) {
    logErro('[Massivas] ❌ Erro na coleta:', erro);
  } finally {
    emAndamento = false;
  }
}

// Loop roda 24h enquanto a API estiver no ar — sem janela de horário
// (removida a pedido do usuário: antes só rodava 07h-19h). executarUmCiclo()
// já engole qualquer erro (try/catch interno), então este while(true) só
// para se o processo Node inteiro morrer.
async function loopContinuo() {
  if (loopAtivo) return;
  loopAtivo = true;
  log('[Massivas] 🔁 Iniciando loop contínuo (24h, sem janela de horário).');

  while (true) {
    await executarUmCiclo();
    await new Promise(r => setTimeout(r, PAUSA_ENTRE_CICLOS_MS));
  }
}

// Rede de segurança: se por algum motivo o loop parar (não deveria, dado que
// executarUmCiclo() nunca deixa erro escapar), reinicia sozinho. Checa a
// cada 2 minutos — loopContinuo() já é idempotente (`if (loopAtivo) return`),
// então chamar de novo enquanto já está rodando não faz nada.
const INTERVALO_WATCHDOG_MS = 2 * 60 * 1000;

function iniciarJobMassivas() {
  if (!EMPRESA_JOB_ID) {
    logErro('[Massivas] ❌ EMPRESA_PRINCIPAL_ID não definido no .env — job não iniciado.');
    return;
  }
  loopContinuo();

  setInterval(() => {
    if (!loopAtivo && !emAndamento) {
      logWarn('[Massivas] 🩹 Watchdog: loop não estava rodando — reiniciando.');
      loopContinuo();
    }
  }, INTERVALO_WATCHDOG_MS);
}

function obterStatus() {
  return { ativo: loopAtivo, emAndamento };
}

module.exports = { iniciarJobMassivas, obterStatus };
