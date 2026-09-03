const { coletarMassivas } = require('./copelMassivasScraperService');
const { importarMassivas } = require('./copelMassivasImportService');
const { importarControleEmpreiteiras } = require('./copelControleEmpreiteirasImportService');
const { comSessaoExclusiva } = require('./copelSessaoLock');
const { log } = require('../utils/logTempo');

// "DD/MM/YYYY" — mesmo formato de data_da_leitura em base_dados_leitura.
function formatarDataBr(data) {
  const dia = String(data.getDate()).padStart(2, '0');
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  return `${dia}/${mes}/${data.getFullYear()}`;
}

async function executarColetaMassivas(db, empresaId) {
  log('[Massivas] 🟡 Iniciando coleta de massivas...');
  const dados = await comSessaoExclusiva(() => coletarMassivas());
  const resultado = await importarMassivas(db, dados, empresaId);

  // Controle de Empreiteiras (-> base_dados_leitura), extraído dentro da
  // mesma sessão acima (ver copelMassivasScraperService.js) — ontem e hoje
  // são reconciliados como duas chamadas separadas, cada uma com seu
  // próprio DELETE+INSERT (pedido explícito do usuário, não numa transação
  // só), pra um erro na importação de um dia não afetar o outro.
  //
  // `null` (extração não tentou ou falhou) NUNCA aciona o
  // DELETE+INSERT — só `[]`/array com dado (extração rodou de verdade,
  // mesmo que tenha achado zero linhas) importa/reconcilia aquele dia. Sem
  // esse check, uma falha de rede na extração apagaria dado bom de um dia
  // anterior sem substituir por nada.
  const hoje = new Date();
  const ontem = new Date(hoje);
  ontem.setDate(ontem.getDate() - 1);

  if (dados.controleEmpreiteiras?.ontem != null) {
    await importarControleEmpreiteiras(db, dados.controleEmpreiteiras.ontem, empresaId, formatarDataBr(ontem));
  }
  if (dados.controleEmpreiteiras?.hoje != null) {
    await importarControleEmpreiteiras(db, dados.controleEmpreiteiras.hoje, empresaId, formatarDataBr(hoje));
  }

  log('[Massivas] ✅ Ciclo concluído (massivas + Controle de Empreiteiras encadeado).');
  return resultado;
}

module.exports = { executarColetaMassivas };
