const express = require('express');
const cors = require('cors');
require('dotenv').config();
const coletaRoutes = require('./routes/coletaRoutes');
const { iniciarJobColeta } = require('./jobs/coletaJob');
const coletaMassivasRoutes = require('./routes/coletaMassivasRoutes');
const { iniciarJobMassivas } = require('./jobs/coletaMassivasJob');
const authRoutes = require('./routes/authRoutes');
const usuariosRoutes = require('./routes/usuariosRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const colaboradoresRoutes = require('./routes/colaboradoresRoutes');
const massivasRoutes = require('./routes/massivasRoutes');
const importacaoRoutes = require('./routes/importacaoRoutes');
const empresasRoutes = require('./routes/empresasRoutes');
const { autenticarToken, anexarContextoTenant } = require('./middlewares/authMiddleware');

const app = express();

app.use(cors());
app.use(express.json());
app.use('/auth', authRoutes);

app.get('/', (req, res) => {
  res.json({ message: 'API Olho de Deus rodando 👁️' });
});

// Toda rota de negócio daqui pra baixo exige token válido e abre o contexto
// de tenant (empresa_id/nível) que o RLS do Postgres usa — ver
// docs/adr/0003-rbac-multi-tenant.md.
app.use(autenticarToken, anexarContextoTenant);

app.use('/usuarios', usuariosRoutes);
app.use('/coleta', coletaRoutes);
app.use('/coleta/massivas', coletaMassivasRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/colaboradores', colaboradoresRoutes);
app.use('/massivas', massivasRoutes);
app.use('/importacao', importacaoRoutes);
app.use('/empresas', empresasRoutes);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  iniciarJobColeta();
  iniciarJobMassivas();
});
