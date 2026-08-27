// Portal Copel (www.copel.com/lis) parece usar sessão única por usuário —
// login novo da MESMA conta (COPEL_USERNAME) derruba a sessão anterior no
// servidor. Coleta Acomp (copelScraperService.js) e Massivas
// (copelMassivasScraperService.js) são dois jobs cron independentes, cada um
// com seu próprio browser Playwright, mas os DOIS logam com a mesma conta e
// rodam em loop contínuo o dia inteiro (07h-19h) desde o boot do servidor —
// sem essa fila, login de um simplesmente derruba a sessão do outro no meio
// de uma etapa. Causa raiz confirmada ao vivo: erro real "waiting for
// locator('a.color:has-text(\"ETAPA\")')" no Coleta Acomp coincidindo, no
// mesmo trecho de log, com "Realizando login..." do Massivas.
//
// Serializa as duas coletas: só uma sessão Copel ativa por vez, nunca as
// duas logadas simultaneamente.
let filaAtual = Promise.resolve();

function comSessaoExclusiva(tarefa) {
  const resultado = filaAtual.then(tarefa, tarefa);
  filaAtual = resultado.then(
    () => {},
    () => {},
  );
  return resultado;
}

module.exports = { comSessaoExclusiva };
