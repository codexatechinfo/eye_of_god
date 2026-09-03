const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const ExcelJS = require('exceljs');
const { log } = require('../utils/logTempo');

// Porta o script Python fornecido pelo usuário (Playwright + csv + psycopg2,
// já validado ao vivo contra o portal Copel) — mesmos seletores, mesma
// lógica de navegação/normalização, agora dentro do job de Massivas
// (copelMassivasScraperService.js chama extrairControleEmpreiteiras usando a
// MESMA `page` já logada, sem login próprio aqui — ver ADR sobre essa
// integração). Alvo passou de `control_empreiteiras` (removida, ver ADR 0004
// Adendo 1) pra `base_dados_leitura` (ADR 0024) — mesmo cabeçalho de 23
// colunas, ordem idêntica.

const HEADER_PADRAO = [
  'concessionaria', 'empreiteira', 'equipe', 'nome_do_usuario', 'mes_ref_livro',
  'data_da_leitura', 'hora_da_leitura', 'unidade_consumidora', 'codigo_da_localidade',
  'descricao_da_localidade', 'tipo_de_localizacao_da_uc', 'etapa', 'livro',
  'status_releitura', 'equipamento', 'especificacao', 'mensagem', 'mensagem_auxiliar',
  'observacao_de_campo', 'status_foto', 'faturamento_em_campo',
  'status_impressao_do_comunicado', 'forma_de_entrega',
];

// Ordem importa (primeiro match vence, mesma regra do script original) —
// mesma ordem de chaves do dict Python.
const TERMOS_COLUNAS = {
  concessionaria: ['concess'],
  empreiteira: ['empreit'],
  equipe: ['equipe'],
  nome_do_usuario: ['nome'],
  mes_ref_livro: ['mes ref', 'mes_ref'],
  data_da_leitura: ['data'],
  hora_da_leitura: ['hora'],
  unidade_consumidora: ['unidade'],
  codigo_da_localidade: ['codigo'],
  descricao_da_localidade: ['descr'],
  tipo_de_localizacao_da_uc: ['tipo'],
  etapa: ['etapa'],
  livro: ['livro'],
  status_releitura: ['releitura', 'rele'],
  equipamento: ['equipamento'],
  especificacao: ['espec'],
  mensagem_auxiliar: ['mensagem auxiliar', 'mensagem_auxiliar', 'msg aux', 'mensagemaux'],
  mensagem: ['mensagem', 'msg'],
  observacao_de_campo: ['observ'],
  status_foto: ['foto'],
  faturamento_em_campo: ['fatur'],
  status_impressao_do_comunicado: ['impressao', 'comunicado'],
  forma_de_entrega: ['forma', 'entrega'],
};

const EXCLUSOES = {
  equipe: ['equipamento'],
  mensagem: ['auxiliar', 'aux'],
  livro: ['releitura', 'ref', 'mes'],
};

const MESES = {
  janeiro: 1, fevereiro: 2, março: 3, marco: 3, abril: 4,
  maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9,
  outubro: 10, novembro: 11, dezembro: 12,
};

const NOMES_MESES = {
  1: 'Janeiro', 2: 'Fevereiro', 3: 'Março', 4: 'Abril', 5: 'Maio', 6: 'Junho',
  7: 'Julho', 8: 'Agosto', 9: 'Setembro', 10: 'Outubro', 11: 'Novembro', 12: 'Dezembro',
};

function normalizarTxt(txt) {
  return String(txt ?? '')
    .toLowerCase()
    .trim()
    .replace(/﻿/g, '')
    .replace(/ç/g, 'c')
    .replace(/[ãáàâ]/g, 'a')
    .replace(/[éê]/g, 'e')
    .replace(/í/g, 'i')
    .replace(/[óôõ]/g, 'o')
    .replace(/ú/g, 'u');
}

// Formata pra "DD/MM/YYYY" — DIVERGE de propósito do script original (que
// formatava "YYYY-MM-DD", certo pra control_empreiteiras, errado pra
// base_dados_leitura). Todo o resto do schema, e especificamente
// data_da_leitura/hora_da_leitura desta tabela, é validado contra
// `^\d{2}\/\d{2}\/\d{4}$` em monitoramentoService.js/
// atividadeColaboradoresService.js (ADR 0025) — usar ISO aqui quebraria
// silenciosamente toda consulta que junta com base_dados_leitura.
function formatarDataBr(valorBruto) {
  const valor = String(valorBruto ?? '').trim();
  if (!valor) return '';

  let m = /^(\d{2})\/(\d{4})$/.exec(valor); // "MM/YYYY" (mês de referência, sem dia)
  if (m) return `01/${m[1]}/${m[2]}`;

  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(valor); // já "DD/MM/YYYY"
  if (m) return valor;

  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor); // "YYYY-MM-DD"
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;

  m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(valor); // "DD-MM-YYYY"
  if (m) return `${m[1]}/${m[2]}/${m[3]}`;

  m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(valor); // "YYYY/MM/DD"
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;

  m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(valor); // "DD/MM/YY"
  if (m) {
    const ano = Number(m[3]) <= 69 ? `20${m[3]}` : `19${m[3]}`;
    return `${m[1]}/${m[2]}/${ano}`;
  }

  m = /^(\d{4})(\d{2})(\d{2})$/.exec(valor); // "YYYYMMDD"
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;

  return valor; // formato desconhecido — devolve como veio, não inventa data
}

function detectarColunas(header) {
  const mapa = {};
  header.forEach(col => {
    const c = normalizarTxt(col);
    for (const [campo, termos] of Object.entries(TERMOS_COLUNAS)) {
      if (campo in mapa) continue;
      const exclusoes = EXCLUSOES[campo] || [];
      if (exclusoes.some(t => c.includes(t))) continue;
      if (termos.some(t => c.includes(t))) mapa[campo] = header.indexOf(col);
    }
  });
  return mapa;
}

function linhaEmBranco(linha) {
  return linha.every(c => String(c ?? '').trim() === '');
}

function linhaValidaNegocio(linha, mapa, concessionaria, empreiteira) {
  const idxConc = mapa.concessionaria;
  const idxEmp = mapa.empreiteira;
  if (idxConc === undefined || idxEmp === undefined) return false;
  if (idxConc >= linha.length || idxEmp >= linha.length) return false;
  return (
    String(linha[idxConc] ?? '').trim().toUpperCase() === concessionaria.toUpperCase() &&
    String(linha[idxEmp] ?? '').trim().toUpperCase() === empreiteira.toUpperCase()
  );
}

// Recebe a planilha crua (array de arrays, linha 0 = cabeçalho) já
// decodificada, devolve só as linhas de concessionaria/empreiteira
// combinando, já no formato de colunas de base_dados_leitura.
function normalizarLinhas(linhasCru, concessionaria, empreiteira) {
  if (!linhasCru.length) return [];
  const header = linhasCru[0];
  const mapa = detectarColunas(header);

  const registros = [];
  for (let i = 1; i < linhasCru.length; i++) {
    let linha = linhasCru[i].map(c => String(c ?? '').trim());
    if (linhaEmBranco(linha)) continue;
    if (linha.length < header.length) {
      linha = [...linha, ...Array(header.length - linha.length).fill('')];
    } else if (linha.length > header.length) {
      linha = linha.slice(0, header.length);
    }
    if (!linhaValidaNegocio(linha, mapa, concessionaria, empreiteira)) continue;

    const registro = {};
    for (const col of HEADER_PADRAO) {
      const idx = mapa[col];
      let valor = idx !== undefined ? linha[idx] : '';
      if ((col === 'mes_ref_livro' || col === 'data_da_leitura') && valor) {
        valor = formatarDataBr(valor);
      } else if (col === 'etapa' && valor) {
        valor = valor.padStart(2, '0');
      } else if (col === 'livro' && valor) {
        valor = (valor.replace(/^0+/, '') || '0').padStart(5, '0');
      }
      registro[col] = valor || null;
    }
    registros.push(registro);
  }
  return registros;
}

// Lê o .csv exportado (delimitador ';', igual ao script original) com
// fallback de encoding (utf-8 -> latin1, mesma cascata do script Python —
// latin1/cp1252 são idênticos na faixa de acentuação usada aqui, então não
// precisa de dependência nova). `map: valor => valor` evita a conversão
// automática de número/data do ExcelJS, que perderia zero à esquerda de
// livro/etapa e converteria data pra Date sem controle nosso.
async function lerCsvComEncodingDetectado(caminho) {
  const buffer = fs.readFileSync(caminho);
  let texto = buffer.toString('utf8');
  if (texto.includes('�')) {
    texto = buffer.toString('latin1');
  }

  const stream = new Readable();
  stream.push(texto, 'utf8');
  stream.push(null);

  const workbook = new ExcelJS.Workbook();
  const worksheet = await workbook.csv.read(stream, {
    parserOptions: { delimiter: ';' },
    map: valor => valor,
  });

  const linhas = [];
  worksheet.eachRow({ includeEmpty: false }, row => {
    // row.values é 1-indexed (values[0] fica undefined) — normaliza pra
    // array 0-indexed de string.
    linhas.push(row.values.slice(1).map(v => (v === null || v === undefined ? '' : String(v))));
  });
  return linhas;
}

function parseMesAno(texto) {
  const [mesTxt, anoTxt] = texto.trim().toLowerCase().split(',');
  return { ano: Number((anoTxt || '').trim()), mes: MESES[(mesTxt || '').trim()] };
}

// Widget de calendário estilo Duetto Datepicker — navega mês a mês via
// botões '‹'/'›' até achar o título "Mês, Ano" desejado. Mesmos seletores
// do script Python (`td.title`, `td.button.nav`).
async function ajustarCalendarioParaMes(page, mesDesejadoStr) {
  const { ano: anoAlvo, mes: mesAlvo } = parseMesAno(mesDesejadoStr);
  for (let i = 0; i < 48; i++) {
    const titulo = (await page.locator('td.title:visible').first().innerText()).trim();
    const { ano: anoAtual, mes: mesAtual } = parseMesAno(titulo);
    if (anoAtual === anoAlvo && mesAtual === mesAlvo) return;
    if (anoAtual < anoAlvo || (anoAtual === anoAlvo && mesAtual < mesAlvo)) {
      await page.locator('td.button.nav:visible', { hasText: '›' }).first().click();
    } else {
      await page.locator('td.button.nav:visible', { hasText: '‹' }).first().click();
    }
    await page.waitForTimeout(400);
  }
  throw new Error(`Não encontrei o mês desejado: ${mesDesejadoStr}`);
}

async function clicarDiaVisivel(page, dia) {
  const dias = page.locator('td.day:visible');
  const total = await dias.count();
  for (let i = 0; i < total; i++) {
    const el = dias.nth(i);
    if ((await el.innerText()).trim() !== String(dia)) continue;
    const classe = ((await el.getAttribute('class')) || '').toLowerCase();
    if (classe.includes('other') || classe.includes('disabled') || classe.includes('empty')) continue;
    await el.dblclick();
    return;
  }
  throw new Error(`Não encontrei o dia ${dia} no calendário visível.`);
}

async function selecionarDataNoCalendario(page, botaoSeletor, mesDesejadoStr, dia) {
  await page.waitForSelector(botaoSeletor, { timeout: 15000 });
  await page.locator(botaoSeletor).click();
  await page.waitForTimeout(400);
  await ajustarCalendarioParaMes(page, mesDesejadoStr);
  await clicarDiaVisivel(page, dia);
  await page.waitForTimeout(600);
}

async function selecionarPeriodo(page, dataAlvo) {
  const mesRefStr = `${NOMES_MESES[dataAlvo.getMonth() + 1]}, ${dataAlvo.getFullYear()}`;
  await selecionarDataNoCalendario(page, '#btnmesReferencia', mesRefStr, 1);
  await selecionarDataNoCalendario(page, '#btndataInicio', mesRefStr, dataAlvo.getDate());
  await selecionarDataNoCalendario(page, '#btndataFim', mesRefStr, dataAlvo.getDate());
}

async function exportarRelatorio(page, destino) {
  const botao = page.locator('button', { hasText: 'EXPORTAR RELATÓRIO' }).first();
  await botao.waitFor({ state: 'visible', timeout: 15000 });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 180000 }),
    botao.click({ noWaitAfter: true, timeout: 15000 }),
  ]);
  await download.saveAs(destino);
  return destino;
}

// Não faz login (reaproveita a sessão já aberta por coletarMassivas — mesma
// conta Copel, ver copelSessaoLock.js). Uma chamada = uma data (`dataAlvo`,
// objeto `Date`); quem chama decide se roda pra ontem, hoje, ou ambos.
async function extrairControleEmpreiteiras(page, dataAlvo, { concessionaria, empreiteira }) {
  const dataFmt = `${String(dataAlvo.getDate()).padStart(2, '0')}/${String(dataAlvo.getMonth() + 1).padStart(2, '0')}/${dataAlvo.getFullYear()}`;
  log(`[Controle Empreiteiras] 🔎 Acessando relatório pra ${dataFmt}...`);

  await page.waitForSelector("a[href='/lis/relatorioControleEmpreiteirasAction.do']", { timeout: 15000 });
  await page.locator("a[href='/lis/relatorioControleEmpreiteirasAction.do']").click();
  await page.waitForTimeout(1000);

  await page.waitForSelector("select[name='searchConcessionariaId']", { timeout: 15000 });
  await page.locator("select[name='searchConcessionariaId']").selectOption({ label: concessionaria });
  await page.waitForTimeout(500);

  await page.waitForSelector("select[name='searchEmpreiteiraId']", { timeout: 15000 });
  await page.locator("select[name='searchEmpreiteiraId']").selectOption({ label: empreiteira });
  await page.waitForTimeout(500);

  await selecionarPeriodo(page, dataAlvo);
  log(`[Controle Empreiteiras] 📅 Período selecionado: ${dataFmt}`);

  const destino = path.join(os.tmpdir(), `controle_empreiteiras_${dataAlvo.getTime()}_${Date.now()}.csv`);
  await exportarRelatorio(page, destino);
  log(`[Controle Empreiteiras] 📥 Exportado (${dataFmt}).`);

  try {
    const linhasCru = await lerCsvComEncodingDetectado(destino);
    const registros = normalizarLinhas(linhasCru, concessionaria, empreiteira);
    log(`[Controle Empreiteiras] ✅ ${registros.length} linha(s) válida(s) pra ${dataFmt}.`);
    return registros;
  } finally {
    fs.unlink(destino, () => {}); // best-effort — não bloqueia o fluxo se falhar
  }
}

module.exports = {
  extrairControleEmpreiteiras,
  // Expostos pra teste isolado sem navegador (normalização/formatação são
  // funções puras) — ver BACKEND/test/.
  formatarDataBr,
  normalizarLinhas,
  detectarColunas,
};
