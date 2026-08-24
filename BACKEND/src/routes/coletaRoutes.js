const express = require('express');
const router = express.Router();
const { executarColeta, status } = require('../controllers/coletaController');

router.post('/executar', executarColeta);
router.get('/status', status);

module.exports = router;
