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

// Bounding box generoso do Brasil — a especificação da API
// (Especificacao_API_Scalefusion_COPEL.docx, seção 5.4) já registrou ao
// vivo um aparelho reportando posição no Uzbequistão (lat 39.6, lng 66.9) e
// avisa que "uma única coordenada dessas joga o enquadramento automático de
// qualquer mapa pra escala mundial" — confirmado ainda ativo na coleta
// (2026-09-10, mesmo colaborador do exemplo da especificação, dezenas de
// linhas repetidas). Não é erro de parsing nosso, é o que o aparelho/
// provedor de localização da Scalefusion está reportando; tratamos como
// "sem posição válida" (mesma coisa que location ausente) em vez de gravar
// e deixar corromper qualquer fitBounds() que inclua esse colaborador.
const BRASIL_LAT = [-34, 6];
const BRASIL_LNG = [-75, -28];
function coordenadaPlausivel(lat, lng) {
  return lat >= BRASIL_LAT[0] && lat <= BRASIL_LAT[1] && lng >= BRASIL_LNG[0] && lng <= BRASIL_LNG[1];
}

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

    const latBruta = device.location?.lat != null ? Number(device.location.lat) : null;
    const lngBruta = device.location?.lng != null ? Number(device.location.lng) : null;
    const plausivel = latBruta != null && lngBruta != null && coordenadaPlausivel(latBruta, lngBruta);
    if (latBruta != null && lngBruta != null && !plausivel) {
      logWarn(`[Scalefusion] Coordenada implausível descartada — colaborador=${info.colaborador} lat=${latBruta} lng=${lngBruta}`);
    }

    linhasParaGravar.push({
      device_id: device.id ?? null,
      nome_dispositivo: device.name ?? null,
      colaborador: info.colaborador,
      cargo: info.cargo,
      bateria_percentual: device.battery_status ?? null,
      bateria_carregando: device.battery_charging ?? null,
      latitude: plausivel ? String(latBruta) : null,
      longitude: plausivel ? String(lngBruta) : null,
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

// Última posição+bateria conhecida de cada colaborador (qualquer dia — não
// tem filtro de data como as telas baseadas em leitura, é sempre "o retrato
// mais recente que a gente já coletou"). Alimenta tanto a posição real do
// pedestre no mapa quanto o indicador de bateria na lista lateral (motoqueiro
// e pedestre, ver pedido do usuário).
async function obterUltimasPosicoes(db) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (colaborador)
       colaborador, cargo, latitude, longitude, bateria_percentual, bateria_carregando, data_hora_posicao
     FROM scalefusion
     ORDER BY colaborador, coletado_em DESC`,
  );
  return rows;
}

// Histórico do dia inteiro (não só a última posição) — alimenta a camada
// "Rastro executado" do mapa (ADR): trajeto GPS real do aparelho, diferente
// da "Trajetória do dia" (que conecta só os pontos de UC lida, inferido da
// execução, não GPS contínuo). `dataIso` é "YYYY-MM-DD" — comparado direto
// contra `data_hora_posicao::date` porque a coluna já é `timestamptz` (ao
// contrário do resto do schema em texto DD/MM/YYYY, aqui não tem o risco de
// fuso horário dos campos de texto).
async function obterHistoricoPosicoes(db, colaborador, dataIso) {
  const { rows } = await db.query(
    `SELECT latitude, longitude, data_hora_posicao
     FROM scalefusion
     WHERE colaborador = $1 AND data_hora_posicao::date = $2::date
       AND latitude IS NOT NULL AND longitude IS NOT NULL
     ORDER BY data_hora_posicao ASC`,
    [colaborador, dataIso],
  );
  return rows;
}

module.exports = { coletarPosicoes, obterNomeEPrefixo, obterUltimasPosicoes, obterHistoricoPosicoes };
