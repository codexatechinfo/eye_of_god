const { log, logErro } = require('../utils/logTempo');

// Máximo de linhas por INSERT — mesmo teto de copelImportService.js (evita
// estourar o limite de parâmetros do Postgres).
const LOTE_MAX_LINHAS = 300;

// "Hoje", pro propósito desta tabela, é o dia local do NEGÓCIO (Brasil,
// UTC-3) — o mesmo "hoje" que data_import/hora_import já usam em todo o
// resto do app (copelImportService.js, via toLocaleDateString/
// toLocaleTimeString, sem argumento de timezone = timezone do processo
// Node). NÃO usar CURRENT_DATE do Postgres aqui: o servidor Postgres deste
// projeto roda em UTC (confirmado ao vivo, `SHOW timezone` = UTC), então
// CURRENT_DATE vira o dia seguinte 3h ANTES da meia-noite local (às 21h de
// Brasília) — descoberto ao vivo (usuário reportou "hoje nem é 14/09"
// quando o Postgres já achava que era): o modo profundo disparava de novo
// toda noite às ~21h, rotulando a extração de HOJE (fim de tarde/noite)
// como se fosse a de AMANHÃ, e então amanhã de manhã (quando a extração de
// verdade deveria rodar) o sistema já achava "já tenho roster de hoje" e
// pulava — o roster ficava permanentemente ~3-21h desatualizado em relação
// ao dia real, o mesmo tipo de problema que esta feature inteira existe
// pra resolver.
function hojeLocal() {
  return new Date().toLocaleDateString('en-CA'); // "YYYY-MM-DD", timezone do processo Node
}

// Só depois das 6h da manhã (hora local) — pedido explícito do usuário: o
// loop roda 24h, então "primeiro ciclo do dia" podia cair perto da meia-noite,
// ANTES da Copel liberar/atualizar as OS do dia (muita releitura só é aberta
// depois que os leituristas começam a rodar de manhã) — capturar cedo demais
// só trocava "desatualizado à noite" por "incompleto de manhã", sem resolver
// nada. 6h dá folga real pro dia já estar minimamente formado no portal antes
// da extração rodar. Antes das 6h, todo ciclo continua em modo rápido — a
// extração profunda só dispara no primeiro ciclo às 6h ou depois.
function aptoParaExtracaoProfunda() {
  return new Date().getHours() >= 6;
}

// RLS (isolamento_empresa) já escopa isso pra empresa do contexto de tenant
// aberto em `db`.
async function precisaExtracaoProfundaHoje(db) {
  if (!aptoParaExtracaoProfunda()) return false;
  const { rows } = await db.query(
    'SELECT 1 FROM roster_ucs_extracao_diaria WHERE data_extracao = $1::date LIMIT 1',
    [hojeLocal()],
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

  const dataHoje = hojeLocal();
  let totalInseridos = 0;
  let lotesComFalha = 0;
  const totalLotes = Math.ceil(roster.length / LOTE_MAX_LINHAS);
  for (let inicio = 0; inicio < roster.length; inicio += LOTE_MAX_LINHAS) {
    const numeroLote = inicio / LOTE_MAX_LINHAS + 1;
    const lote = roster.slice(inicio, inicio + LOTE_MAX_LINHAS);
    const valores = [];
    const placeholders = lote.map((item, i) => {
      valores.push(empresaId, dataHoje, item.etapa || null, item.livro, item.unidadeConsumidora);
      const base = i * 5;
      return `($${base + 1}, $${base + 2}::date, $${base + 3}, $${base + 4}, $${base + 5})`;
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
