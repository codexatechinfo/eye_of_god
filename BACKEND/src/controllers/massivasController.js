const { obterResumo, obterOpcoesFiltro, obterDetalhe, obterHistoricoLivro } = require('../services/massivasService');

async function resumo(req, res) {
  try {
    const { regional, livro, etapa, colaborador, status, prazo, tipoServico } = req.query;
    const dados = await obterResumo(req.db, { regional, livro, etapa, colaborador, status, prazo, tipoServico });
    res.json({ sucesso: true, ...dados });
  } catch (erro) {
    console.error('❌ Erro ao obter resumo de massivas:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

async function opcoesFiltro(req, res) {
  try {
    const { tipoServico } = req.query;
    const opcoes = await obterOpcoesFiltro(req.db, { tipoServico });
    res.json({ sucesso: true, ...opcoes });
  } catch (erro) {
    console.error('❌ Erro ao obter opções de filtro de massivas:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

async function detalhe(req, res) {
  try {
    const { regional, livro, etapa, colaborador, status, prazo, tipoServico, faixaDias } = req.query;
    const dados = await obterDetalhe(req.db, { regional, livro, etapa, colaborador, status, prazo, tipoServico, faixaDias });
    res.json({ sucesso: true, ...dados });
  } catch (erro) {
    console.error('❌ Erro ao obter detalhe de massivas:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

async function historicoLivro(req, res) {
  try {
    const { livro } = req.query;
    if (!livro) {
      return res.status(400).json({ sucesso: false, erro: 'Parâmetro "livro" é obrigatório.' });
    }
    const dados = await obterHistoricoLivro(req.db, livro);
    res.json({ sucesso: true, ...dados });
  } catch (erro) {
    console.error('❌ Erro ao obter histórico do livro:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

module.exports = { resumo, opcoesFiltro, detalhe, historicoLivro };
