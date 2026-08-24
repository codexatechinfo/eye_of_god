const { listarAtivos, listarOpcoesFiltro } = require('../services/colaboradoresService');
const { listarAtividadeHoje } = require('../services/atividadeColaboradoresService');

async function ativos(req, res) {
  try {
    const { colaborador, cargo, regional } = req.query;
    const lista = await listarAtivos({ colaborador, cargo, regional });
    res.json({ sucesso: true, total: lista.length, colaboradores: lista });
  } catch (erro) {
    console.error('❌ Erro ao listar colaboradores ativos:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

async function opcoesFiltro(req, res) {
  try {
    const opcoes = await listarOpcoesFiltro();
    res.json({ sucesso: true, ...opcoes });
  } catch (erro) {
    console.error('❌ Erro ao obter opções de filtro:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

async function atividadeHoje(req, res) {
  try {
    const dados = await listarAtividadeHoje();
    res.json({ sucesso: true, ...dados });
  } catch (erro) {
    console.error('❌ Erro ao obter atividade dos colaboradores:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

module.exports = { ativos, opcoesFiltro, atividadeHoje };
