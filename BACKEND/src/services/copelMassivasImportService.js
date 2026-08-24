const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function importarMassivas({ pendentes, atribuidas, emExecucao }) {
  const resultado = { pendentes: 0, atribuidas: 0, emExecucao: 0 };

  if (pendentes.length) {
    const r = await prisma.pendentes_im.createMany({ data: pendentes });
    resultado.pendentes = r.count;
    console.log(`[Massivas] ${r.count} linhas importadas em 'pendentes_im'`);
  }

  if (atribuidas.length) {
    const r = await prisma.atribuidas_im.createMany({ data: atribuidas });
    resultado.atribuidas = r.count;
    console.log(`[Massivas] ${r.count} linhas importadas em 'atribuidas_im'`);
  }

  if (emExecucao.length) {
    const r = await prisma.em_execucao_im.createMany({ data: emExecucao });
    resultado.emExecucao = r.count;
    console.log(`[Massivas] ${r.count} linhas importadas em 'em_execucao_im'`);
  }

  return resultado;
}

module.exports = { importarMassivas };