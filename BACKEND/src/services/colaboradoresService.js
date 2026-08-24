const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const REGIONAL_NORMALIZADA = `regexp_replace(regexp_replace(base, '^COPEL\\s+', ''), '\\s+(LEITURA|ADM)$', '')`;

async function listarAtivos({ colaborador, cargo, regional } = {}) {
  const condicoes = [`situacao = 'ATIVO'`];
  const parametros = [];

  if (colaborador) {
    parametros.push(`%${colaborador}%`);
    condicoes.push(`colaborador ILIKE $${parametros.length}`);
  }
  if (cargo) {
    parametros.push(cargo);
    condicoes.push(`cargo = $${parametros.length}`);
  }
  if (regional) {
    parametros.push(regional);
    condicoes.push(`${REGIONAL_NORMALIZADA} = $${parametros.length}`);
  }

  const sql = `
    SELECT matricula, colaborador, cargo, base, admissao, data_atualizacao
    FROM ativos_inativos
    WHERE ${condicoes.join(' AND ')}
    ORDER BY colaborador
  `;

  return prisma.$queryRawUnsafe(sql, ...parametros);
}

async function listarOpcoesFiltro() {
  const [cargos, regionais] = await Promise.all([
    prisma.$queryRawUnsafe(`SELECT DISTINCT cargo FROM ativos_inativos WHERE situacao = 'ATIVO' AND cargo IS NOT NULL ORDER BY cargo`),
    prisma.$queryRawUnsafe(`
      SELECT DISTINCT ${REGIONAL_NORMALIZADA} AS regional
      FROM ativos_inativos
      WHERE situacao = 'ATIVO' AND base IS NOT NULL
      ORDER BY regional
    `),
  ]);

  return {
    cargos: cargos.map(c => c.cargo),
    regionais: regionais.map(r => r.regional),
  };
}

module.exports = { listarAtivos, listarOpcoesFiltro };
