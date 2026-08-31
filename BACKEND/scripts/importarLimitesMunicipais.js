// Import único: baixa a malha de municípios do Paraná (IBGE) e popula
// municipios_limites. Rodar com: node scripts/importarLimitesMunicipais.js
// Ver docs/adr/0022-camadas-mapa-e-limites-municipais.md.
//
// Idempotente (ON CONFLICT ... DO UPDATE): pode rodar de novo com segurança
// se o IBGE atualizar a malha, ou pra popular uma 2ª empresa (empresa_id
// entra na chave única, então cada empresa precisa do seu próprio import —
// ver trade-off documentado na ADR).
require('dotenv').config();
const { abrirContextoTenant, fecharContextoTenant, pool } = require('../src/config/db');
const { log, logWarn, logErro } = require('../src/utils/logTempo');

const EMPRESA_ID = process.env.EMPRESA_PRINCIPAL_ID;
const URL_MALHA =
  'https://servicodados.ibge.gov.br/api/v3/malhas/estados/41?formato=application/vnd.geo+json&qualidade=minima&intrarregiao=municipio';
const URL_NOMES = 'https://servicodados.ibge.gov.br/api/v1/localidades/estados/41/municipios';

async function buscarJson(url) {
  const resposta = await fetch(url);
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status} ao buscar ${url}`);
  return resposta.json();
}

async function importar() {
  if (!EMPRESA_ID) {
    logErro('❌ EMPRESA_PRINCIPAL_ID não definido no .env — abortando.');
    process.exitCode = 1;
    return;
  }

  log('📥 Baixando malha de municípios do Paraná (IBGE)...');
  const [malha, municipios] = await Promise.all([buscarJson(URL_MALHA), buscarJson(URL_NOMES)]);
  const nomePorCodigo = new Map(municipios.map(m => [String(m.id), m.nome]));
  const features = malha.features || [];
  log(`📦 ${features.length} municípios recebidos do IBGE.`);

  // Conexão única (não Pool com múltiplas conexões): set_config(..., true) é
  // local à transação, então todas as linhas precisam passar pelo mesmo
  // client pra manter app.nivel/app.empresa_id setados durante todo o import.
  const client = await abrirContextoTenant({ empresaId: EMPRESA_ID, nivel: 'ADMINISTRADOR' });
  let inseridos = 0;
  let falhas = 0;

  try {
    for (const feature of features) {
      const codigo = String(feature.properties?.codarea ?? '');
      const nome = nomePorCodigo.get(codigo);
      if (!codigo || !nome) {
        logWarn(`⚠️ Feature sem código/nome reconhecido, pulando: ${JSON.stringify(feature.properties)}`);
        falhas++;
        continue;
      }

      // SAVEPOINT por linha (mesmo padrão de copelImportService.js): uma
      // geometria inesperada (ex.: MultiPolygon num município litorâneo com
      // ilha) não pode abortar as outras ~398 linhas do lote.
      const savepoint = `municipio_${codigo}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        await client.query(
          `INSERT INTO municipios_limites (empresa_id, codigo_ibge, nome, geom)
           VALUES ($1, $2, $3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))
           ON CONFLICT (empresa_id, codigo_ibge) DO UPDATE
             SET geom = EXCLUDED.geom, nome = EXCLUDED.nome`,
          [EMPRESA_ID, codigo, nome, JSON.stringify(feature.geometry)],
        );
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        inseridos++;
      } catch (erro) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        logErro(`❌ Falha ao importar município ${codigo} (${nome || '?'}): ${erro.message}`);
        falhas++;
      }
    }

    const { rows: invalidas } = await client.query(
      `SELECT codigo_ibge, nome FROM municipios_limites WHERE empresa_id = $1 AND NOT ST_IsValid(geom)`,
      [EMPRESA_ID],
    );
    if (invalidas.length) {
      logWarn(`⚠️ ${invalidas.length} município(s) com geometria inválida: ${invalidas.map(r => r.codigo_ibge).join(', ')}`);
    }

    await fecharContextoTenant(client, true);
    log(`✅ Import concluído: ${inseridos} inseridos/atualizados, ${falhas} falhas, ${invalidas.length} geometria(s) inválida(s).`);
  } catch (erro) {
    await fecharContextoTenant(client, false);
    throw erro;
  } finally {
    await pool.end();
  }
}

importar().catch(erro => {
  logErro('❌ Erro fatal no import de limites municipais:', erro);
  process.exitCode = 1;
});
