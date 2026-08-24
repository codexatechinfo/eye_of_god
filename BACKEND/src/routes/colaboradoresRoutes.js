const express = require('express');
const router = express.Router();
const { ativos, opcoesFiltro, atividadeHoje } = require('../controllers/colaboradoresController');

router.get('/ativos', ativos);
router.get('/opcoes-filtro', opcoesFiltro);
router.get('/atividade-hoje', atividadeHoje);

module.exports = router;
