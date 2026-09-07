const { log } = require('../utils/logTempo');

// API de frota SEGSAT (veículos) — diferente da Scalefusion, exige login
// (header "frota-token") pra obter um "sid" de sessão a cada chamada. sid
// expira em 3min sem uso (ver especificação) — como o job roda a cada
// PAUSA_ENTRE_CICLOS_MS (5min, ver segsatFrotaJob.js), mais que esse prazo,
// não vale a pena guardar sid entre ciclos: login de novo a cada ciclo é
// mais simples e nunca esbarra na expiração.
const API_TOKEN = process.env.SEGSAT_FROTA_TOKEN;
const API_BASE = 'https://ws-frota.segsat.com/api/segsatFrota/v1';

async function login() {
  const resposta = await fetch(`${API_BASE}/login`, {
    headers: { 'frota-token': API_TOKEN },
  });
  if (!resposta.ok) throw new Error(`SEGSAT /login respondeu ${resposta.status}`);
  const { sid } = await resposta.json();
  return sid;
}

async function buscarUnidades(sid) {
  const resposta = await fetch(`${API_BASE}/getAllUnits`, {
    headers: { sid },
  });
  if (!resposta.ok) throw new Error(`SEGSAT /getAllUnits respondeu ${resposta.status}`);
  return resposta.json();
}

// Placa -> colaborador, vindo da tabela `segsat` (planilha da empresa
// locadora, ver ADR 0034) — só as linhas com colaborador atribuído.
async function obterMapeamentoPlacas(db) {
  const { rows } = await db.query('SELECT placa, colaborador FROM segsat WHERE colaborador IS NOT NULL');
  const mapa = new Map();
  for (const linha of rows) mapa.set(linha.placa.trim().toUpperCase(), linha.colaborador);
  return mapa;
}

// Mesmo raciocínio de obterRosterColaboradores em scalefusionService.js —
// roster inteiro, qualquer situação, casado por nome exato.
async function obterRosterColaboradores(db) {
  const { rows } = await db.query('SELECT colaborador, cargo FROM ativos_inativos');
  const mapa = new Map();
  for (const linha of rows) {
    const chave = linha.colaborador.trim().toUpperCase();
    if (!mapa.has(chave)) mapa.set(chave, linha);
  }
  return mapa;
}

async function obterUltimaPosicaoPorColaborador(db) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (colaborador) colaborador, data_hora_posicao
     FROM segsat_posicoes
     ORDER BY colaborador, coletado_em DESC`,
  );
  return new Map(rows.map(r => [r.colaborador, r.data_hora_posicao ? new Date(r.data_hora_posicao).getTime() : null]));
}

async function coletarPosicoes(db, empresaId) {
  if (!API_TOKEN) throw new Error('SEGSAT_FROTA_TOKEN não configurado no .env');

  const sid = await login();
  const unidades = await buscarUnidades(sid);
  const mapeamentoPlacas = await obterMapeamentoPlacas(db);
  const roster = await obterRosterColaboradores(db);
  const ultimaPorColaborador = await obterUltimaPosicaoPorColaborador(db);

  const linhasParaGravar = [];
  let semMapeamento = 0;
  let semRoster = 0;

  for (const unidade of unidades) {
    // "nm" já confirmado ao vivo como a placa (bateu 100% contra a planilha
    // — ver ADR 0034), diferente de perfil.registration_plate, que só ~15%
    // das unidades têm preenchido.
    const placa = (unidade.nm || '').trim().toUpperCase();
    const colaboradorMapeado = mapeamentoPlacas.get(placa);
    if (!colaboradorMapeado) {
      semMapeamento++;
      continue;
    }
    const info = roster.get(colaboradorMapeado.trim().toUpperCase());
    if (!info) {
      semRoster++;
      continue;
    }

    // lmsg.t é epoch em SEGUNDOS (confirmado ao vivo — em milissegundos
    // cairia em 1970), diferente do date_time da Scalefusion, que já vem em
    // milissegundos.
    const tSegundos = unidade.lmsg?.t;
    if (!tSegundos) continue;
    const dataHoraMs = tSegundos * 1000;
    const ultimaMs = ultimaPorColaborador.get(info.colaborador) ?? null;
    if (dataHoraMs === ultimaMs) continue;

    linhasParaGravar.push({
      device_id: unidade.id ?? null,
      placa,
      colaborador: info.colaborador,
      cargo: info.cargo,
      latitude: unidade.lmsg?.pos?.y != null ? String(unidade.lmsg.pos.y) : null,
      longitude: unidade.lmsg?.pos?.x != null ? String(unidade.lmsg.pos.x) : null,
      velocidade: unidade.prms?.speed?.v ?? null,
      ignicao: unidade.prms?.term_acc?.v != null ? !!unidade.prms.term_acc.v : null,
      data_hora_posicao: new Date(dataHoraMs).toISOString(),
      empresa_id: empresaId,
    });
  }

  if (linhasParaGravar.length) {
    const colunas = [
      'device_id', 'placa', 'colaborador', 'cargo', 'latitude', 'longitude',
      'velocidade', 'ignicao', 'data_hora_posicao', 'empresa_id',
    ];
    const valoresSql = [];
    const parametros = [];
    linhasParaGravar.forEach((linha, i) => {
      const base = i * colunas.length;
      valoresSql.push(`(${colunas.map((_, j) => `$${base + j + 1}`).join(', ')})`);
      parametros.push(...colunas.map(c => linha[c]));
    });
    await db.query(
      `INSERT INTO segsat_posicoes (${colunas.join(', ')}) VALUES ${valoresSql.join(', ')}`,
      parametros,
    );
  }

  log(
    `[SEGSAT] ${unidades.length} veículos · ${linhasParaGravar.length} posições novas gravadas · ` +
      `${semMapeamento} sem mapeamento de placa (tabela segsat) · ${semRoster} colaborador mapeado mas fora do cadastro`,
  );

  return { total: unidades.length, gravadas: linhasParaGravar.length, semMapeamento, semRoster };
}

// Última posição+velocidade+ignição conhecida de cada colaborador motoqueiro
// — mesmo raciocínio de obterUltimasPosicoes em scalefusionService.js
// (sempre "o retrato mais recente já coletado", sem filtro de dia). Alimenta
// a posição real do motoqueiro no mapa (ver ADR 0033/0034).
async function obterUltimasPosicoes(db) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (colaborador)
       colaborador, cargo, placa, latitude, longitude, velocidade, ignicao, data_hora_posicao
     FROM segsat_posicoes
     ORDER BY colaborador, coletado_em DESC`,
  );
  return rows;
}

// Histórico do dia inteiro — mesmo raciocínio de obterHistoricoPosicoes em
// scalefusionService.js (camada "Rastro executado" do mapa, trajeto GPS
// real da moto, diferente da "Trajetória do dia" inferida das UCs lidas).
async function obterHistoricoPosicoes(db, colaborador, dataIso) {
  const { rows } = await db.query(
    `SELECT latitude, longitude, data_hora_posicao
     FROM segsat_posicoes
     WHERE colaborador = $1 AND data_hora_posicao::date = $2::date
       AND latitude IS NOT NULL AND longitude IS NOT NULL
     ORDER BY data_hora_posicao ASC`,
    [colaborador, dataIso],
  );
  return rows;
}

module.exports = { coletarPosicoes, obterUltimasPosicoes, obterHistoricoPosicoes };
