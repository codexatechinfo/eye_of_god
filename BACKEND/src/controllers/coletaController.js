const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { executarColetaCopel } = require('../services/coletaCopelService');
const { obterStatus: obterStatusAcomp } = require('../jobs/coletaJob');
const { obterStatus: obterStatusMassivas } = require('../jobs/coletaMassivasJob');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function executarColeta(req, res) {
  try {
    const resultado = await executarColetaCopel();
    res.json({ sucesso: true, ...resultado });
  } catch (erro) {
    console.error('❌ Erro na coleta:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

async function status(req, res) {
  try {
    const [ultimoImport] = await prisma.$queryRawUnsafe(`
      SELECT data_import, hora_import
      FROM contr_execucao_leitura
      ORDER BY id DESC
      LIMIT 1
    `);

    res.json({
      sucesso: true,
      coletaAcomp: obterStatusAcomp(),
      coletaMassivas: obterStatusMassivas(),
      ultimoImport: ultimoImport
        ? { dataImport: ultimoImport.data_import, horaImport: ultimoImport.hora_import }
        : null,
    });
  } catch (erro) {
    console.error('❌ Erro ao obter status da coleta:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

module.exports = { executarColeta, status };
