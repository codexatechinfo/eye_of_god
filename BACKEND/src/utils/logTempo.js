// hh:mm:ss.mmm prefixado em cada linha de log do fluxo de coleta — usuário
// pediu pra contabilizar o tempo de execução do código inteiro (login →
// scraping → importação) direto pelo terminal, sem precisar cronometrar por
// fora. `log`/`logWarn`/`logErro` são substitutos de console.log/warn/error
// que já prefixam a hora antes de qualquer outro argumento.
function horaAgora() {
  return new Date().toISOString().slice(11, 23);
}

function log(...args) {
  console.log(`[${horaAgora()}]`, ...args);
}

function logWarn(...args) {
  console.warn(`[${horaAgora()}]`, ...args);
}

function logErro(...args) {
  console.error(`[${horaAgora()}]`, ...args);
}

module.exports = { horaAgora, log, logWarn, logErro };
