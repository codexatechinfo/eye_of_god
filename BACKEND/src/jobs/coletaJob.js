const { executarColetaCopel } = require('../services/coletaCopelService');
const { abrirContextoTenant, fecharContextoTenant } = require('../config/db');

const PAUSA_ENTRE_CICLOS_MS = 5000; // pequena folga entre um ciclo e o próximo

// Job roda fora de requisição HTTP, sem token — usa a empresa configurada em
// EMPRESA_PRINCIPAL_ID como identidade fixa (ver docs/adr/0003-rbac-multi-tenant.md).
const EMPRESA_JOB_ID = process.env.EMPRESA_PRINCIPAL_ID;

let emAndamento = false;
let loopAtivo = false;

async function executarUmCiclo() {
  if (emAndamento) {
    console.log('[Coleta Acomp] ⏭️ Já em andamento, ignorando chamada concorrente.');
    return;
  }
  emAndamento = true;
  console.log('[Coleta Acomp] ⏰ Iniciando ciclo...');
  // abrirContextoTenant() também dentro do try: se ela lançar (ex.: erro
  // transitório de conexão), a exceção escapava do try/catch, propagava pra
  // fora do while em loopContinuo() e travava o loop pro resto do dia sem
  // nunca resetar loopAtivo — sintoma real observado em produção junto com
  // o node-cron perdendo o disparo das 07h (ver watchdog em
  // iniciarJobColeta abaixo).
  let client;
  try {
    client = await abrirContextoTenant({ empresaId: EMPRESA_JOB_ID, nivel: 'ADMINISTRADOR' });
    await executarColetaCopel(client, EMPRESA_JOB_ID);
    await fecharContextoTenant(client, true);
  } catch (erro) {
    console.error('[Coleta Acomp] ❌ Erro na coleta:', erro);
    if (client) await fecharContextoTenant(client, false);
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
  console.log('[Coleta Acomp] 🔁 Iniciando loop contínuo (24h, sem janela de horário).');

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

function iniciarJobColeta() {
  if (!EMPRESA_JOB_ID) {
    console.error('[Coleta Acomp] ❌ EMPRESA_PRINCIPAL_ID não definido no .env — job não iniciado.');
    return;
  }
  loopContinuo();

  setInterval(() => {
    if (!loopAtivo && !emAndamento) {
      console.warn('[Coleta Acomp] 🩹 Watchdog: loop não estava rodando — reiniciando.');
      loopContinuo();
    }
  }, INTERVALO_WATCHDOG_MS);
}

function obterStatus() {
  return { ativo: loopAtivo, emAndamento };
}

module.exports = { iniciarJobColeta, obterStatus };
