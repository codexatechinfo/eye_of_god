async function listarLimites(db) {
  const sql = `
    SELECT codigo_ibge, nome, ST_AsGeoJSON(geom)::json AS geometry
    FROM municipios_limites
    ORDER BY nome
  `;
  const { rows } = await db.query(sql);
  return rows;
}

module.exports = { listarLimites };
