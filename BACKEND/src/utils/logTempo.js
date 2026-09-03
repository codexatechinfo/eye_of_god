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

// Colore só o prefixo "[Nome do Job]" de cada linha — os 3 loops (Massivas,
// Coleta Acomp, Controle Empreiteiras) rodam concorrentes e escrevem no
// mesmo terminal, intercalando linha a linha; sem cor, fica tudo "no mesmo
// bolo" e difícil de acompanhar de qual job veio cada linha (usuário
// reportou a confusão ao vivo). Mapeamento fixo (não por hash) pra cor não
// mudar de execução pra execução.
const CORES_JOB = {
  '[Massivas]': '\x1b[36m', // ciano
  '[Coleta Acomp]': '\x1b[32m', // verde
  '[Controle Empreiteiras]': '\x1b[33m', // amarelo
};
const RESET_COR = '\x1b[0m';

function colorirPrefixo(valor) {
  if (typeof valor !== 'string') return valor;
  for (const [tag, cor] of Object.entries(CORES_JOB)) {
    if (valor.startsWith(tag)) {
      return `${cor}${tag}${RESET_COR}${valor.slice(tag.length)}`;
    }
  }
  return valor;
}

function log(...args) {
  const [primeiro, ...resto] = args;
  console.log(`[${horaAgora()}]`, colorirPrefixo(primeiro), ...resto);
}

function logWarn(...args) {
  const [primeiro, ...resto] = args;
  console.warn(`[${horaAgora()}]`, colorirPrefixo(primeiro), ...resto);
}

function logErro(...args) {
  const [primeiro, ...resto] = args;
  console.error(`[${horaAgora()}]`, colorirPrefixo(primeiro), ...resto);
}

module.exports = { horaAgora, log, logWarn, logErro };
