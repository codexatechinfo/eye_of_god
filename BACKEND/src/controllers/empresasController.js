// Listagem simples — a RLS de `empresas` já faz o filtro certo sozinha:
// ROOT vê todas, os demais só a própria (ver docs/adr/0003-rbac-multi-tenant.md).
// Existe pra alimentar o seletor de empresa que ROOT precisa em ações que
// não têm empresa própria pra assumir por padrão (ex.: importar planilha).
async function listar(req, res) {
  try {
    const { rows } = await req.db.query('SELECT id, nome, ativa FROM empresas ORDER BY nome');
    res.json({ sucesso: true, empresas: rows });
  } catch (erro) {
    console.error('❌ Erro ao listar empresas:', erro);
    res.status(500).json({ sucesso: false, erro: erro.message });
  }
}

module.exports = { listar };
