// Log append-only de ação destrutiva/sensível — hoje cobre só criação de
// usuário (ver docs/RBAC.md); estender conforme surgir ação nova que precise
// responder "quem fez isso?".
async function registrarAuditoria(db, { empresaId, usuarioId, acao, tabela, registroId, detalhe }) {
  await db.query(
    `INSERT INTO audit_log (empresa_id, usuario_id, acao, tabela, registro_id, detalhe)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [empresaId ?? null, usuarioId ?? null, acao, tabela, registroId ?? null, detalhe ? JSON.stringify(detalhe) : null],
  );
}

module.exports = { registrarAuditoria };
