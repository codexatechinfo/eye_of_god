const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { log, logWarn, logErro } = require('../utils/logTempo');

const DIR_DIAGNOSTICO = path.join(__dirname, '..', '..', 'diagnosticos');
const URL_ACOMPANHAMENTO = 'https://www.copel.com/lis/acompanhamentoAction.do#';
const URL_ABRIR_OS = 'https://www.copel.com/lis/editarTarefasLeituraAction.do?acompanhamento=S';

// Teto de duração só do MODO PROFUNDO (abrir OS livro a livro, ver
// coletarDadosAcompanhamento mais abaixo) — o modo rápido nunca precisa
// disso, sempre termina em segundos. Protege o job Massivas
// (comSessaoExclusiva serializa os dois, ver copelSessaoLock.js) de ficar
// preso indefinidamente atrás de um modo profundo que travou. Ao estourar,
// para com o que já foi coletado até agora — não é perda permanente: como
// "já rodei hoje" só passa a ser verdade quando pelo menos 1 UC é gravada em
// roster_ucs_extracao_diaria (ver rosterUcsAcompanhamentoService.js), um
// timeout que não coletou nada faz o PRÓXIMO ciclo tentar o modo profundo de
// novo do zero. Desde que o modo profundo passou a ser via HTTP direto (ver
// Adendo 2 da ADR 0039), uma extração completa leva minutos, não horas — mas
// o teto continua existindo como rede de segurança, não mais como limitador
// esperado.
//
// COPEL_TIMEOUT_PROFUNDO_MIN=0 (ou negativo) DESLIGA o teto por completo —
// pedido explícito do usuário pra medir quanto tempo uma extração completa
// leva de verdade, sem cortar a fila no meio. Qualquer valor positivo
// continua com o piso de 5min de sempre (protege contra um valor baixo
// demais por engano).
const TIMEOUT_PROFUNDO_MIN_RAW = parseInt(process.env.COPEL_TIMEOUT_PROFUNDO_MIN ?? '90', 10);
const TIMEOUT_PROFUNDO_MS =
  TIMEOUT_PROFUNDO_MIN_RAW > 0 ? Math.max(5, TIMEOUT_PROFUNDO_MIN_RAW) * 60 * 1000 : null;

// Quantas vezes tenta abrir a OS de UM livro antes de desistir dele — nesse
// caso o livro simplesmente não entra no roster de hoje (a linha de
// SITUAÇÃO dele em contr_execucao_leitura, vinda do modo rápido de sempre,
// não é afetada).
const MAX_TENTATIVAS_ABRIR_OS = 3;

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

// Mesma ideia de salvarDiagnostico, mas pro MODO PROFUNDO via HTTP — não
// existe `page`/navegador pra tirar screenshot, só o texto da resposta que
// veio de errado (útil pra depois entender por que faltou a tabela).
function salvarDiagnosticoHttp(motivo, conteudo) {
  try {
    if (!fs.existsSync(DIR_DIAGNOSTICO)) fs.mkdirSync(DIR_DIAGNOSTICO, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(DIR_DIAGNOSTICO, `acomp_${motivo}_${timestamp}.txt`);
    fs.writeFileSync(base, conteudo.slice(0, 5000), 'utf-8');
    log(`[Coleta Acomp] 📸 Diagnóstico (HTTP) salvo: ${base}`);
  } catch (erroDiagnostico) {
    logErro('[Coleta Acomp] ⚠️ Não foi possível salvar diagnóstico HTTP:', erroDiagnostico.message);
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

// Extrai id da OS e URL de destino a partir do href
// `javascript:update('12105126','editarTarefasLeituraAction.do?...')` do
// link "número da OS" de cada linha — osId é o identificador globalmente
// único de cada livro/OS na página (diferente do "número do livro" exibido,
// que é só um rótulo e pode não ser único entre etapas), usado tanto pra
// dedup na montagem da lista quanto, no modo profundo, pra abrir a OS via
// POST HTTP direto (ver abrirOsViaHttp).
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

// --- MODO PROFUNDO: abrir a OS de cada livro, só na primeira extração
// bem-sucedida do dia (ver coletarDadosAcompanhamento e
// rosterUcsAcompanhamentoService.js).
//
// HISTÓRICO (ver ADR 0039 e seus Adendos pro relato completo): a primeira
// versão reaproveitou a lógica de abertura de OS que existia neste arquivo
// antes da ADR 0028 — clicar/chamar update(osId,url) via Playwright,
// esperar popup ou "mesma página", ler a tabela do DOM. Testado ao vivo
// contra o portal real: SERIAL (1 aba) processou só 136/2270 livros em
// ~99min; 5 ABAS EM PARALELO só melhorou pra 267/1760 em ~90min — ainda
// muito abaixo do necessário, com bastante "sessão perdida" nos dois casos.
//
// Investigação ao vivo (Adendo 2 da ADR 0039) achou a causa raiz: abrir uma
// OS não precisa de navegador NENHUM — é só um POST de formulário
// (`editarTarefasLeituraAction.do`) que o próprio JS do site monta a partir
// do forms[0] da página de busca. Replicando esse POST direto via HTTP
// (sem Playwright, só com as cookies da sessão já autenticada), testado ao
// vivo: 300/300 OS abertas com sucesso, ~230ms cada, ZERO degradação — a
// instabilidade histórica vinha do PESO de abrir popup/aguardar render num
// browser real centenas de vezes, não de um limite do lado do servidor.
// Ver abrirOsViaHttp mais abaixo.

// Extrai o valor de uma célula de linha de #tabFixedHeader a partir do HTML
// puro da resposta HTTP (sem DOM/Playwright) — mesmos índices de coluna já
// validados contra o HTML real (ver histórico desta ADR): 1=UC, 2=equip.,
// 3=tipo espec., 5=faturar?, 7=leit. atual (input), 8=código (input).
// leit. atual/código são <input value="...">, os demais são texto puro
// dentro do próprio <td>.
function extrairLinhasDetalheOsDoHtml(html) {
  const tbodyMatch = html.match(/<table[^>]*id="tabFixedHeader"[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/);
  if (!tbodyMatch) return null; // null = tabela não encontrada (sessão/resposta inesperada)

  const valorCelula = tdHtml => {
    const inputMatch = tdHtml.match(/<input[^>]*value="([^"]*)"/);
    if (inputMatch) return inputMatch[1].trim();
    return tdHtml.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  };

  const linhasHtml = tbodyMatch[1].split(/<tr/).slice(1);
  return linhasHtml.map(linhaHtml => {
    const tds = [...linhaHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
    return {
      uc: tds[1] ? valorCelula(tds[1]) : '',
      equipamento: tds[2] ? valorCelula(tds[2]) : '',
      tipoEspecificacao: tds[3] ? valorCelula(tds[3]) : '',
      faturamento: tds[5] ? valorCelula(tds[5]) : '',
      leituraAtual: tds[7] ? valorCelula(tds[7]) : '',
      codigo: tds[8] ? valorCelula(tds[8]) : '',
    };
  });
}

// Captura tudo que o modo profundo via HTTP precisa da sessão já logada e
// já buscada no navegador: as cookies (pra autenticar as requisições HTTP
// diretas) e uma cópia de TODOS os campos do forms[0] da página de busca
// (inclui os hidden tarefasEtapaXX/countUCsXXXXX de cada etapa carregada —
// é literalmente o estado que o site usa pra saber "quais livros existem
// nesta busca", precisa ir junto em toda abertura de OS). `chkIdAll`
// aparece repetido no form original (um checkbox "marcar todos" por etapa)
// — descartado, não é relevante pra abrir uma OS específica.
async function capturarEstadoParaHttp(page) {
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const camposBase = await page.evaluate(() => {
    const form = document.forms[0];
    const campos = {};
    for (const el of form.elements) {
      if (el.name && el.name !== 'chkIdAll') campos[el.name] = el.value;
    }
    return campos;
  });
  return { cookieHeader, camposBase };
}

// Abre a OS de um livro via POST HTTP direto — sem navegador. Replica
// exatamente a requisição que `window.update(osId,url)` dispara no site
// (`actionType` vira 'home', `id` vira o osId alvo, resto do corpo é o
// forms[0] capturado uma vez em capturarEstadoParaHttp). ~230ms por
// chamada medido ao vivo contra 300 OS reais, 100% de sucesso. Lança erro
// se a resposta não tiver a tabela esperada (o chamador decide se tenta de
// novo).
async function abrirOsViaHttp(cookieHeader, camposBase, alvo) {
  const params = new URLSearchParams({
    ...camposBase,
    actionType: 'home',
    id: alvo.osId,
    backAddress: 'acompanhamentoAction.do',
  });

  const resp = await fetch(URL_ABRIR_OS, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader,
      Referer: URL_ACOMPANHAMENTO,
    },
    body: params.toString(),
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ao abrir OS`);
  }
  const html = await resp.text();
  const linhas = extrairLinhasDetalheOsDoHtml(html);
  if (linhas === null) {
    throw new Error('resposta sem #tabFixedHeader (sessão perdida ou página inesperada)');
  }
  return linhas;
}

// Processa UM livro do modo profundo via HTTP, com retry simples (rede
// instável, não sessão — o teste ao vivo não achou nenhuma degradação de
// sessão em 300 chamadas seguidas). Retorna sempre um array (vazio se
// desistir) — um livro sem UC coletada não perde a linha de SITUAÇÃO em
// contr_execucao_leitura (essa vem do modo rápido, sempre executado antes).
async function coletarUcsDoLivroViaHttp(cookieHeader, camposBase, alvo) {
  let ultimoErro = null;
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_ABRIR_OS; tentativa++) {
    try {
      return await abrirOsViaHttp(cookieHeader, camposBase, alvo);
    } catch (erro) {
      ultimoErro = erro;
      logWarn(`[Coleta Acomp] ⚠️ Tentativa ${tentativa}/${MAX_TENTATIVAS_ABRIR_OS} falhou pro livro '${alvo.livro}': ${erro.message}`);
      if (tentativa < MAX_TENTATIVAS_ABRIR_OS) await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  logErro(`[Coleta Acomp] ❌ Livro '${alvo.livro}' desistido após ${MAX_TENTATIVAS_ABRIR_OS} tentativas — sem UC no roster de hoje pra ele.`);
  salvarDiagnosticoHttp(`profundo_http_livro_${alvo.livro}_falhou`, `osId=${alvo.osId}\nerro=${ultimoErro?.message}`);
  return [];
}

// Coleta de Acompanhamento: login + 1 busca + leitura da lista de livros já
// carregada no DOM — a lista em si (situação/colaborador/datas por livro)
// nunca abre OS nenhuma, é só pra saber a SITUAÇÃO do livro; alimenta
// contr_execucao_leitura, 1 linha por livro, igual desde a ADR 0028 (o site
// se mostrou instável sob abertura repetida de OS o dia INTEIRO, então essa
// parte continua rápida e sem abrir nada, em TODO ciclo).
//
// MODO PROFUNDO (`modoProfundo=true`, ver rosterUcsAcompanhamentoService.js
// pra quando isso é decidido): além da lista acima, abre a OS de cada livro
// UMA vez via HTTP direto (ver abrirOsViaHttp) — sem navegador, serial,
// ~230ms por livro. Só roda na primeira extração bem-sucedida do dia —
// depois disso, `coordenadas_ucs_mineradas` pode ficar desatualizada pro
// livro que foi reatribuído durante o dia (ADR 0028, Consequências), mas o
// roster de HOJE já foi capturado direto da fonte, então não depende mais
// dela pra saber quais UCs cada livro realmente tem.
async function coletarDadosAcompanhamento(modoProfundo = false) {
  const headless = process.env.COPEL_HEADLESS !== 'false';
  const browser = await chromium.launch({ headless, slowMo: headless ? 100 : 300 });
  try {
    const context = await browser.newContext();

    // Bloqueia imagem/CSS/fonte/mídia — a extração só lê texto/atributo via
    // innerText/getAttribute, nunca depende do visual renderizado.
    // 'stylesheet' tirado do bloqueio (investigação ao vivo, 2026-09-03):
    // sem CSS a página colapsa pra caber inteira na viewport
    // (document.body.scrollHeight == window.innerHeight, confirmado com
    // debug ao vivo), o que deixa window.scrollBy() sem nada pra rolar — e
    // a lista de ETAPA (que carrega via scroll, ver
    // aguardarTodasEtapasCarregadas) trava sempre em 2 etapas mesmo
    // existindo 11+ com dado real (usuário confirmou com print do portal:
    // ETAPA01-(261) batendo exato com o que o scraper achava, mas
    // ETAPA03-(753)/ETAPA04-(479)/ETAPA21 em diante nunca apareciam).
    await context.route('**/*', route => {
      const tipo = route.request().resourceType();
      const url = route.request().url();
      if (['image', 'font', 'media'].includes(tipo)) {
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

    if (!modoProfundo) {
      log('[Coleta Acomp] ✅ Extração concluída (modo rápido, sem abrir OS).');
      return { livros, roster: [] };
    }

    log(
      `[Coleta Acomp] 🔬 Primeira extração de hoje — modo profundo: abrindo OS de ${livros.length} ` +
        'livro(s) via HTTP direto (sem navegador)' +
        (TIMEOUT_PROFUNDO_MS === null ? ' — SEM teto de tempo, roda até esgotar a fila.' : '.'),
    );

    const { cookieHeader, camposBase } = await capturarEstadoParaHttp(page);

    const roster = [];
    const inicioProfundo = Date.now();
    let processados = 0;
    let livrosComUc = 0;
    let timeoutAtingido = false;

    for (const alvo of livros) {
      if (TIMEOUT_PROFUNDO_MS !== null && Date.now() - inicioProfundo > TIMEOUT_PROFUNDO_MS) {
        timeoutAtingido = true;
        break;
      }
      const linhasUc = await coletarUcsDoLivroViaHttp(cookieHeader, camposBase, alvo);
      const etapaNormalizada = alvo.etapa ? String(alvo.etapa).padStart(2, '0') : null;
      for (const uc of linhasUc) {
        if (uc.uc) roster.push({ livro: alvo.livro, etapa: etapaNormalizada, unidadeConsumidora: uc.uc });
      }
      if (linhasUc.length > 0) livrosComUc++;
      processados++;
      if (processados % 200 === 0) {
        log(
          `[Coleta Acomp] 🔬 Progresso modo profundo: ${processados}/${livros.length} livro(s) ` +
            `(${livrosComUc} com UC até agora, ${roster.length} UC(s) no roster).`,
        );
      }
    }

    const duracaoProfundoMin = ((Date.now() - inicioProfundo) / 60000).toFixed(1);
    if (timeoutAtingido) {
      logErro(
        `[Coleta Acomp] ⏱️ Modo profundo excedeu ${TIMEOUT_PROFUNDO_MIN_RAW}min — parando em ` +
          `${processados}/${livros.length} livro(s) após ${duracaoProfundoMin}min. ` +
          (roster.length > 0
            ? `Roster parcial (${roster.length} UC(s)) já coletado fica valendo hoje.`
            : 'Nenhuma UC coletada ainda — o próximo ciclo tenta o modo profundo de novo, do zero.'),
      );
    } else {
      log(
        `[Coleta Acomp] ✅ Modo profundo concluído: ${processados}/${livros.length} livro(s), ` +
          `${livrosComUc} com UC, ${roster.length} UC(s) no roster de hoje, em ${duracaoProfundoMin}min.`,
      );
    }

    return { livros, roster };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { coletarDadosAcompanhamento };
