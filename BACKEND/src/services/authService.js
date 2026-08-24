const bcrypt = require('bcrypt');
const { pool } = require('../config/db');

const SALT_ROUNDS = 10;

async function criarUsuario({ nome, email, senha, nivel = 'USUARIO' }) {
  const senhaHash = await bcrypt.hash(senha, SALT_ROUNDS);

  const { rows } = await pool.query(
    `INSERT INTO users (nome, email, senha, nivel)
     VALUES ($1, $2, $3, $4)
     RETURNING id, nome, email, nivel, criado_em`,
    [nome, email, senhaHash, nivel],
  );
  return rows[0];
}

async function autenticar({ email, senha }) {
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const usuario = rows[0];

  if (!usuario || !usuario.ativo) {
    throw new Error('Usuário não encontrado');
  }

  const senhaValida = await bcrypt.compare(senha, usuario.senha);
  if (!senhaValida) {
    throw new Error('Senha incorreta');
  }

  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    nivel: usuario.nivel,
  };
}

module.exports = { criarUsuario, autenticar };
