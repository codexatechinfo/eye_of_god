const { log, logWarn } = require('../utils/logTempo');

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

// `segsat_posicoes` guarda UMA linha por colaborador (upsert por
// `(empresa_id, colaborador)`, ver coletarPosicoes) — não é mais log
// histórico, então não precisa de DISTINCT ON pra achar "a mais recente".
async function obterUltimaPosicaoPorColaborador(db) {
  const { rows } = await db.query(`SELECT colaborador, data_hora_posicao FROM segsat_posicoes`);
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
    // Upsert por (empresa_id, colaborador), não mais INSERT puro — a tabela
    // virou "posição atual" (1 linha por colaborador), não log histórico.
    // Ver Adendo em ADR 0034: histórico do dia agora vem sob demanda da API
    // (searchUnitPositionHistory), então acumular linha por linha aqui só
    // inflava a tabela com dado que nada mais lia.
    const colunasAtualizar = colunas.filter(c => c !== 'colaborador' && c !== 'empresa_id');
    await db.query(
      `INSERT INTO segsat_posicoes (${colunas.join(', ')}) VALUES ${valoresSql.join(', ')}
       ON CONFLICT (empresa_id, colaborador) DO UPDATE SET
       ${colunasAtualizar.map(c => `"${c}" = EXCLUDED."${c}"`).join(', ')}, coletado_em = now()`,
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
    `SELECT colaborador, cargo, placa, latitude, longitude, velocidade, ignicao, data_hora_posicao
     FROM segsat_posicoes`,
  );
  return rows;
}

async function obterPlacaPorColaborador(db, colaborador) {
  const { rows } = await db.query('SELECT placa FROM segsat WHERE colaborador = $1 LIMIT 1', [colaborador]);
  return rows[0]?.placa ?? null;
}

// Histórico do dia inteiro pra camada "Rastro executado" do mapa (trajeto
// GPS real da moto, diferente da "Trajetória do dia" inferida das UCs
// lidas) — direto na API SEGSAT (`searchUnitPositionHistory`), não mais na
// tabela `segsat_posicoes` (que virou "posição atual", 1 linha por
// colaborador, ver coletarPosicoes). Achado ao vivo (2026-09-10): esse
// endpoint devolve o histórico de posições do ÚLTIMO MÊS de uma unidade,
// com granularidade de minuto quando em movimento — muito mais denso que os
// pontos de 5 em 5 minutos que o job de polling conseguia acumular, e
// funciona pra qualquer dia recente mesmo que o job nunca tenha rodado
// naquele intervalo (ex.: veículo mapeado na planilha `segsat` só hoje
// ainda consegue ver o rastro de dias anteriores).
//
// Sob demanda (só quando o usuário abre a camada pra um colaborador+dia
// específico, mesmo padrão opt-in de limitesMunicipais/gpsHistorico) —
// nunca em lote, então o custo de fazer login a cada chamada é aceitável
// (mesmo raciocínio de coletarPosicoes: sid expira em 3min, não vale a pena
// cachear entre chamadas espaçadas).
//
// Qualquer falha (sem mapeamento de placa, API fora do ar, data fora da
// janela de um mês) devolve array vazio em vez de derrubar a rota inteira —
// é uma camada de conferência opcional do mapa, não dado crítico.
async function obterHistoricoPosicoes(db, colaborador, dataIso) {
  if (!API_TOKEN) return [];

  const placa = await obterPlacaPorColaborador(db, colaborador);
  if (!placa) return [];

  try {
    const sid = await login();
    const resposta = await fetch(`${API_BASE}/searchUnitPositionHistory`, {
      method: 'POST',
      headers: { sid, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: dataIso, unitName: placa }),
    });
    if (!resposta.ok) {
      logWarn(`[SEGSAT] searchUnitPositionHistory respondeu ${resposta.status} — colaborador=${colaborador} placa=${placa} data=${dataIso}`);
      return [];
    }
    const { positions } = await resposta.json();
    return (positions || [])
      .filter(p => p.latitude != null && p.longitude != null)
      .map(p => ({
        latitude: String(p.latitude),
        longitude: String(p.longitude),
        data_hora_posicao: p.timeStamp,
      }));
  } catch (erro) {
    logWarn(`[SEGSAT] Erro ao buscar histórico — colaborador=${colaborador} placa=${placa} data=${dataIso}: ${erro.message}`);
    return [];
  }
}

module.exports = { coletarPosicoes, obterUltimasPosicoes, obterHistoricoPosicoes };
