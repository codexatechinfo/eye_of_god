const { log, logWarn, logErro } = require('../utils/logTempo');

// Mesmo padrão de importarParaPostgres (copelImportService.js): DELETE (do
// dia) + INSERT em lotes, cada lote com SAVEPOINT próprio — um lote ruim
// nunca perde os outros já inseridos com sucesso na mesma chamada.
const LOTE_MAX_LINHAS = 300;

const COLUNAS = [
  'concessionaria', 'empreiteira', 'equipe', 'nome_do_usuario', 'mes_ref_livro',
  'data_da_leitura', 'hora_da_leitura', 'unidade_consumidora', 'codigo_da_localidade',
  'descricao_da_localidade', 'tipo_de_localizacao_da_uc', 'etapa', 'livro',
  'status_releitura', 'equipamento', 'especificacao', 'mensagem', 'mensagem_auxiliar',
  'observacao_de_campo', 'status_foto', 'faturamento_em_campo',
  'status_impressao_do_comunicado', 'forma_de_entrega',
];

// `dataDaLeituraBr`: "DD/MM/YYYY" — a data (ontem OU hoje) que este lote
// representa. Apaga tudo que já existia pra essa data+empresa antes de
// inserir de novo — pedido explícito do usuário: cada ciclo reconcilia o
// dia inteiro (o relatório do dia anterior pode ter sido corrigido/
// consolidado no portal desde a última coleta, não só o dia atual).
// Escopado por empresa_id (RLS/multi-tenant, ADR 0009), não por
// concessionária/empreiteira como no script original — aqui quem isola por
// cliente é o tenant.
async function importarControleEmpreiteiras(db, registros, empresaId, dataDaLeituraBr) {
  const { rowCount: apagadas } = await db.query(
    `DELETE FROM base_dados_leitura WHERE data_da_leitura = $1 AND empresa_id = $2`,
    [dataDaLeituraBr, empresaId],
  );
  log(`[Controle Empreiteiras] 🗑️ ${apagadas} linha(s) antiga(s) removida(s) pra ${dataDaLeituraBr}.`);

  if (!registros.length) {
    log(`[Controle Empreiteiras] ⚠️ Nenhum registro pra importar em ${dataDaLeituraBr}.`);
    return { apagadas, inseridas: 0, lotesComFalha: 0 };
  }

  const colunasFinais = [...COLUNAS, 'empresa_id'];
  const linhas = registros.map(reg => [...COLUNAS.map(c => reg[c] ?? null), empresaId]);

  let totalInseridas = 0;
  let lotesComFalha = 0;
  let linhasPerdidas = 0;
  const totalLotes = Math.ceil(linhas.length / LOTE_MAX_LINHAS);

  for (let inicio = 0; inicio < linhas.length; inicio += LOTE_MAX_LINHAS) {
    const numeroLote = inicio / LOTE_MAX_LINHAS + 1;
    const lote = linhas.slice(inicio, inicio + LOTE_MAX_LINHAS);
    const valores = [];
    const placeholders = lote.map((linha, i) => {
      valores.push(...linha);
      const base = i * colunasFinais.length;
      return `(${colunasFinais.map((_, j) => `$${base + j + 1}`).join(', ')})`;
    });

    const sql = `INSERT INTO base_dados_leitura (${colunasFinais.join(', ')}) VALUES ${placeholders.join(', ')}`;

    await db.query(`SAVEPOINT lote_controle_empreiteiras_${numeroLote}`);
    try {
      const { rowCount } = await db.query(sql, valores);
      await db.query(`RELEASE SAVEPOINT lote_controle_empreiteiras_${numeroLote}`);
      totalInseridas += rowCount;
      log(`[Controle Empreiteiras] 📥 Lote ${numeroLote}/${totalLotes} inserido (${totalInseridas}/${linhas.length}) — ${dataDaLeituraBr}.`);
    } catch (erroLote) {
      await db.query(`ROLLBACK TO SAVEPOINT lote_controle_empreiteiras_${numeroLote}`);
      lotesComFalha++;
      linhasPerdidas += lote.length;
      logErro(
        `[Controle Empreiteiras] ❌ Lote ${numeroLote}/${totalLotes} falhou (${lote.length} linha(s) ` +
          `perdida(s) só deste lote) pra ${dataDaLeituraBr}: ${erroLote.message}`,
      );
    }
  }

  if (lotesComFalha > 0) {
    logWarn(
      `[Controle Empreiteiras] ⚠️ ${lotesComFalha}/${totalLotes} lote(s) falharam pra ${dataDaLeituraBr} — ` +
        `${linhasPerdidas} linha(s) não gravada(s) neste ciclo.`,
    );
  }

  log(`[Controle Empreiteiras] ✅ ${totalInseridas} registro(s) inserido(s) pra ${dataDaLeituraBr}.`);
  return { apagadas, inseridas: totalInseridas, lotesComFalha, linhasPerdidas };
}

module.exports = { importarControleEmpreiteiras };
