const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Toda query de negócio passa por aqui: um client dedicado, numa transação,
// com app.nivel/app.empresa_id setados via set_config(..., true) — local à
// transação, então o client volta pro pool sem carregar contexto de tenant
// pra próxima requisição. RLS (docs/adr/0003) lê essas duas variáveis.
async function abrirContextoTenant({ empresaId, nivel }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.nivel', nivel || '']);
    await client.query('SELECT set_config($1, $2, true)', ['app.empresa_id', empresaId || '']);
    return client;
  } catch (erro) {
    client.release();
    throw erro;
  }
}

async function fecharContextoTenant(client, commit) {
  try {
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
  } finally {
    client.release();
  }
}

module.exports = { pool, abrirContextoTenant, fecharContextoTenant };
