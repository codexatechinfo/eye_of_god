// Cache em memória, agora por empresa — antes era uma variável global só,
// o que vazava o dashboard de uma empresa pra outra na primeira requisição
// que caísse no cache de outro tenant. Reinicia a cada boot do processo.
const cachePorEmpresa = new Map();

function obter(empresaId) {
  return cachePorEmpresa.get(empresaId) || null;
}

function definir(empresaId, payload) {
  cachePorEmpresa.set(empresaId, { atualizadoEm: new Date().toISOString(), payload });
}

module.exports = { obter, definir };
