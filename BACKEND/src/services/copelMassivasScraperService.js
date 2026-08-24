const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DIR_DIAGNOSTICO = path.join(__dirname, '..', '..', 'diagnosticos');

async function salvarDiagnostico(page, motivo) {
  try {
    if (!fs.existsSync(DIR_DIAGNOSTICO)) fs.mkdirSync(DIR_DIAGNOSTICO, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(DIR_DIAGNOSTICO, `massivas_${motivo}_${timestamp}`);

    await page.screenshot({ path: `${base}.png`, fullPage: true });
    const textoVisivel = await page.evaluate(() => document.body.innerText.slice(0, 3000));
    fs.writeFileSync(`${base}.txt`, `URL: ${page.url()}\n\n${textoVisivel}`, 'utf-8');

    console.log(`[Massivas] 📸 Diagnóstico salvo: ${base}.png / .txt`);
  } catch (erroDiagnostico) {
    console.error('[Massivas] ⚠️ Não foi possível salvar diagnóstico:', erroDiagnostico.message);
  }
}

const BASE_URL = 'https://www.copel.com/lis';
const URL_LOGIN = `${BASE_URL}/Login.do?lang=pt`;
const URL_ATRIBUIDAS = `${BASE_URL}/atribuidasAction.do`;
const URL_EM_EXECUCAO = `${BASE_URL}/emExecucaoAction.do`;

const COLUNAS_MAP = {
  1: 'tipo_ss', 2: 'subtipo_os', 3: 'mr', 4: 'numero_os', 5: 'los',
  6: 'local', 7: 'livro', 8: 'etapa', 9: 'dt_rec_abertura', 10: 'dt_prev_limite',
  11: 'numero_solicitacao', 12: 'uc', 13: 'bairro', 15: 'releitura',
  16: 'qtd_digitados_nao_digitados',
};

const INDICES_COLUNAS = Object.keys(COLUNAS_MAP).map(Number).sort((a, b) => a - b);
const NOMES_COLUNAS = INDICES_COLUNAS.map(i => COLUNAS_MAP[i]);
const NOMES_COLUNAS_ATRIBUIDAS = [...NOMES_COLUNAS, 'leiturista'];

async function selecionarFiltros(page) {
  console.log('Aplicando filtros...');
  await page.selectOption("select[name='searchConcessionariaId']", { value: '2' });
  await page.waitForTimeout(2000);
  await page.selectOption("select[name='searchEmpreiteiraId']", { value: '24' });
  await page.waitForTimeout(2000);
  await page.selectOption("select[name='searchTipoTarefasId']", { value: '16' });
  await page.waitForTimeout(2000);
  console.log('Filtros aplicados');
}

async function buscarComTentativas(page, seletorEspera, maxTentativas = 3, timeoutMs = 30000) {
  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    console.log(`Buscando... (tentativa ${tentativa}/${maxTentativas})`);
    await page.locator('#botaoBuscar').click();
    try {
      await page.waitForSelector(seletorEspera, { timeout: timeoutMs });
      return true;
    } catch (erro) {
      console.log(`Nenhum resultado apareceu na tentativa ${tentativa}.`);
      await page.waitForTimeout(2000);
    }
  }
  console.log(`Sem resultados após ${maxTentativas} tentativas. Seguindo para a próxima aba.`);
  return false;
}

async function extrairPendentes(page) {
  const linhasRaw = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table#item > tbody > tr'));
    return rows.map(row =>
      Array.from(row.querySelectorAll(':scope > td')).map(td => td.innerText.trim())
    );
  });

  return linhasRaw.map(linha =>
    INDICES_COLUNAS.map(i => linha[i] ?? '')
  );
}

async function extrairPorColaborador(page) {
  const linhasRaw = await page.evaluate(() => {
    const blocos = Array.from(document.querySelectorAll('table.tableQuebraEquipe'));
    const resultado = [];

    blocos.forEach(bloco => {
      const link = bloco.querySelector('a.color');
      if (!link) return;

      let texto = link.innerText.replace(/\s+/g, ' ').trim();
      const partes = texto.split(' - ');
      let nome = partes.length >= 2 ? partes[partes.length - 2] : partes[0];
      nome = nome.replace(/^[A-Za-z0-9]+-/, '').trim();

      const tabela = bloco.querySelector('table#item');
      if (!tabela) return;

      const linhas = Array.from(tabela.querySelectorAll('tbody > tr'));
      linhas.forEach(row => {
        const cells = Array.from(row.querySelectorAll(':scope > td'));
        resultado.push({ leiturista: nome, celulas: cells.map(td => td.innerText.trim()) });
      });
    });

    return resultado;
  });

  return linhasRaw.map(({ leiturista, celulas }) => {
    const valores = INDICES_COLUNAS.map(i => celulas[i] ?? '');
    valores.push(leiturista);
    return valores;
  });
}

function paraObjetos(linhas, nomesColunas) {
  return linhas.map(linha => {
    const obj = {};
    nomesColunas.forEach((nome, i) => { obj[nome] = linha[i] || null; });
    return obj;
  });
}

async function coletarMassivas() {
  const browser = await chromium.launch({ headless: true, slowMo: 300 });
  const page = await browser.newPage();

  try {
    console.log('Abrindo site...');
    await page.goto(URL_LOGIN);
    await page.waitForTimeout(3000);

    console.log('Realizando login...');
    await page.fill("input[name='j_username']", process.env.COPEL_USERNAME.toUpperCase());
    await page.fill("input[name='j_password']", process.env.COPEL_PASSWORD);
    await page.locator("input[type='submit']").click();
    await page.waitForTimeout(8000);
    console.log('Login concluído. URL:', page.url());

    // Pendentes
    console.log('Abrindo pendentes...');
    try {
      await page.waitForSelector("a[href='pendentesAction.do']", { timeout: 15000 });
    } catch (erroLogin) {
      await salvarDiagnostico(page, 'login_falhou');
      throw erroLogin;
    }
    await page.locator("a[href='pendentesAction.do']").click();
    await page.waitForTimeout(5000);

    await selecionarFiltros(page);

    let dadosPendentes = [];
    if (await buscarComTentativas(page, 'table#item tbody tr')) {
      await page.waitForTimeout(2000);
      dadosPendentes = await extrairPendentes(page);
    }
    console.log(`${dadosPendentes.length} linhas extraídas (pendentes)`);

    // Atribuídas
    console.log('Abrindo atribuídas...');
    await page.goto(URL_ATRIBUIDAS);
    await page.waitForTimeout(3000);
    await selecionarFiltros(page);

    let dadosAtribuidas = [];
    if (await buscarComTentativas(page, 'table.tableQuebraEquipe')) {
      await page.waitForTimeout(2000);
      dadosAtribuidas = await extrairPorColaborador(page);
    }
    console.log(`${dadosAtribuidas.length} linhas extraídas (atribuídas)`);

    // Em execução
    console.log('Abrindo em execução...');
    await page.goto(URL_EM_EXECUCAO);
    await page.waitForTimeout(3000);
    await selecionarFiltros(page);

    let dadosEmExecucao = [];
    if (await buscarComTentativas(page, 'table.tableQuebraEquipe')) {
      await page.waitForTimeout(2000);
      dadosEmExecucao = await extrairPorColaborador(page);
    }
    console.log(`[Massivas] ${dadosEmExecucao.length} linhas extraídas (em execução)`);

    const agora = new Date();
    const dtImport = agora.toLocaleDateString('pt-BR');
    const hrImport = agora.toLocaleTimeString('pt-BR');
    const mesRef = `${agora.getFullYear()}/${String(agora.getMonth() + 1).padStart(2, '0')}/01`;

    const anexarImport = obj => ({ ...obj, dt_import: dtImport, hr_import: hrImport, mes_ref: mesRef });

    return {
      pendentes: paraObjetos(dadosPendentes, NOMES_COLUNAS).map(anexarImport),
      atribuidas: paraObjetos(dadosAtribuidas, NOMES_COLUNAS_ATRIBUIDAS).map(anexarImport),
      emExecucao: paraObjetos(dadosEmExecucao, NOMES_COLUNAS_ATRIBUIDAS).map(anexarImport),
    };
  } finally {
    await browser.close();
  }
}

module.exports = { coletarMassivas };