const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const CAMPOS = [
  'etapa', 'tipo_oss', 'subtipo_os', 'numero_os', 'localidade', 'livro',
  'empreiteira', 'data_recebimento', 'hora_recebimento', 'data_prevista_limite',
  'data_ultima_atualizacao', 'qtd_digitados_nao_digitados', 'qtd_com_leitura_sem_leitura',
  'percentual_sem_leitura', 'qtd_fora_de_faixa_foto', 'situacao'
];

async function importarParaPostgres(registros) {
  if (!registros.length) {
    console.log('⚠️ Nenhum registro para importar.');
    return { inseridos: 0 };
  }

  const agora = new Date();
  const dataImport = agora.toLocaleDateString('pt-BR');
  const horaImport = agora.toLocaleTimeString('pt-BR');

  console.log(`[Coleta Acomp] 📥 Inserindo ${registros.length} registros na tabela 'contr_execucao_leitura'...`);

  const data = registros.map(linha => {
    const obj = {};
    CAMPOS.forEach((campo, i) => { obj[campo] = linha[i] || null; });
    obj.data_import = dataImport;
    obj.hora_import = horaImport;
    return obj;
  });

  const result = await prisma.contr_execucao_leitura.createMany({ data });

  console.log(`[Coleta Acomp] ✅ ${result.count} registros inseridos com sucesso.`);
  return { inseridos: result.count };
}

module.exports = { importarParaPostgres };