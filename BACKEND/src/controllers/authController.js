const { criarUsuario, autenticar } = require('../services/authService');

async function registrar(req, res) {
  try {
    const { nome, email, senha, nivel } = req.body;
    if (!nome || !email || !senha) {
      return res.status(400).json({ sucesso: false, erro: 'Nome, email e senha são obrigatórios' });
    }
    const usuario = await criarUsuario({ nome, email, senha, nivel });
    res.status(201).json({ sucesso: true, usuario });
  } catch (erro) {
    if (erro.code === 'P2002') {
      return res.status(409).json({ sucesso: false, erro: 'Email já cadastrado' });
    }
    console.error('❌ Erro ao registrar usuário:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

async function login(req, res) {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) {
      return res.status(400).json({ sucesso: false, erro: 'Email e senha são obrigatórios' });
    }
    const usuario = await autenticar({ email, senha });
    res.json({ sucesso: true, usuario });
  } catch (erro) {
    res.status(401).json({ sucesso: false, erro: erro.message });
  }
}

module.exports = { registrar, login };