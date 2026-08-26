const REGIONAL_NORMALIZADA = `regexp_replace(regexp_replace(base, '^COPEL\\s+', ''), '\\s+(LEITURA|ADM)$', '')`;

// Colaborador afastado (situacao = "A2 - DD/MM/YYYY") continua entrando na
// lista enquanto o afastamento vale HOJE — senão ele nunca aparece na tela
// pra mostrar o indicador de "ausência justificada" (usuário pediu pra ver
// isso na lista do Trilho, ver atividadeColaboradoresService.js). Mesma
// regra de "contempla hoje" usada lá: data de início já passou, e
// (retorno indeterminado OU ainda não chegou a data de retorno).
const CONDICAO_AFASTADO_HOJE = `(
  situacao ~ '^A2 - \\d{2}/\\d{2}/\\d{4}$'
  AND to_date(substring(situacao from '\\d{2}/\\d{2}/\\d{4}'), 'DD/MM/YYYY') <= CURRENT_DATE
  AND (
    volta_afastamento = 'INDETERMINADO'
    OR (volta_afastamento ~ '^\\d{4}-\\d{2}-\\d{2}$' AND volta_afastamento::date > CURRENT_DATE)
  )
)`;

async function listarAtivos(db, { colaborador, cargo, regional } = {}) {
  const condicoes = [`(situacao = 'ATIVO' OR ${CONDICAO_AFASTADO_HOJE})`];
  const parametros = [];

  if (colaborador) {
    parametros.push(`%${colaborador}%`);
    condicoes.push(`colaborador ILIKE $${parametros.length}`);
  }
  if (cargo) {
    parametros.push(cargo);
    condicoes.push(`cargo = $${parametros.length}`);
  }
  if (regional) {
    parametros.push(regional);
    condicoes.push(`${REGIONAL_NORMALIZADA} = $${parametros.length}`);
  }

  const sql = `
    SELECT matricula, colaborador, cargo, base, admissao, data_atualizacao
    FROM ativos_inativos
    WHERE ${condicoes.join(' AND ')}
    ORDER BY colaborador
  `;

  const { rows } = await db.query(sql, parametros);
  return rows;
}

async function listarOpcoesFiltro(db) {
  const [cargos, regionais] = await Promise.all([
    db.query(`SELECT DISTINCT cargo FROM ativos_inativos WHERE (situacao = 'ATIVO' OR ${CONDICAO_AFASTADO_HOJE}) AND cargo IS NOT NULL ORDER BY cargo`),
    db.query(`
      SELECT DISTINCT ${REGIONAL_NORMALIZADA} AS regional
      FROM ativos_inativos
      WHERE (situacao = 'ATIVO' OR ${CONDICAO_AFASTADO_HOJE}) AND base IS NOT NULL
      ORDER BY regional
    `),
  ]);

  return {
    cargos: cargos.rows.map(c => c.cargo),
    regionais: regionais.rows.map(r => r.regional),
  };
}

module.exports = { listarAtivos, listarOpcoesFiltro };
