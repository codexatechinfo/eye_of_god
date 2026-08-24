const express = require('express');
const router = express.Router();
const { criar, atualizarMeuPerfil } = require('../controllers/usuariosController');
const { exigirNivelMinimo } = require('../middlewares/authMiddleware');

router.post('/', exigirNivelMinimo('ADMINISTRADOR'), criar);
router.patch('/me', atualizarMeuPerfil);

module.exports = router;
