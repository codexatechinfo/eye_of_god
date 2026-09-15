const { Pool } = require('pg');

// max:20 (default do `pg` é 10) — achado ao vivo (2026-09-14): a consulta de
// `roster_do_dia` (monitoramentoService.js, já sinalizada como lenta no
// CHANGELOG) leva 15-30s sob o volume atual de roster_ucs_extracao_diaria
// (200mil+ UCs/dia) e várias rodam ao mesmo tempo (ciclo de coleta de 3min +
// requisições de usuário) — sozinho isso já consumia boa parte de um pool de
// 10, deixando pouca folga pra qualquer outra requisição rápida. `max:20` é
// alívio imediato (Postgres tem `max_connections=100`, folga de sobra); não
// resolve a lentidão da consulta em si, que segue como investigação
// separada e pendente (ver CHANGELOG.md).
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });

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
//
// 60s (primeira tentativa) era curto DEMAIS: os jobs de coleta
// (coletaMassivasJob.js, coletaCopelService.js) abrem a transação (via
// abrirContextoTenant) ANTES de raspar o portal da Copel, não só antes do
// INSERT final — o tempo de rede/scrape inteiro conta como "idle in
// transaction" pro Postgres (nenhuma query rodando, só esperando o
// Playwright). Confirmado ao vivo: com 60s, TODO ciclo de "Massivas" (que
// legitimamente leva ~90s de login+busca) passou a falhar, não só o
// vazamento real que este timeout foi criado pra pegar (esse ficou parado
// 28-40 MINUTOS). 10 minutos ainda pega o vazamento de verdade bem antes de
// esgotar o pool de novo, com folga de sobra pro scrape mais lento.
pool.on('connect', client => {
  client.query('SET idle_in_transaction_session_timeout = 600000').catch(() => {});
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
  //
  // removeAllListeners ANTES de registrar o nosso — achado ao vivo
  // (2026-09-15): `pg-pool` reaproveita o mesmo objeto Client entre
  // checkouts diferentes ao longo da vida do processo, e sem isso cada
  // chamada de abrirContextoTenant empilhava mais um listener de 'error' em
  // cima do(s) da(s) chamada(s) anterior(es) — nunca removido no release().
  // Sintoma visto ao vivo: MaxListenersExceededWarning e o mesmo erro real
  // logado 2x, depois 4x, crescendo a cada reuso do client. Seguro remover
  // tudo aqui: o listener 'ocioso' que o pg-pool registra em pool.on('connect')
  // já foi removido por ele mesmo no acquire, então não sobra nada nosso pra
  // preservar neste ponto.
  client.removeAllListeners('error');
  client.on('error', erro => {
    console.error('❌ Erro assíncrono num client em uso (conexão encerrada pelo Postgres):', erro.message);
  });
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.nivel', nivel || '']);
    await client.query('SELECT set_config($1, $2, true)', ['app.empresa_id', empresaId || '']);
    return client;
  } catch (erro) {
    // client.release(erro), mesmo motivo do fecharContextoTenant abaixo — se
    // o BEGIN/set_config falhou por causa do client em si (não por um erro
    // de negócio), devolver sem avisar deixaria o próximo checkout herdar um
    // client quebrado.
    client.release(erro);
    throw erro;
  }
}

// Nunca deixa escapar — achado ao vivo (2026-09-14), na sequência direta do
// incidente documentado acima: um client cuja conexão já morreu (Postgres
// matou por idle_in_transaction_session_timeout, rede caiu) fica marcado
// "not queryable" pelo `pg` — a PRÓPRIA chamada de COMMIT/ROLLBACK aqui
// lança de novo. Coletas em background (coletaJob.js, coletaMassivasJob.js
// e os outros) só embrulham a chamada de negócio num try/catch, não esta
// função de limpeza do catch — sem o try/catch AQUI, esse segundo erro
// escapava pro loop `while(true)` sem ninguém pra pegar e derrubava o
// processo Node inteiro de novo (2ª crash na mesma madrugada, depois do
// idle_in_transaction_session_timeout: "Client has encountered a connection
// error and is not queryable", em coletaMassivasJob.js). `client.release(erro)`
// (não `.release()` sem argumento) quando a limpeza falha — avisa o pool
// pra DESTRUIR esse client em vez de devolvê-lo pro pool pra reuso; um
// client marcado "not queryable" nunca vai voltar a funcionar.
async function fecharContextoTenant(client, commit) {
  try {
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    client.release();
  } catch (erro) {
    console.error('❌ Erro ao encerrar transação (client provavelmente já morto) — descartando client:', erro.message);
    client.release(erro);
  }
}

module.exports = { pool, abrirContextoTenant, fecharContextoTenant };
