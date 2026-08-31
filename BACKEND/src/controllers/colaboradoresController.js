const { listarAtivos, listarOpcoesFiltro } = require('../services/colaboradoresService');
const {
  listarAtividadeHoje,
  obterUltimaUcRealizadaPorColaborador,
  obterJornadaColaborador,
} = require('../services/atividadeColaboradoresService');

// "YYYY-MM-DD" -> "DD/MM/YYYY" (mesmo formato de contr_execucao_leitura.data_import).
function isoParaDataBr(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso || '').trim());
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

function hojeBr() {
  const agora = new Date();
  const dia = String(agora.getDate()).padStart(2, '0');
  const mes = String(agora.getMonth() + 1).padStart(2, '0');
  return `${dia}/${mes}/${agora.getFullYear()}`;
}

async function ativos(req, res) {
  try {
    const { colaborador, cargo, regional } = req.query;
    const lista = await listarAtivos(req.db, { colaborador, cargo, regional });
    res.json({ sucesso: true, total: lista.length, colaboradores: lista });
  } catch (erro) {
    console.error('❌ Erro ao listar colaboradores ativos:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

async function opcoesFiltro(req, res) {
  try {
    const opcoes = await listarOpcoesFiltro(req.db);
    res.json({ sucesso: true, ...opcoes });
  } catch (erro) {
    console.error('❌ Erro ao obter opções de filtro:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

async function atividadeHoje(req, res) {
  try {
    const { data } = req.query;
    const dados = await listarAtividadeHoje(req.db, data);
    res.json({ sucesso: true, ...dados });
  } catch (erro) {
    console.error('❌ Erro ao obter atividade dos colaboradores:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

async function localizacoes(req, res) {
  try {
    const dados = await obterUltimaUcRealizadaPorColaborador(req.db);
    res.json({ sucesso: true, localizacoes: dados });
  } catch (erro) {
    console.error('❌ Erro ao obter localizações dos colaboradores:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

async function jornada(req, res) {
  try {
    const { colaborador, data } = req.query;
    if (!colaborador) {
      return res.status(400).json({ sucesso: false, erro: 'Parâmetro "colaborador" é obrigatório.' });
    }
    const dataBr = data ? isoParaDataBr(data) : hojeBr();
    if (!dataBr) {
      return res.status(400).json({ sucesso: false, erro: 'Parâmetro "data" inválido, use YYYY-MM-DD.' });
    }
    const dados = await obterJornadaColaborador(req.db, colaborador, dataBr);
    res.json({ sucesso: true, ...dados });
  } catch (erro) {
    console.error('❌ Erro ao obter jornada do colaborador:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

module.exports = { ativos, opcoesFiltro, atividadeHoje, localizacoes, jornada };
