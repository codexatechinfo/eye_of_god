const { listarLimitesPorPontos } = require('../services/municipiosService');

// pontos: [[latitude, longitude], ...] — coordenadas das UCs do livro aberto
// no mapa (o frontend já tem esse dado carregado, ver ADR 0022 Adendo 2).
function pontosValidos(corpo) {
  if (!Array.isArray(corpo)) return null;
  const pontos = corpo.filter(
    p => Array.isArray(p) && p.length === 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])),
  );
  return pontos.length ? pontos : null;
}

async function limitesPorPontos(req, res) {
  try {
    const pontos = pontosValidos(req.body?.pontos);
    if (!pontos) {
      return res.status(400).json({ sucesso: false, erro: 'Parâmetro "pontos" é obrigatório: array de [latitude, longitude].' });
    }
    const dados = await listarLimitesPorPontos(req.db, pontos);
    res.json({ sucesso: true, municipios: dados });
  } catch (erro) {
    console.error('❌ Erro ao listar limites municipais:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

module.exports = { limitesPorPontos };
