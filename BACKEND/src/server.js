const express = require('express');
const cors = require('cors');
require('dotenv').config();
const coletaRoutes = require('./routes/coletaRoutes');
const { iniciarJobColeta } = require('./jobs/coletaJob');
const coletaMassivasRoutes = require('./routes/coletaMassivasRoutes');
const { iniciarJobMassivas } = require('./jobs/coletaMassivasJob');
const authRoutes = require('./routes/authRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const colaboradoresRoutes = require('./routes/colaboradoresRoutes');
const massivasRoutes = require('./routes/massivasRoutes');

const app = express();

app.use(cors());
app.use(express.json());
app.use('/auth', authRoutes);

app.get('/', (req, res) => {
  res.json({ message: 'API Olho de Deus rodando 👁️' });
});

app.use('/coleta', coletaRoutes);
app.use('/coleta/massivas', coletaMassivasRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/colaboradores', colaboradoresRoutes);
app.use('/massivas', massivasRoutes);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  iniciarJobColeta();
  iniciarJobMassivas();
});