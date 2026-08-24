const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const SALT_ROUNDS = 10;

async function criarUsuario({ nome, email, senha, nivel = 'USUARIO' }) {
  const senhaHash = await bcrypt.hash(senha, SALT_ROUNDS);

  return prisma.users.create({
    data: { nome, email, senha: senhaHash, nivel },
    select: { id: true, nome: true, email: true, nivel: true, criado_em: true },
  });
}

async function autenticar({ email, senha }) {
  const usuario = await prisma.users.findUnique({ where: { email } });

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