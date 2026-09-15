const express = require('express');
const router = express.Router();
const {
  ativos,
  opcoesFiltro,
  atividadeHoje,
  localizacoes,
  scalefusion,
  segsatPosicoes,
  gpsHistorico,
  jornada,
  enviarMensagem,
} = require('../controllers/colaboradoresController');

router.get('/ativos', ativos);
router.get('/opcoes-filtro', opcoesFiltro);
router.get('/atividade-hoje', atividadeHoje);
router.get('/localizacoes', localizacoes);
router.get('/scalefusion', scalefusion);
router.get('/segsat', segsatPosicoes);
router.get('/gps-historico', gpsHistorico);
router.get('/jornada', jornada);
router.post('/mensagem', enviarMensagem);

module.exports = router;
