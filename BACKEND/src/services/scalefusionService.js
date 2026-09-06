const { log, logWarn } = require('../utils/logTempo');

// API Scalefusion (via FIMM) — token bearer sem expiração, sem fluxo de
// login (diferente da SEGSAT). Ver especificação da A2L (documento
// "Especificacao_API_Scalefusion_COPEL.docx") e docs/adr sobre esta
// integração. Resposta de /devices é cacheada no servidor deles por 5min —
// chamar mais que isso não traz dado novo (ver LIMITE_INTERVALO_MINUTOS no
// job).
const API_BASE = process.env.SCALEFUSION_API_BASE;
const API_TOKEN = process.env.SCALEFUSION_API_TOKEN;

// "PREFIXO - NOME DO COLABORADOR - IMEI" — espaçamento ao redor dos hífens é
// inconsistente na base real (achado ao vivo: "CMO -RAFAEL..." sem espaço
// depois do primeiro hífen), por isso \s* em vez de exigir " - " literal.
// IMEI às vezes vem prefixado com a palavra "IMEI " (um dos 6 cadastros fora
// do padrão citados na especificação) — aceito e descartado, não faz parte
// do nome. Casos sem os dois hífens (só IMEI cru, ou "NOME - IMEI" sem
// prefixo) não batem aqui de propósito — ver comentário em
// obterNomeEPrefixo sobre esses ficarem de fora até correção no cadastro.
const REGEX_NOME_DISPOSITIVO = /^(\S+)\s*-\s*(.+?)\s*-\s*(?:IMEI\s*)?(\d{14,16})\s*$/;

function obterNomeEPrefixo(nomeDispositivo) {
  const m = REGEX_NOME_DISPOSITIVO.exec(nomeDispositivo || '');
  if (!m) return null;
  return { prefixo: m[1], colaborador: m[2].trim(), imei: m[3] };
}

async function buscarDevices() {
  if (!API_BASE || !API_TOKEN) {
    throw new Error('SCALEFUSION_API_BASE/SCALEFUSION_API_TOKEN não configurados no .env');
  }
  const resposta = await fetch(`${API_BASE}/devices`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  if (!resposta.ok) {
    throw new Error(`Scalefusion /devices respondeu ${resposta.status}`);
  }
  const corpo = await resposta.json();
  return corpo.devices ?? [];
}

// Roster inteiro (qualquer situação — um dispositivo pode ser de alguém
// momentaneamente afastado, e o cadastro pode estar um ciclo defasado) pra
// casar contra o nome extraído do dispositivo. Nome como chave de
// casamento, mesmo padrão já usado no resto do sistema (contr_execucao_leitura
// x base_dados_leitura, sempre por nome exato — ver ADR 0025).
async function obterRosterColaboradores(db) {
  const { rows } = await db.query('SELECT colaborador, cargo FROM ativos_inativos');
  const mapa = new Map();
  for (const linha of rows) {
    const chave = linha.colaborador.trim().toUpperCase();
    if (!mapa.has(chave)) mapa.set(chave, linha);
  }
  return mapa;
}

// Última posição já gravada de cada colaborador (qualquer dia — o corte por
// "hoje" quem decide é a tela que consome, esta tabela é histórico bruto) —
// usada só pra não regravar a MESMA posição a cada ciclo. A API só atualiza
// a cada 5min; rodar o job a cada 5min ainda assim pode pegar o mesmo
// retrato se o aparelho não andou ou não reportou desde a última coleta.
async function obterUltimaPosicaoPorColaborador(db) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (colaborador) colaborador, data_hora_posicao
     FROM scalefusion
     ORDER BY colaborador, coletado_em DESC`,
  );
  return new Map(rows.map(r => [r.colaborador, r.data_hora_posicao ? new Date(r.data_hora_posicao).getTime() : null]));
}

async function coletarPosicoes(db, empresaId) {
  const devices = await buscarDevices();
  const roster = await obterRosterColaboradores(db);
  const ultimaPorColaborador = await obterUltimaPosicaoPorColaborador(db);

  const linhasParaGravar = [];
  let semParse = 0;
  let semRoster = 0;

  for (const device of devices) {
    const parseado = obterNomeEPrefixo(device.name);
    if (!parseado) {
      semParse++;
      continue;
    }
    const info = roster.get(parseado.colaborador.toUpperCase());
    if (!info) {
      semRoster++;
      continue;
    }

    const dataHoraMs = device.location?.date_time ?? null;
    const ultimaMs = ultimaPorColaborador.get(info.colaborador) ?? null;
    // Sem posição nenhuma (location ausente) OU mesma posição já gravada
    // antes — não grava de novo, sem informação nova.
    if (dataHoraMs === null || dataHoraMs === ultimaMs) continue;

    linhasParaGravar.push({
      device_id: device.id ?? null,
      nome_dispositivo: device.name ?? null,
      colaborador: info.colaborador,
      cargo: info.cargo,
      bateria_percentual: device.battery_status ?? null,
      bateria_carregando: device.battery_charging ?? null,
      latitude: device.location?.lat != null ? String(device.location.lat) : null,
      longitude: device.location?.lng != null ? String(device.location.lng) : null,
      endereco: device.location?.address ?? null,
      data_hora_posicao: new Date(dataHoraMs).toISOString(),
      empresa_id: empresaId,
    });
  }

  if (linhasParaGravar.length) {
    const colunas = [
      'device_id', 'nome_dispositivo', 'colaborador', 'cargo', 'bateria_percentual',
      'bateria_carregando', 'latitude', 'longitude', 'endereco', 'data_hora_posicao', 'empresa_id',
    ];
    const valoresSql = [];
    const parametros = [];
    linhasParaGravar.forEach((linha, i) => {
      const base = i * colunas.length;
      valoresSql.push(`(${colunas.map((_, j) => `$${base + j + 1}`).join(', ')})`);
      parametros.push(...colunas.map(c => linha[c]));
    });
    await db.query(
      `INSERT INTO scalefusion (${colunas.join(', ')}) VALUES ${valoresSql.join(', ')}`,
      parametros,
    );
  }

  log(
    `[Scalefusion] ${devices.length} dispositivos · ${linhasParaGravar.length} posições novas gravadas · ` +
      `${semRoster} sem colaborador correspondente · ${semParse} com nome fora do padrão`,
  );
  if (semParse > 0) {
    logWarn(`[Scalefusion] ${semParse} dispositivo(s) com nome fora do padrão "PREFIXO - COLABORADOR - IMEI" — ver especificação, seção 5.3.`);
  }

  return { total: devices.length, gravadas: linhasParaGravar.length, semRoster, semParse };
}

module.exports = { coletarPosicoes, obterNomeEPrefixo };
