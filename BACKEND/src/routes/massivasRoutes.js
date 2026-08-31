const express = require('express');
const router = express.Router();
const { resumo, opcoesFiltro, detalhe, historicoLivro, ucsLivro, regimeSucessivo } = require('../controllers/massivasController');

router.get('/resumo', resumo);
router.get('/opcoes-filtro', opcoesFiltro);
router.get('/detalhe', detalhe);
router.get('/historico-livro', historicoLivro);
router.get('/livro-ucs', ucsLivro);
router.get('/uc-regime', regimeSucessivo);

module.exports = router;
