let cache = null;

function obter() {
  return cache;
}

function definir(payload) {
  cache = { atualizadoEm: new Date().toISOString(), payload };
}

module.exports = { obter, definir };
