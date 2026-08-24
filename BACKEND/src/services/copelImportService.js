const { pool } = require('../config/db');

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

  const colunas = [...CAMPOS, 'data_import', 'hora_import'];
  const linhas = registros.map(linha => {
    const obj = {};
    CAMPOS.forEach((campo, i) => { obj[campo] = linha[i] || null; });
    obj.data_import = dataImport;
    obj.hora_import = horaImport;
    return colunas.map(campo => obj[campo]);
  });

  const valores = [];
  const placeholders = linhas.map((linha, i) => {
    valores.push(...linha);
    const base = i * colunas.length;
    return `(${colunas.map((_, j) => `$${base + j + 1}`).join(', ')})`;
  });

  const sql = `INSERT INTO contr_execucao_leitura (${colunas.join(', ')}) VALUES ${placeholders.join(', ')}`;
  const { rowCount } = await pool.query(sql, valores);

  console.log(`[Coleta Acomp] ✅ ${rowCount} registros inseridos com sucesso.`);
  return { inseridos: rowCount };
}

module.exports = { importarParaPostgres };
