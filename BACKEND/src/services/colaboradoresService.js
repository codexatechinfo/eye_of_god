const REGIONAL_NORMALIZADA = `regexp_replace(regexp_replace(base, '^COPEL\\s+', ''), '\\s+(LEITURA|ADM)$', '')`;

// Mesmo padrão de colaboradoresController.js#hojeBr / atividadeColaboradoresService.js
// — data local do Brasil (UTC-3), não CURRENT_DATE do Postgres. O servidor
// Postgres deste projeto roda em UTC (confirmado ao vivo, `SHOW timezone` =
// UTC — ver rosterUcsAcompanhamentoService.js#hojeLocal), então CURRENT_DATE
// vira o dia seguinte 3h antes da meia-noite local (~21h de Brasília):
// mesmo situacao/volta_afastamento sendo datas "puras" de planilha (RH), é
// CURRENT_DATE (lado direito da comparação) que fica adiantado nessa janela
// — um afastamento que começa amanhã passaria a contar como já iniciado, e
// um colaborador que só volta hoje sumiria da condição de afastado ~3h cedo
// demais.
function hojeBr() {
  const agora = new Date();
  const dia = String(agora.getDate()).padStart(2, '0');
  const mes = String(agora.getMonth() + 1).padStart(2, '0');
  return `${dia}/${mes}/${agora.getFullYear()}`;
}

// Colaborador afastado (situacao = "A2 - DD/MM/YYYY") continua entrando na
// lista enquanto o afastamento vale HOJE — senão ele nunca aparece na tela
// pra mostrar o indicador de "ausência justificada" (usuário pediu pra ver
// isso na lista do Trilho, ver atividadeColaboradoresService.js). Mesma
// regra de "contempla hoje" usada lá: data de início já passou, e
// (retorno indeterminado OU ainda não chegou a data de retorno).
// `indiceParam` é a posição ($N) de dataBr ("DD/MM/YYYY") na query.
function condicaoAfastadoHoje(indiceParam) {
  return `(
    situacao ~ '^A2 - \\d{2}/\\d{2}/\\d{4}$'
    AND to_date(substring(situacao from '\\d{2}/\\d{2}/\\d{4}'), 'DD/MM/YYYY') <= to_date($${indiceParam}, 'DD/MM/YYYY')
    AND (
      volta_afastamento = 'INDETERMINADO'
      OR (volta_afastamento ~ '^\\d{4}-\\d{2}-\\d{2}$' AND volta_afastamento::date > to_date($${indiceParam}, 'DD/MM/YYYY'))
    )
  )`;
}

async function listarAtivos(db, { colaborador, cargo, regional } = {}) {
  const dataBr = hojeBr();
  const parametros = [dataBr];
  const condicoes = [`(situacao = 'ATIVO' OR ${condicaoAfastadoHoje(1)})`];

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
  const dataBr = hojeBr();
  const [cargos, regionais] = await Promise.all([
    db.query(
      `SELECT DISTINCT cargo FROM ativos_inativos WHERE (situacao = 'ATIVO' OR ${condicaoAfastadoHoje(1)}) AND cargo IS NOT NULL ORDER BY cargo`,
      [dataBr],
    ),
    db.query(
      `
      SELECT DISTINCT ${REGIONAL_NORMALIZADA} AS regional
      FROM ativos_inativos
      WHERE (situacao = 'ATIVO' OR ${condicaoAfastadoHoje(1)}) AND base IS NOT NULL
      ORDER BY regional
    `,
      [dataBr],
    ),
  ]);

  return {
    cargos: cargos.rows.map(c => c.cargo),
    regionais: regionais.rows.map(r => r.regional),
  };
}

module.exports = { listarAtivos, listarOpcoesFiltro };
