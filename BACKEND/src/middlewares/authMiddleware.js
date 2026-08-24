const jwt = require('jsonwebtoken');
const { abrirContextoTenant, fecharContextoTenant } = require('../config/db');

// Hierarquia usada por exigirNivel — cada papel enxerga a si mesmo e os de baixo.
const NIVEIS = ['USUARIO', 'SUPERVISOR', 'ADMINISTRADOR', 'ROOT'];

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

// Abre a transação com o contexto de tenant (empresa_id/nível) do usuário do
// token e a fecha no fim da resposta — commit em sucesso, rollback em erro.
// Precisa rodar depois de autenticarToken.
function anexarContextoTenant(req, res, next) {
  abrirContextoTenant({ empresaId: req.usuario?.empresaId, nivel: req.usuario?.nivel })
    .then(client => {
      req.db = client;
      res.on('finish', () => {
        fecharContextoTenant(client, res.statusCode < 400).catch(erro =>
          console.error('❌ Erro ao encerrar contexto de tenant:', erro),
        );
      });
      next();
    })
    .catch(erro => {
      console.error('❌ Erro ao abrir contexto de tenant:', erro);
      res.status(500).json({ sucesso: false, erro: 'Erro ao conectar ao banco' });
    });
}

function exigirNivel(...niveisPermitidos) {
  return (req, res, next) => {
    if (!niveisPermitidos.includes(req.usuario?.nivel)) {
      return res.status(403).json({ sucesso: false, erro: 'Acesso restrito' });
    }
    next();
  };
}

// exigirNivelMinimo('SUPERVISOR') deixa passar SUPERVISOR, ADMINISTRADOR e ROOT.
function exigirNivelMinimo(nivelMinimo) {
  const indiceMinimo = NIVEIS.indexOf(nivelMinimo);
  return (req, res, next) => {
    const indiceUsuario = NIVEIS.indexOf(req.usuario?.nivel);
    if (indiceUsuario === -1 || indiceUsuario < indiceMinimo) {
      return res.status(403).json({ sucesso: false, erro: 'Acesso restrito' });
    }
    next();
  };
}

module.exports = { autenticarToken, anexarContextoTenant, exigirNivel, exigirNivelMinimo, NIVEIS };
