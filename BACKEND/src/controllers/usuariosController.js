const { criarUsuario, atualizarPerfilProprio } = require('../services/authService');
const { registrarAuditoria } = require('../services/auditoriaService');

async function criar(req, res) {
  try {
    const { nome, email, senha, nivel, empresaId } = req.body;
    if (!nome || !email || !senha) {
      return res.status(400).json({ sucesso: false, erro: 'Nome, email e senha são obrigatórios' });
    }

    // empresaId nunca vem do corpo pra quem não é ROOT — o alvo é sempre a
    // própria empresa de quem está criando.
    const empresaAlvo = req.usuario.nivel === 'ROOT' ? empresaId : req.usuario.empresaId;

    const usuario = await criarUsuario(req.db, { nome, email, senha, nivel, empresaId: empresaAlvo });
    await registrarAuditoria(req.db, {
      empresaId: empresaAlvo,
      usuarioId: req.usuario.sub,
      acao: 'criar_usuario',
      tabela: 'users',
      registroId: String(usuario.id),
    });
    res.status(201).json({ sucesso: true, usuario });
  } catch (erro) {
    if (erro.code === '23505') {
      return res.status(409).json({ sucesso: false, erro: 'Email já cadastrado' });
    }
    console.error('❌ Erro ao criar usuário:', erro);
    res.status(400).json({ sucesso: false, erro: erro.message });
  }
}

// Autoatendimento — só a própria foto/preferências, nunca nivel/empresa/senha.
async function atualizarMeuPerfil(req, res) {
  try {
    const { fotoPerfil, preferencias } = req.body;
    const usuario = await atualizarPerfilProprio(req.db, req.usuario.sub, { fotoPerfil, preferencias });
    res.json({ sucesso: true, usuario });
  } catch (erro) {
    console.error('❌ Erro ao atualizar perfil:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

module.exports = { criar, atualizarMeuPerfil };
