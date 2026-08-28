// hh:mm:ss.mmm prefixado em cada linha de log do fluxo de coleta — usuário
// pediu pra contabilizar o tempo de execução do código inteiro (login →
// scraping → importação) direto pelo terminal, sem precisar cronometrar por
// fora. `log`/`logWarn`/`logErro` são substitutos de console.log/warn/error
// que já prefixam a hora antes de qualquer outro argumento.
//
// Horário LOCAL (Brasília), não UTC: toISOString() é sempre UTC, 3h à
// frente do relógio real do usuário — foi o que causou a confusão ("que
// registros de tempo são esses") ao ver 12:21 no log com o relógio marcando
// 09:21. getHours()/getMinutes()/etc. já refletem o fuso do sistema.
function horaAgora() {
  const d = new Date();
  const doisDigitos = n => String(n).padStart(2, '0');
  const tresDigitos = n => String(n).padStart(3, '0');
  return (
    `${doisDigitos(d.getHours())}:${doisDigitos(d.getMinutes())}:` +
    `${doisDigitos(d.getSeconds())}.${tresDigitos(d.getMilliseconds())}`
  );
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
