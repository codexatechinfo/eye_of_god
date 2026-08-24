const express = require('express');
const multer = require('multer');
const router = express.Router();
const { tabelasDisponiveis, importar } = require('../controllers/importacaoController');
const { exigirNivelMinimo } = require('../middlewares/authMiddleware');

const TIPOS_ACEITOS = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter(req, file, cb) {
    if (!TIPOS_ACEITOS.has(file.mimetype) && !file.originalname.toLowerCase().endsWith('.xlsx')) {
      return cb(new Error('Só arquivo .xlsx é aceito.'));
    }
    cb(null, true);
  },
});

router.use(exigirNivelMinimo('ADMINISTRADOR'));

router.get('/', tabelasDisponiveis);
router.post('/:tabela', upload.single('arquivo'), importar);

// multer (tamanho/tipo de arquivo) rejeita antes do controller — sem isso
// cairia no handler de erro padrão do Express (página HTML, não JSON).
router.use((erro, req, res, next) => {
  if (erro instanceof multer.MulterError || erro) {
    return res.status(400).json({ sucesso: false, erro: erro.message });
  }
  next(erro);
});

module.exports = router;
