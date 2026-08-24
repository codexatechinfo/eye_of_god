const express = require('express');
const router = express.Router();
const { resumo, opcoesFiltro, detalhe, historicoLivro } = require('../controllers/massivasController');

router.get('/resumo', resumo);
router.get('/opcoes-filtro', opcoesFiltro);
router.get('/detalhe', detalhe);
router.get('/historico-livro', historicoLivro);

module.exports = router;
