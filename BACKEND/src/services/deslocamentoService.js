// Distância (Haversine) e classificação de intervalo (deslocamento vs
// pausa) entre duas leituras consecutivas de UC — usado pela timeline do
// painel de livro (massivasService.js#obterUcsDoLivro), pela jornada do
// colaborador (atividadeColaboradoresService.js#obterJornadaColaborador) e
// pelos cards "Km percorrido" (livro e colaborador). Uma fórmula só, pra não
// divergir entre os dois lugares que precisam dela.
const RAIO_TERRA_METROS = 6371000;

// Confirmado com o usuário: acima desse limite o intervalo entre duas
// leituras deixa de ser "deslocamento normal" e vira "ocioso/pausa" — 5min
// pra etapa urbana (01-19), 15min pra rural (21-38), mesma faixa já usada
// em ETAPA_URBANA_CONTR_SQL (massivasService.js).
const LIMITE_URBANO_SEGUNDOS = 5 * 60;
const LIMITE_RURAL_SEGUNDOS = 15 * 60;

function etapaUrbana(etapa) {
  const numero = Number(etapa);
  return numero >= 1 && numero <= 19;
}

function distanciaMetros(lat1, lon1, lat2, lon2) {
  const toRad = grau => (grau * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return RAIO_TERRA_METROS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// "DD/MM/YYYY" + "HH:MM:SS" -> diferença em segundos, sempre >= 0 (mesmo se
// os dois pontos vierem fora de ordem por algum motivo — não faz sentido um
// intervalo negativo aqui).
function segundosEntre(dataA, horaA, dataB, horaB) {
  const [diaA, mesA, anoA] = (dataA || '').split('/').map(Number);
  const [diaB, mesB, anoB] = (dataB || '').split('/').map(Number);
  const [hA, mA, sA] = (horaA || '0:0:0').split(':').map(Number);
  const [hB, mB, sB] = (horaB || '0:0:0').split(':').map(Number);
  if (!diaA || !diaB) return 0;
  const msA = new Date(anoA, mesA - 1, diaA, hA || 0, mA || 0, sA || 0).getTime();
  const msB = new Date(anoB, mesB - 1, diaB, hB || 0, mB || 0, sB || 0).getTime();
  return Math.max(0, Math.round((msB - msA) / 1000));
}

// anterior/atual: { latitude, longitude, data_import, hora_import, etapa }
// (mesmo shape das linhas de contr_execucao_leitura enriquecidas com
// coordenada). null quando falta coordenada em qualquer um dos dois lados
// (UC sem correspondência em coordenadas_ucs_mineradas, ~4% dos casos, ver
// ADR 0021 Adendo 5) — quem chama decide o que fazer com esse caso (via
// LEFT JOIN a leitura continua contando pro total, só não contribui pra
// distância/segmento).
function calcularSegmento(anterior, atual) {
  if (!anterior?.latitude || !anterior?.longitude || !atual?.latitude || !atual?.longitude) return null;

  const distancia = distanciaMetros(Number(anterior.latitude), Number(anterior.longitude), Number(atual.latitude), Number(atual.longitude));
  const segundos = segundosEntre(anterior.data_import, anterior.hora_import, atual.data_import, atual.hora_import);
  const limite = etapaUrbana(atual.etapa) ? LIMITE_URBANO_SEGUNDOS : LIMITE_RURAL_SEGUNDOS;

  return {
    distanciaMetros: distancia,
    intervaloSegundos: segundos,
    velocidadeMetrosPorMinuto: segundos > 0 ? distancia / (segundos / 60) : 0,
    tipo: segundos > limite ? 'pausa' : 'deslocamento',
  };
}

module.exports = {
  distanciaMetros,
  segundosEntre,
  calcularSegmento,
  etapaUrbana,
  LIMITE_URBANO_SEGUNDOS,
  LIMITE_RURAL_SEGUNDOS,
};
