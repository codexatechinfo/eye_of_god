const express = require('express');
const router = express.Router();
const { executarColeta } = require('../controllers/coletaMassivasController');

router.post('/executar', executarColeta);

module.exports = router;