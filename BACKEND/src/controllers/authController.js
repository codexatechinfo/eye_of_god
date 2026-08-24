const { autenticar } = require('../services/authService');

async function login(req, res) {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) {
      return res.status(400).json({ sucesso: false, erro: 'Email e senha são obrigatórios' });
    }
    const { usuario, token } = await autenticar({ email, senha });
    res.json({ sucesso: true, usuario, token });
  } catch (erro) {
    res.status(401).json({ sucesso: false, erro: erro.message });
  }
}

module.exports = { login };
