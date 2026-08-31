const express = require('express');
const router = express.Router();
const { limitesPorPontos } = require('../controllers/municipiosController');

router.post('/limites-por-pontos', limitesPorPontos);

module.exports = router;
