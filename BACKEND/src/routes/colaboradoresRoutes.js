const express = require('express');
const router = express.Router();
const { ativos, opcoesFiltro, atividadeHoje, localizacoes } = require('../controllers/colaboradoresController');

router.get('/ativos', ativos);
router.get('/opcoes-filtro', opcoesFiltro);
router.get('/atividade-hoje', atividadeHoje);
router.get('/localizacoes', localizacoes);

module.exports = router;
