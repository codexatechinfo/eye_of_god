const { importarArquivo, gerarExemploTodasTabelas, CONFIG_IMPORTACAO } = require('../services/importacaoService');
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

// ROOT não tem empresa própria — precisa escolher qual empresa recebe o
// import (?empresaId= na URL). Pra quem não é ROOT, o alvo é sempre a
// própria empresa; nunca aceita empresaId do corpo/URL nesse caso, senão um
// ADMINISTRADOR poderia gravar dado na empresa alheia só trocando o parâmetro.
function empresaAlvo(req, config) {
  if (!config.temEmpresa) return null; // tabela compartilhada, empresa não se aplica
  return req.usuario.nivel === 'ROOT' ? req.query.empresaId : req.usuario.empresaId;
}

async function importar(req, res) {
  try {
    const { tabela } = req.params;
    const config = CONFIG_IMPORTACAO[tabela];
    if (!config) {
      return res.status(400).json({ sucesso: false, erro: `Tabela "${tabela}" não está habilitada para importação.` });
    }
    if (!req.file) {
      return res.status(400).json({ sucesso: false, erro: 'Nenhum arquivo enviado (campo "arquivo").' });
    }

    const empresaId = empresaAlvo(req, config);
    if (config.temEmpresa && !empresaId) {
      return res.status(400).json({ sucesso: false, erro: 'empresaId é obrigatório para ROOT nessa tabela.' });
    }

    const resultado = await importarArquivo(req.db, tabela, empresaId, req.file.buffer);

    await registrarAuditoria(req.db, {
      empresaId,
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

async function exemplo(req, res) {
  try {
    const buffer = await gerarExemploTodasTabelas(req.db);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="exemplo_importacao.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (erro) {
    console.error('❌ Erro ao gerar exemplo de importação:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

module.exports = { tabelasDisponiveis, importar, exemplo };
