const express = require('express');
const router = express.Router();
const { limites } = require('../controllers/municipiosController');

router.get('/limites', limites);

module.exports = router;
