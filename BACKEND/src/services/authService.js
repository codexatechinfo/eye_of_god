const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { abrirContextoTenant, fecharContextoTenant } = require('../config/db');

const SALT_ROUNDS = 10;
const TOKEN_EXPIRA_EM = '12h';

function assinarToken(usuario) {
  return jwt.sign(
    { sub: usuario.id, nome: usuario.nome, email: usuario.email, nivel: usuario.nivel, empresaId: usuario.empresa_id },
    process.env.JWT_SECRET,
    { expiresIn: TOKEN_EXPIRA_EM },
  );
}

// `db` é o client já aberto com o contexto de tenant de quem está chamando
// (vem de req.db, montado pelo authMiddleware.anexarContextoTenant a partir
// do token). RLS garante que ROOT cria em qualquer empresa e ADMINISTRADOR só
// na própria — o controller nunca deixa empresaId vir do corpo da requisição
// pra quem não é ROOT.
async function criarUsuario(db, { nome, email, senha, nivel = 'USUARIO', empresaId }) {
  if (nivel !== 'ROOT' && !empresaId) {
    throw new Error('empresaId é obrigatório para todo nível exceto ROOT');
  }

  const senhaHash = await bcrypt.hash(senha, SALT_ROUNDS);

  const { rows } = await db.query(
    `INSERT INTO users (nome, email, senha, nivel, empresa_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, nome, email, nivel, empresa_id, criado_em`,
    [nome, email, senhaHash, nivel, nivel === 'ROOT' ? null : empresaId],
  );
  return rows[0];
}

// Login é a única operação que precisa ler `users` sem saber ainda a empresa
// do usuário — abre um contexto próprio como ROOT (bypassa RLS) só pra achar
// a conta pelo e-mail; depois disso, toda requisição autenticada usa o
// contexto real do usuário (empresaId dele), nunca este.
async function autenticar({ email, senha }) {
  const client = await abrirContextoTenant({ nivel: 'ROOT' });
  let usuario;
  try {
    const { rows } = await client.query('SELECT * FROM users WHERE email = $1', [email]);
    usuario = rows[0];
  } finally {
    await fecharContextoTenant(client, true);
  }

  if (!usuario || !usuario.ativo) {
    throw new Error('Usuário não encontrado');
  }

  const senhaValida = await bcrypt.compare(senha, usuario.senha);
  if (!senhaValida) {
    throw new Error('Senha incorreta');
  }

  const usuarioPublico = {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    nivel: usuario.nivel,
    empresaId: usuario.empresa_id,
  };

  return { usuario: usuarioPublico, token: assinarToken(usuario) };
}

// Autoatendimento: o próprio usuário só pode alterar a foto e as preferências
// visuais — nada além disso passa por aqui (nem nivel, nem empresa, nem senha),
// e o WHERE id = $1 (id vem do token, nunca do corpo) restringe à própria linha.
async function atualizarPerfilProprio(db, userId, { fotoPerfil, preferencias }) {
  const { rows } = await db.query(
    `UPDATE users SET foto_perfil = COALESCE($2, foto_perfil),
                       preferencias = COALESCE($3, preferencias),
                       atualizado_em = now()
     WHERE id = $1
     RETURNING id, nome, email, nivel, foto_perfil, preferencias`,
    [userId, fotoPerfil ?? null, preferencias ? JSON.stringify(preferencias) : null],
  );
  return rows[0];
}

module.exports = { criarUsuario, autenticar, atualizarPerfilProprio };
