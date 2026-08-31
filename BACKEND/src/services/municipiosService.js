// Só os municípios que pelo menos um ponto encosta (ST_Contains) — não a
// malha inteira do estado. `pontos`: array de [latitude, longitude]. Usa
// jsonb_array_elements em vez de montar uma query com N parâmetros: um
// livro pode ter dezenas de UCs, e o número de pontos varia por livro.
async function listarLimitesPorPontos(db, pontos) {
  if (!pontos.length) return [];

  // EXISTS em vez de JOIN + DISTINCT: um JOIN geraria uma linha por
  // (município, ponto) combinando dentro dele, e Postgres não sabe comparar
  // igualdade em colunas "json" (só "jsonb") pra deduplicar com DISTINCT
  // depois — EXISTS já devolve no máximo uma linha por município de saída,
  // sem precisar deduplicar nada.
  const sql = `
    WITH pontos AS (
      SELECT ST_SetSRID(ST_MakePoint((elem->>1)::double precision, (elem->>0)::double precision), 4326) AS geom
      FROM jsonb_array_elements($1::jsonb) AS elem
    )
    SELECT ml.codigo_ibge, ml.nome, ST_AsGeoJSON(ml.geom)::json AS geometry
    FROM municipios_limites ml
    WHERE EXISTS (SELECT 1 FROM pontos p WHERE ST_Contains(ml.geom, p.geom))
    ORDER BY ml.nome
  `;
  const { rows } = await db.query(sql, [JSON.stringify(pontos)]);
  return rows;
}

module.exports = { listarLimitesPorPontos };
