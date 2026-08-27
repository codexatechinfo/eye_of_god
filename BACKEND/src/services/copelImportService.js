// Ordem posicional das colunas da tabela #item do portal Copel — o scraper
// lê célula por célula sem nome, então essa ordem tem que continuar batendo
// com o HTML mesmo que a tabela contr_execucao_leitura não guarde mais todas
// elas (ver CAMPOS_TABELA abaixo). Mudar isso sem o layout do site mudar
// junto desalinha o parse inteiro.
const CAMPOS_SCRAPER = [
  'etapa', 'tipo_oss', 'subtipo_os', 'numero_os', 'localidade', 'livro',
  'empreiteira', 'data_recebimento', 'hora_recebimento', 'data_prevista_limite',
  'data_ultima_atualizacao', 'qtd_digitados_nao_digitados', 'qtd_com_leitura_sem_leitura',
  'percentual_sem_leitura', 'qtd_fora_de_faixa_foto', 'situacao'
];

// Subset de CAMPOS_SCRAPER que a tabela contr_execucao_leitura ainda guarda.
// tipo_oss/subtipo_os/numero_os/data_ultima_atualizacao/qtd_digitados_nao_digitados/
// qtd_com_leitura_sem_leitura/percentual_sem_leitura/qtd_fora_de_faixa_foto saíram
// do schema; uc/colaborador/codigo/equipamento/tipo_especificacao/faturamento/
// leitura_atual foram adicionadas mas vêm de outra aba do portal (scraping
// ainda não implementado) — ficam null por enquanto.
const CAMPOS_TABELA = [
  'etapa', 'localidade', 'livro', 'empreiteira', 'data_recebimento',
  'hora_recebimento', 'data_prevista_limite', 'situacao',
];

// O portal da Copel mostra a etapa como link "ETAPA 18 - (528)" — o número
// entre parênteses é a contagem de itens visíveis naquele momento (muda a
// cada ciclo de coleta, não é parte da etapa) e o scraper lê esse texto como
// veio. Sem limpar aqui, a coluna fica inconsistente com o resto do banco
// (calendario_leitura.etapa é sempre só o número, "09", "18" etc.) e quebra
// qualquer JOIN por etapa. Extrai só o número e normaliza pra 2 dígitos.
function limparEtapa(valor) {
  const numero = String(valor ?? '').match(/\d+/)?.[0];
  return numero ? numero.padStart(2, '0') : (valor || null);
}

async function importarParaPostgres(db, registros, empresaId) {
  if (!registros.length) {
    console.log('⚠️ Nenhum registro para importar.');
    return { inseridos: 0 };
  }

  const agora = new Date();
  const dataImport = agora.toLocaleDateString('pt-BR');
  const horaImport = agora.toLocaleTimeString('pt-BR');

  console.log(`[Coleta Acomp] 📥 Inserindo ${registros.length} registros na tabela 'contr_execucao_leitura'...`);

  const colunas = [...CAMPOS_TABELA, 'data_import', 'hora_import', 'empresa_id'];
  const linhas = registros.map(linha => {
    const obj = {};
    CAMPOS_SCRAPER.forEach((campo, i) => { obj[campo] = linha[i] || null; });
    obj.etapa = limparEtapa(obj.etapa);
    obj.data_import = dataImport;
    obj.hora_import = horaImport;
    obj.empresa_id = empresaId;
    return colunas.map(campo => obj[campo]);
  });

  const valores = [];
  const placeholders = linhas.map((linha, i) => {
    valores.push(...linha);
    const base = i * colunas.length;
    return `(${colunas.map((_, j) => `$${base + j + 1}`).join(', ')})`;
  });

  const sql = `INSERT INTO contr_execucao_leitura (${colunas.join(', ')}) VALUES ${placeholders.join(', ')}`;
  const { rowCount } = await db.query(sql, valores);

  console.log(`[Coleta Acomp] ✅ ${rowCount} registros inseridos com sucesso.`);
  return { inseridos: rowCount };
}

module.exports = { importarParaPostgres };
