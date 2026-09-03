const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { log, logErro } = require('../utils/logTempo');

const DIR_DIAGNOSTICO = path.join(__dirname, '..', '..', 'diagnosticos');
const URL_ACOMPANHAMENTO = 'https://www.copel.com/lis/acompanhamentoAction.do#';

async function salvarDiagnostico(page, motivo) {
  try {
    if (!fs.existsSync(DIR_DIAGNOSTICO)) fs.mkdirSync(DIR_DIAGNOSTICO, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(DIR_DIAGNOSTICO, `acomp_${motivo}_${timestamp}`);

    await page.screenshot({ path: `${base}.png`, fullPage: true });
    const textoVisivel = await page.evaluate(() => document.body.innerText.slice(0, 3000));
    fs.writeFileSync(`${base}.txt`, `URL: ${page.url()}\n\n${textoVisivel}`, 'utf-8');

    log(`[Coleta Acomp] 📸 Diagnóstico salvo: ${base}.png / .txt`);
  } catch (erroDiagnostico) {
    logErro('[Coleta Acomp] ⚠️ Não foi possível salvar diagnóstico:', erroDiagnostico.message);
  }
}

// Lê o cabeçalho (etapa/localidade/livro/...) e o número do livro de uma
// linha da tabela de livros. Retorna null se a linha estiver vazia (sem
// nenhum dado — acontece em linhas de rodapé/separador). Funciona mesmo
// com a linha oculta (display:none): innerText/getAttribute não exigem
// visibilidade, só .click() exige.
async function lerCabecalhoLinha(linha, etapa) {
  const celulas = await linha.locator('td').allInnerTexts();
  // Primeira célula é o checkbox de seleção (sem texto).
  let row = celulas.slice(1);
  while (row.length < 14) row.push('');

  let dataRecebimento = '';
  let horaRecebimento = '';
  if (row[6] && row[6].includes(' ')) {
    [dataRecebimento, horaRecebimento] = row[6].split(' ', 2);
  } else {
    dataRecebimento = row[6];
  }

  const cabecalho = {
    etapa,
    localidade: row[3],
    livro: row[4],
    empreiteira: row[5],
    dataRecebimento,
    horaRecebimento,
    dataPrevistaLimite: row[7],
    situacaoBruta: row[13],
  };

  if (!Object.values(cabecalho).some(v => v && String(v).trim())) return null;
  return cabecalho;
}

// Cada etapa expandida (clique em "ETAPA X - (N)") mostra sua própria
// tabela de livros — mas TODAS essas tabelas compartilham o mesmo
// id="item" (várias tabelas empilhadas na mesma página, uma por etapa,
// cada uma com seu cabeçalho "ETAPA N - (M)" acima). Um seletor CSS
// `#item` sempre resolve pra PRIMEIRA ocorrência desse id no documento —
// por isso usa XPath relativo ao link da etapa ("following::table[@id='item'][1]"
// — a primeira tabela #item que aparece DEPOIS do link no documento) em
// vez de um seletor global.
function tabelaDaEtapa(etapaLink) {
  return etapaLink.locator('xpath=following::table[@id="item"][1]');
}

// A lista de ETAPAS (os links "ETAPA X - (N)") carrega de forma
// "preguiçosa" conforme a página rola pra baixo. Já a tabela de LIVROS de
// cada etapa que JÁ apareceu vem inteira desde o início — o clique em
// "ETAPA X - (N)" só alterna a visibilidade (função ShowHide() do site) de
// uma tabela que já existe no DOM, não busca dado novo (confirmado pelo
// usuário com o HTML real da página: toda tabela de livros de toda etapa
// carregada já está presente, só com `style="display:none"`). Por isso
// esta função só precisa garantir que os LINKS de etapa terminaram de
// carregar via scroll — depois disso dá pra ler os livros de todas elas
// direto, sem precisar clicar/expandir uma por uma.
//
// Rola em PASSOS (altura de uma janela por vez), não num salto direto pro
// fim (`scrollTo(0, scrollHeight)`) — se o carregamento do próximo lote
// depende de a rolagem "passar" pelos itens já carregados (ex.:
// intersection observer no fim da lista atual), pular direto pro fim pode
// não disparar o gatilho certo. Exige 4 leituras estáveis seguidas (não
// só 1) antes de decidir que a lista de etapas parou de crescer.
async function aguardarTodasEtapasCarregadas(page) {
  const etapas = page.locator('a.color:has-text("ETAPA")');
  let anterior = -1;
  let estavel = 0;
  for (let tentativa = 0; tentativa < 150; tentativa++) {
    const atual = await etapas.count();
    if (atual === anterior) {
      estavel++;
      if (estavel >= 4) return atual;
    } else {
      estavel = 0;
    }
    anterior = atual;
    await page.evaluate(() => window.scrollBy(0, window.innerHeight)).catch(() => {});
    await page.waitForTimeout(600);
  }
  return anterior;
}

// Extrai só o número da etapa ("18" de "ETAPA 18 - (309)") — o texto
// completo inclui a contagem de livros ENTRE PARÊNTESES, que muda a cada
// consulta e não é confiável como identificador entre ciclos.
function numeroDaEtapa(texto) {
  const match = String(texto ?? '').match(/ETAPA\s+(\d+)/i);
  return match ? match[1] : null;
}

// Extrai id da OS a partir do href
// `javascript:update('12105126','editarTarefasLeituraAction.do?...')` do
// link "número da OS" de cada linha — usado só como chave de dedup (o
// osId é o identificador globalmente único de cada livro/OS na página,
// diferente do "número do livro" exibido, que é só um rótulo e pode não
// ser único entre etapas). Este scraper não abre mais OS nenhuma (ver
// coletarDadosAcompanhamento) — só lê a lista já carregada no DOM.
function extrairDadosOs(href) {
  const match = String(href ?? '').match(/update\('(\d+)'\s*,\s*'([^']*)'\)/);
  return match ? { osId: match[1], url: match[2] } : null;
}

// Lê TODOS os livros de uma etapa (já com a tabela no DOM, visível ou não —
// ver aguardarTodasEtapasCarregadas) sem precisar clicar/expandir a etapa:
// innerText e getAttribute funcionam em elemento oculto, só .click() exige
// visibilidade.
async function extrairLivrosDaEtapa(etapaLink, etapaNumero) {
  const tabela = tabelaDaEtapa(etapaLink);
  const linhas = tabela.locator('tbody tr');
  const total = await linhas.count();
  const livros = [];
  for (let i = 0; i < total; i++) {
    const linha = linhas.nth(i);
    const cabecalho = await lerCabecalhoLinha(linha, etapaNumero);
    if (!cabecalho) continue;
    const linkOs = linha.locator('td').nth(3).locator('a');
    if ((await linkOs.count()) === 0) continue;
    const href = await linkOs.getAttribute('href');
    const dadosOs = extrairDadosOs(href);
    if (!dadosOs) continue;
    livros.push({ ...dadosOs, ...cabecalho });
  }
  return livros;
}

// Aplica os mesmos filtros (concessionária/empreiteira) e busca. Deixa a
// lista de etapas completamente carregada ao final.
async function aplicarFiltroEBuscar(page) {
  await page.selectOption('select[name="searchConcessionariaId"]', { label: 'COMPANHIA PARANAENSE DE ENERGIA' });
  await page.selectOption('select[name="searchEmpreiteiraId"]', { label: 'F IMM BRASIL LTDA' });
  await page.click('#botaoBuscar');
  await page.waitForSelector('a.color:has-text("ETAPA")', { timeout: 60000 });
  await aguardarTodasEtapasCarregadas(page);
}

// Coleta de Acompanhamento: login + 1 busca + leitura da lista de livros já
// carregada no DOM — sem abrir OS nenhuma. A extração por OS (abrir cada
// livro pra ler UC por UC) foi removida: o site se mostrou instável sob uso
// repetido de `update()` (a chamada que abre uma OS) — a taxa de "sessão
// perdida" ficou igualmente alta com 1 conta ou com até 10 contas
// dedicadas em paralelo, isolando completamente sessão/login entre elas,
// o que descarta colisão de sessão como causa e aponta pra instabilidade
// do próprio site sob esse padrão de uso, não pra arquitetura de scraping.
// Esta lista (situação/colaborador/datas por livro) é só pra saber a
// SITUAÇÃO do livro — quais UCs cada livro tem vem de coordenadas_ucs_
// mineradas (minerada à parte) e quais foram realizadas vem de
// base_dados_leitura (extração "Controle de Empreiteiras", ADR 0027); ver
// monitoramentoService.js/atividadeColaboradoresService.js.
async function coletarDadosAcompanhamento() {
  const headless = process.env.COPEL_HEADLESS !== 'false';
  const browser = await chromium.launch({ headless, slowMo: headless ? 100 : 300 });
  try {
    const context = await browser.newContext();

    // Bloqueia imagem/CSS/fonte/mídia — a extração só lê texto/atributo via
    // innerText/getAttribute, nunca depende do visual renderizado.
    await context.route('**/*', route => {
      const tipo = route.request().resourceType();
      const url = route.request().url();
      if (['image', 'stylesheet', 'font', 'media'].includes(tipo)) {
        return route.abort();
      }
      if (tipo === 'script' && /\/tags\/calendar/i.test(url)) {
        return route.abort();
      }
      return route.continue();
    });

    const page = await context.newPage();

    log('[Coleta Acomp] 🔐 Fazendo login...');
    await page.goto(URL_ACOMPANHAMENTO, { timeout: 60000 });
    await page.fill("input[name='j_username']", process.env.COPEL_USERNAME);
    await page.fill("input[name='j_password']", process.env.COPEL_PASSWORD);
    await page.click("input[type='submit'].lgn_btn");

    // Conta com senha perto de expirar cai numa tela intermediária pedindo
    // pra trocar agora — "Adiar alteração" segue o login normalmente sem
    // trocar nada. Só espera 5s por esse botão (não atrasa quem não cai
    // nessa tela) antes de seguir pro fluxo normal.
    try {
      await page.locator("input[type='button'][value='Adiar alteração']").click({ timeout: 5000 });
      log('[Coleta Acomp] 🔐 Senha perto de expirar — adiando alteração pra manter o login.');
    } catch {
      // não caiu nessa tela, segue o fluxo normal
    }

    try {
      await page.waitForSelector('a.submenu', { timeout: 60000 });
    } catch (erroLogin) {
      await salvarDiagnostico(page, 'login_falhou');
      throw erroLogin;
    }
    log('[Coleta Acomp] ✅ Login realizado com sucesso.');

    await page.click("a.submenu:has-text('acompanhamento')");
    await aplicarFiltroEBuscar(page);

    // A página, depois da busca, já carrega TODAS as etapas E todos os
    // livros de cada uma no DOM de uma vez só — o clique em "ETAPA N - (M)"
    // só alterna a visibilidade (ShowHide()) de uma tabela que já existe,
    // não busca dado novo. Por isso dá pra ler todos os livros de todas as
    // etapas aqui, de uma vez, sem precisar clicar/expandir etapa por etapa
    // nem abrir OS nenhuma.
    const etapasLocator = page.locator('a.color:has-text("ETAPA")');
    const totalEtapas = await etapasLocator.count();
    const livros = [];
    // osId garante que a MESMA OS nunca entra duas vezes na lista, mesmo
    // que a tabela de alguma etapa tenha uma linha repetida ou que a mesma
    // OS apareça listada sob mais de uma etapa por algum motivo do portal.
    const osIdsVistos = new Set();
    for (let i = 0; i < totalEtapas; i++) {
      const etapaLink = etapasLocator.nth(i);
      const etapaTexto = await etapaLink.innerText();
      const etapaNumero = numeroDaEtapa(etapaTexto);
      if (!etapaNumero) continue;
      const livrosDaEtapa = await extrairLivrosDaEtapa(etapaLink, etapaNumero);
      for (const livro of livrosDaEtapa) {
        if (osIdsVistos.has(livro.osId)) continue;
        osIdsVistos.add(livro.osId);
        livros.push(livro);
      }
    }

    log(`[Coleta Acomp] 📋 ${livros.length} livro(s) encontrado(s) em ${totalEtapas} etapa(s).`);
    log('[Coleta Acomp] ✅ Extração concluída.');
    return livros;
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { coletarDadosAcompanhamento };
