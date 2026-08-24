const { importarArquivo, CONFIG_IMPORTACAO } = require('../services/importacaoService');
const { registrarAuditoria } = require('../services/auditoriaService');

async function tabelasDisponiveis(req, res) {
  res.json({
    sucesso: true,
    tabelas: Object.entries(CONFIG_IMPORTACAO).map(([tabela, cfg]) => ({
      tabela,
      modo: cfg.modo,
      chave: cfg.chave ?? null,
      compartilhada: !cfg.temEmpresa,
      colunas: cfg.colunas,
    })),
  });
}

async function importar(req, res) {
  try {
    const { tabela } = req.params;
    if (!CONFIG_IMPORTACAO[tabela]) {
      return res.status(400).json({ sucesso: false, erro: `Tabela "${tabela}" não está habilitada para importação.` });
    }
    if (!req.file) {
      return res.status(400).json({ sucesso: false, erro: 'Nenhum arquivo enviado (campo "arquivo").' });
    }

    const resultado = await importarArquivo(req.db, tabela, req.usuario.empresaId, req.file.buffer);

    await registrarAuditoria(req.db, {
      empresaId: req.usuario.empresaId,
      usuarioId: req.usuario.sub,
      acao: 'importar_arquivo',
      tabela,
      detalhe: { linhasProcessadas: resultado.linhasProcessadas, modo: resultado.modo, arquivo: req.file.originalname },
    });

    res.json({ sucesso: true, ...resultado });
  } catch (erro) {
    console.error('❌ Erro ao importar arquivo:', erro);
    res.status(400).json({ sucesso: false, erro: erro.message });
  }
}

module.exports = { tabelasDisponiveis, importar };
