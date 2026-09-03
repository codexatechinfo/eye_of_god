const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { extrairControleEmpreiteiras } = require('./copelControleEmpreiteirasScraperService');
const { log, logErro } = require('../utils/logTempo');

// Mesmos valores default do script Python fornecido pelo usuário — sem
// exigir editar .env pra funcionar já. COPEL_CONCESSIONARIA/COPEL_EMPREITEIRA
// permitem sobrescrever por ambiente se um dia precisar.
const CONTROLE_EMPREITEIRAS_CONCESSIONARIA = process.env.COPEL_CONCESSIONARIA || 'COMPANHIA PARANAENSE DE ENERGIA';
const CONTROLE_EMPREITEIRAS_EMPREITEIRA = process.env.COPEL_EMPREITEIRA || 'F IMM BRASIL LTDA';

const DIR_DIAGNOSTICO = path.join(__dirname, '..', '..', 'diagnosticos');

async function salvarDiagnostico(page, motivo) {
  try {
    if (!fs.existsSync(DIR_DIAGNOSTICO)) fs.mkdirSync(DIR_DIAGNOSTICO, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(DIR_DIAGNOSTICO, `massivas_${motivo}_${timestamp}`);

    await page.screenshot({ path: `${base}.png`, fullPage: true });
    const textoVisivel = await page.evaluate(() => document.body.innerText.slice(0, 3000));
    fs.writeFileSync(`${base}.txt`, `URL: ${page.url()}\n\n${textoVisivel}`, 'utf-8');

    log(`[Massivas] 📸 Diagnóstico salvo: ${base}.png / .txt`);
  } catch (erroDiagnostico) {
    logErro('[Massivas] ⚠️ Não foi possível salvar diagnóstico:', erroDiagnostico.message);
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

// Cada select depende do anterior (AJAX popula as <option> do próximo campo
// só depois da escolha atual) — espera a option que vamos escolher existir de
// verdade no DOM, em vez de um tempo fixo que ou sobra (formulário já pronto)
// ou falta (AJAX mais lento que o normal num dia de rede ruim).
async function aguardarOpcao(page, seletorSelect, valor, timeoutMs = 15000) {
  await page.waitForFunction(
    ({ seletor, valor: v }) => {
      const select = document.querySelector(seletor);
      if (!select) return false;
      return Array.from(select.options).some(o => o.value === v);
    },
    { seletor: seletorSelect, valor },
    { timeout: timeoutMs },
  );
}

async function selecionarFiltros(page) {
  log('[Massivas] Aplicando filtros...');
  await page.selectOption("select[name='searchConcessionariaId']", { value: '2' });
  await aguardarOpcao(page, "select[name='searchEmpreiteiraId']", '24');
  await page.selectOption("select[name='searchEmpreiteiraId']", { value: '24' });
  await aguardarOpcao(page, "select[name='searchTipoTarefasId']", '16');
  await page.selectOption("select[name='searchTipoTarefasId']", { value: '16' });
  log('[Massivas] Filtros aplicados');
}

// Tabela pode popular as linhas de forma assíncrona depois do elemento
// aparecer — poll na contagem até estabilizar (2 leituras iguais seguidas),
// em vez de um tempo fixo depois do resultado já visível.
async function aguardarEstabilizar(page, seletorLinhas, { intervaloMs = 500, timeoutMs = 15000 } = {}) {
  const inicio = Date.now();
  let anterior = -1;
  let estavel = 0;
  while (Date.now() - inicio < timeoutMs) {
    const atual = await page.locator(seletorLinhas).count();
    if (atual === anterior) {
      estavel++;
      if (estavel >= 2) return atual;
    } else {
      estavel = 0;
    }
    anterior = atual;
    await page.waitForTimeout(intervaloMs);
  }
  return anterior;
}

async function buscarComTentativas(page, seletorEspera, maxTentativas = 3, timeoutMs = 30000) {
  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    log(`[Massivas] Buscando... (tentativa ${tentativa}/${maxTentativas})`);
    await page.locator('#botaoBuscar').click();
    try {
      await page.waitForSelector(seletorEspera, { timeout: timeoutMs });
      return true;
    } catch (erro) {
      log(`[Massivas] Nenhum resultado apareceu na tentativa ${tentativa}.`);
      // Pequena folga ANTES de tentar buscar de novo (não é espera de
      // carregamento — é intervalo entre retries).
      await page.waitForTimeout(2000);
    }
  }
  log(`[Massivas] Sem resultados após ${maxTentativas} tentativas. Seguindo para a próxima aba.`);
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

// page.fill()/click() do Playwright já auto-esperam o elemento existir e
// ficar acionável — não precisa de tempo fixo antes deles. Isso só espera o
// formulário de filtros (select de concessionária) estar pronto depois de
// entrar numa aba nova (pendentes/atribuídas/em execução).
async function aguardarFormularioFiltros(page) {
  await page.waitForSelector("select[name='searchConcessionariaId']", { state: 'visible', timeout: 20000 });
}

async function coletarMassivas() {
  const browser = await chromium.launch({ headless: true, slowMo: 300 });
  const page = await browser.newPage();

  try {
    log('[Massivas] Abrindo site...');
    await page.goto(URL_LOGIN);

    log('[Massivas] Realizando login...');
    // fill() já espera o campo existir e ficar acionável — sem necessidade
    // de tempo fixo depois do goto.
    await page.fill("input[name='j_username']", process.env.COPEL_USERNAME.toUpperCase());
    await page.fill("input[name='j_password']", process.env.COPEL_PASSWORD);
    await page.locator("input[type='submit']").click();

    // Senha perto de expirar cai numa tela intermediária pedindo pra trocar
    // agora — "Adiar alteração" segue o login normalmente sem trocar nada
    // (mesmo tratamento do Adendo no scraper de Acompanhamento). Só espera
    // 5s por esse botão, não atrasa quem não cai nessa tela.
    try {
      await page.locator("input[type='button'][value='Adiar alteração']").click({ timeout: 5000 });
      log('[Massivas] Senha perto de expirar — adiando alteração pra manter o login.');
    } catch {
      // não caiu nessa tela, segue o fluxo normal
    }

    // Pendentes
    log('[Massivas] Abrindo pendentes...');
    try {
      // Esse waitForSelector já É a espera real de "login concluído" — o
      // waitForTimeout(8000) fixo que existia antes dele só atrasava sem
      // necessidade (mesma causa raiz corrigida no Adendo 9 do scraper de
      // Acompanhamento).
      await page.waitForSelector("a[href='pendentesAction.do']", { timeout: 30000 });
    } catch (erroLogin) {
      await salvarDiagnostico(page, 'login_falhou');
      throw erroLogin;
    }
    log('[Massivas] Login concluído. URL:', page.url());
    await page.locator("a[href='pendentesAction.do']").click();
    await aguardarFormularioFiltros(page);

    await selecionarFiltros(page);

    let dadosPendentes = [];
    if (await buscarComTentativas(page, 'table#item tbody tr')) {
      await aguardarEstabilizar(page, 'table#item > tbody > tr');
      dadosPendentes = await extrairPendentes(page);
    }
    log(`[Massivas] ${dadosPendentes.length} linhas extraídas (pendentes)`);

    // Atribuídas
    log('[Massivas] Abrindo atribuídas...');
    await page.goto(URL_ATRIBUIDAS);
    await aguardarFormularioFiltros(page);
    await selecionarFiltros(page);

    let dadosAtribuidas = [];
    if (await buscarComTentativas(page, 'table.tableQuebraEquipe')) {
      await aguardarEstabilizar(page, 'table.tableQuebraEquipe table#item > tbody > tr');
      dadosAtribuidas = await extrairPorColaborador(page);
    }
    log(`[Massivas] ${dadosAtribuidas.length} linhas extraídas (atribuídas)`);

    // Em execução
    log('[Massivas] Abrindo em execução...');
    await page.goto(URL_EM_EXECUCAO);
    await aguardarFormularioFiltros(page);
    await selecionarFiltros(page);

    let dadosEmExecucao = [];
    if (await buscarComTentativas(page, 'table.tableQuebraEquipe')) {
      await aguardarEstabilizar(page, 'table.tableQuebraEquipe table#item > tbody > tr');
      dadosEmExecucao = await extrairPorColaborador(page);
    }
    log(`[Massivas] ${dadosEmExecucao.length} linhas extraídas (em execução)`);

    const agora = new Date();
    const dtImport = agora.toLocaleDateString('pt-BR');
    const hrImport = agora.toLocaleTimeString('pt-BR');
    const mesRef = `${agora.getFullYear()}/${String(agora.getMonth() + 1).padStart(2, '0')}/01`;

    const anexarImport = obj => ({ ...obj, dt_import: dtImport, hr_import: hrImport, mes_ref: mesRef });

    // Controle de Empreiteiras (-> base_dados_leitura): encadeado aqui, na
    // MESMA sessão já logada (não abre login novo — portal Copel trata
    // sessão como única por conta, ADR 0019). Ontem primeiro (relatório já
    // consolidado, pode ter sido corrigido desde a última coleta), depois
    // hoje — pedido explícito do usuário: cada ciclo reconcilia os dois
    // dias, não só o atual.
    //
    // `null` (não tentado/falhou) é DIFERENTE de `[]` (tentado, achou zero
    // linhas de verdade) — quem importa (coletaMassivasService.js) só faz
    // DELETE+INSERT pro dia quando o valor não é `null`. Sem essa
    // distinção, um erro de rede na extração de "ontem" viraria `[]` igual
    // a "não tem nada mesmo", e o importador APAGARIA dado bom de um dia
    // anterior por causa de uma falha transitória — pior que não ter
    // rodado. Cada data tem seu próprio try/catch: erro em "ontem" não
    // pode impedir a tentativa de "hoje".
    const hoje = agora;
    const ontem = new Date(agora);
    ontem.setDate(ontem.getDate() - 1);

    const controleEmpreiteiras = { ontem: null, hoje: null };
    log('[Controle Empreiteiras] 🟡 Iniciando extração (ontem + hoje)...');
    try {
      controleEmpreiteiras.ontem = await extrairControleEmpreiteiras(page, ontem, {
        concessionaria: CONTROLE_EMPREITEIRAS_CONCESSIONARIA,
        empreiteira: CONTROLE_EMPREITEIRAS_EMPREITEIRA,
      });
    } catch (erro) {
      logErro('[Controle Empreiteiras] ❌ Erro na extração de ontem:', erro);
      await salvarDiagnostico(page, 'controle_empreiteiras_ontem_falhou');
    }
    try {
      controleEmpreiteiras.hoje = await extrairControleEmpreiteiras(page, hoje, {
        concessionaria: CONTROLE_EMPREITEIRAS_CONCESSIONARIA,
        empreiteira: CONTROLE_EMPREITEIRAS_EMPREITEIRA,
      });
    } catch (erro) {
      logErro('[Controle Empreiteiras] ❌ Erro na extração de hoje:', erro);
      await salvarDiagnostico(page, 'controle_empreiteiras_hoje_falhou');
    }

    return {
      pendentes: paraObjetos(dadosPendentes, NOMES_COLUNAS).map(anexarImport),
      atribuidas: paraObjetos(dadosAtribuidas, NOMES_COLUNAS_ATRIBUIDAS).map(anexarImport),
      emExecucao: paraObjetos(dadosEmExecucao, NOMES_COLUNAS_ATRIBUIDAS).map(anexarImport),
      controleEmpreiteiras,
    };
  } finally {
    await browser.close();
  }
}

module.exports = { coletarMassivas };