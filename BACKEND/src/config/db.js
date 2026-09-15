const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Rede de segurança contra conexão vazada — achado ao vivo (2026-09-14):
// cada requisição HTTP segura um client dedicado do pool a transação
// inteira (abrirContextoTenant/fecharContextoTenant abaixo), liberado só
// quando `res.on('close')` dispara (authMiddleware.js). Uma resposta que não
// fecha de forma limpa (aba fechada/navegação no meio de uma chamada, algum
// caso de borda do event 'close') deixa o client preso "idle in
// transaction" pra sempre — encontradas 10 conexões assim (o pool inteiro,
// default `max: 10` do `pg`), todas as chamadas novas ficavam penduradas
// esperando um client livre que nunca vinha, derrubando o app inteiro
// ("a página não carrega"). `idle_in_transaction_session_timeout` faz o
// PRÓPRIO Postgres encerrar qualquer transação parada além do limite — o
// pool detecta o client morto e libera o slot sozinho, não depende de achar
// a causa exata do vazamento no código do Express pra parar de sangrar.
pool.on('connect', client => {
  client.query('SET idle_in_transaction_session_timeout = 60000').catch(() => {});
});

// SEM ISSO, o timeout acima (ou qualquer outro motivo do Postgres derrubar
// um client — rede, admin kill) crasha o processo Node INTEIRO: `pg` emite
// 'error' no client quando a conexão morre do lado do servidor, e um
// EventEmitter sem listener de 'error' registrado faz o Node tratar como
// exceção não tratada e sair. Descoberto ao vivo, da pior forma possível: o
// idle_in_transaction_session_timeout acima (adicionado agora mesmo, nesta
// mesma correção) disparou pra uma das conexões vazadas e derrubou o
// backend inteiro nos primeiros ~60s — o "remédio" da rede de segurança
// batia direto nessa lacuna que não existia antes dele.
//
// Cobre só o client OCIOSO DENTRO DO POOL (entre um checkout e outro) — não
// basta sozinho: `pg-pool` remove esse listener no MOMENTO do checkout
// (`_acquireClient`, `client.removeListener('error', idleListener)`) e só
// reanexa no `release()` — ou seja, um client em uso (exatamente o caso das
// conexões vazadas, presas em BEGIN sem COMMIT/ROLLBACK) fica SEM NENHUM
// listener de erro enquanto está checked out. Por isso abrirContextoTenant
// abaixo también anexa o seu próprio, pela duração inteira da requisição.
pool.on('error', erro => {
  console.error('❌ Erro assíncrono num client ocioso do pool (conexão encerrada pelo Postgres):', erro.message);
});

// Toda query de negócio passa por aqui: um client dedicado, numa transação,
// com app.nivel/app.empresa_id setados via set_config(..., true) — local à
// transação, então o client volta pro pool sem carregar contexto de tenant
// pra próxima requisição. RLS (docs/adr/0003) lê essas duas variáveis.
async function abrirContextoTenant({ empresaId, nivel }) {
  const client = await pool.connect();
  // Ver comentário de pool.on('error') acima — sem isso, encerrar essa
  // conexão específica pelo lado do Postgres enquanto ela está checked out
  // (idle_in_transaction_session_timeout batendo numa vazada, rede caindo,
  // admin matando a sessão) crasha o processo Node inteiro.
  client.on('error', erro => {
    console.error('❌ Erro assíncrono num client em uso (conexão encerrada pelo Postgres):', erro.message);
  });
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
