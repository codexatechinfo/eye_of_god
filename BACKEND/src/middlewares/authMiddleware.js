const jwt = require('jsonwebtoken');

function autenticarToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // "Bearer <token>"

  if (!token) {
    return res.status(401).json({ sucesso: false, erro: 'Token não fornecido' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (erro, payload) => {
    if (erro) {
      return res.status(403).json({ sucesso: false, erro: 'Token inválido ou expirado' });
    }
    req.usuario = payload;
    next();
  });
}

function exigirAdmin(req, res, next) {
  if (req.usuario?.nivel !== 'ADMIN') {
    return res.status(403).json({ sucesso: false, erro: 'Acesso restrito a administradores' });
  }
  next();
}

module.exports = { autenticarToken, exigirAdmin };