const express = require('express');
const router = express.Router();
const { leituraUrbana } = require('../controllers/dashboardController');

router.get('/leitura-urbana', leituraUrbana);

module.exports = router;
