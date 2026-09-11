const { log, logErro } = require('../utils/logTempo');

// Máximo de linhas por INSERT — mesmo teto de copelImportService.js (evita
// estourar o limite de parâmetros do Postgres).
const LOTE_MAX_LINHAS = 300;

// "Já rodei o modo profundo hoje?" — usa CURRENT_DATE do PRÓPRIO Postgres
// (não Date.now() do Node) tanto aqui quanto em gravarRosterDiario, pra não
// arriscar um "hoje" divergente entre o timezone do processo Node e o do
// servidor Postgres bem na virada do dia. RLS (isolamento_empresa) já
// escopa isso pra empresa do contexto de tenant aberto em `db`.
async function precisaExtracaoProfundaHoje(db) {
  const { rows } = await db.query(
    'SELECT 1 FROM roster_ucs_extracao_diaria WHERE data_extracao = CURRENT_DATE LIMIT 1',
  );
  return rows.length === 0;
}

// Grava o roster (livro -> UC) descoberto pelo modo profundo do dia —
// ground truth capturada direto do portal (abrindo a OS de cada livro), não
// depende de coordenadas_ucs_mineradas estar atualizada pro livro que foi
// reatribuído recentemente (ver ADR 0028, Consequências). Não sobrescreve
// nem apaga nada — só insere; uma vez que exista pelo menos 1 linha de hoje,
// precisaExtracaoProfundaHoje() passa a responder "não precisa mais".
async function gravarRosterDiario(db, roster, empresaId) {
  if (!roster.length) return { inseridos: 0 };

  log(`[Coleta Acomp] 📥 Gravando roster de ${roster.length} UC(s) em 'roster_ucs_extracao_diaria'...`);

  let totalInseridos = 0;
  let lotesComFalha = 0;
  const totalLotes = Math.ceil(roster.length / LOTE_MAX_LINHAS);
  for (let inicio = 0; inicio < roster.length; inicio += LOTE_MAX_LINHAS) {
    const numeroLote = inicio / LOTE_MAX_LINHAS + 1;
    const lote = roster.slice(inicio, inicio + LOTE_MAX_LINHAS);
    const valores = [];
    const placeholders = lote.map((item, i) => {
      valores.push(empresaId, item.etapa || null, item.livro, item.unidadeConsumidora);
      const base = i * 4;
      // data_extracao vem de CURRENT_DATE (SQL), não de bind parameter — ver
      // comentário de precisaExtracaoProfundaHoje sobre timezone.
      return `($${base + 1}, CURRENT_DATE, $${base + 2}, $${base + 3}, $${base + 4})`;
    });

    const sql = `INSERT INTO roster_ucs_extracao_diaria (empresa_id, data_extracao, etapa, livro, unidade_consumidora) VALUES ${placeholders.join(', ')}`;

    // SAVEPOINT por lote — mesmo padrão de copelImportService.js: uma falha
    // isolada (linha malformada) perde só o lote, não a transação do ciclo
    // inteiro (que também tem os inserts de contr_execucao_leitura já feitos
    // antes disso).
    await db.query(`SAVEPOINT lote_roster_${numeroLote}`);
    try {
      const { rowCount } = await db.query(sql, valores);
      await db.query(`RELEASE SAVEPOINT lote_roster_${numeroLote}`);
      totalInseridos += rowCount;
    } catch (erroLote) {
      await db.query(`ROLLBACK TO SAVEPOINT lote_roster_${numeroLote}`);
      lotesComFalha++;
      logErro(`[Coleta Acomp] ❌ Lote ${numeroLote}/${totalLotes} do roster falhou ao inserir: ${erroLote.message}`);
    }
  }

  if (lotesComFalha > 0) {
    logErro(`[Coleta Acomp] ⚠️ ${lotesComFalha} lote(s) de ${totalLotes} do roster falharam — ${totalInseridos} UC(s) gravada(s) mesmo assim.`);
  }
  log(`[Coleta Acomp] ✅ ${totalInseridos} UC(s) do roster de hoje gravada(s).`);
  return { inseridos: totalInseridos, lotesComFalha };
}

module.exports = { precisaExtracaoProfundaHoje, gravarRosterDiario };
