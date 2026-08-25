// Prova que a RLS por empresa funciona de verdade — não só no papel.
// Roda contra o Postgres local de verdade (não é mock): precisa da stack
// do /infra no ar. `npm test` na raiz do BACKEND.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

const EMPRESA_PRINCIPAL = process.env.EMPRESA_PRINCIPAL_ID;
const EMPRESA_OUTRA = '22222222-2222-2222-2222-222222222222';

async function comContexto(nivel, empresaId, fn) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT set_config($1, $2, true)', ['app.nivel', nivel || '']);
  await client.query('SELECT set_config($1, $2, true)', ['app.empresa_id', empresaId || '']);
  try {
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
}

test('sem contexto de tenant, nenhuma linha é visível (fail-closed)', async () => {
  const total = await comContexto(null, null, async client => {
    const { rows } = await client.query('SELECT count(*)::int AS n FROM em_execucao_im');
    return rows[0].n;
  });
  assert.equal(total, 0);
});

test('empresa A não enxerga linha de empresa B', async () => {
  const total = await comContexto('USUARIO', EMPRESA_OUTRA, async client => {
    const { rows } = await client.query('SELECT count(*)::int AS n FROM em_execucao_im');
    return rows[0].n;
  });
  assert.equal(total, 0);
});

test('empresa dona enxerga a própria linha', async () => {
  const total = await comContexto('USUARIO', EMPRESA_PRINCIPAL, async client => {
    const { rows } = await client.query('SELECT count(*)::int AS n FROM em_execucao_im');
    return rows[0].n;
  });
  assert.ok(total > 0, 'esperava pelo menos uma linha da empresa principal');
});

test('ROOT enxerga todas as empresas', async () => {
  const total = await comContexto('ROOT', null, async client => {
    const { rows } = await client.query('SELECT count(*)::int AS n FROM em_execucao_im');
    return rows[0].n;
  });
  assert.ok(total > 0, 'ROOT deveria ver o mesmo total que a empresa dona');
});

test('usuário comum não consegue criar empresa (with check bloqueia)', async () => {
  await comContexto('USUARIO', EMPRESA_PRINCIPAL, async client => {
    await assert.rejects(
      client.query("INSERT INTO empresas (nome) VALUES ('empresa invasora')"),
      /row-level security/,
    );
  });
});

test('usuário não grava linha carimbando empresa alheia (with check no insert)', async () => {
  await comContexto('USUARIO', EMPRESA_PRINCIPAL, async client => {
    await assert.rejects(
      client.query(
        `INSERT INTO em_execucao_im (empresa_id, livro, dt_import, hr_import)
         VALUES ($1, 'TESTE-ISOLAMENTO', '01/01/2026', '00:00:00')`,
        [EMPRESA_OUTRA],
      ),
      /row-level security/,
    );
  });
});

// calendario_leitura, cidades_localidades e tab_ligacao_coordenadas eram
// referência compartilhada (sem empresa_id) até a ADR 0009 — cada empresa
// pode ter seu próprio contrato/região, então passaram a isolar como as
// demais. Prova que a policy pegou nas 3, não só nas que já existiam antes.
for (const tabela of ['calendario_leitura', 'cidades_localidades', 'tab_ligacao_coordenadas']) {
  test(`${tabela}: sem contexto de tenant, nenhuma linha é visível (fail-closed)`, async () => {
    const total = await comContexto(null, null, async client => {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${tabela}`);
      return rows[0].n;
    });
    assert.equal(total, 0);
  });

  test(`${tabela}: empresa A não enxerga linha de empresa B`, async () => {
    const total = await comContexto('USUARIO', EMPRESA_OUTRA, async client => {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${tabela}`);
      return rows[0].n;
    });
    assert.equal(total, 0);
  });
}
