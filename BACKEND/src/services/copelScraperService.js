const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { log, logWarn, logErro } = require('../utils/logTempo');

const DIR_DIAGNOSTICO = path.join(__dirname, '..', '..', 'diagnosticos');
const URL_ACOMPANHAMENTO = 'https://www.copel.com/lis/acompanhamentoAction.do#';

// Teto de duração só do MODO PROFUNDO (abrir OS livro a livro, ver
// coletarUcsDoLivro/coletarDadosAcompanhamento mais abaixo) — o modo rápido
// nunca precisa disso, sempre termina em segundos. Protege o job Massivas
// (comSessaoExclusiva serializa os dois, ver copelSessaoLock.js) de ficar
// preso indefinidamente atrás de um modo profundo que travou. Ao estourar,
// para com o que já foi coletado até agora — não é perda permanente: como
// "já rodei hoje" só passa a ser verdade quando pelo menos 1 UC é gravada em
// roster_ucs_extracao_diaria (ver rosterUcsAcompanhamentoService.js), um
// timeout que não coletou nada faz o PRÓXIMO ciclo tentar o modo profundo de
// novo do zero.
const TIMEOUT_PROFUNDO_MIN = Math.max(5, parseInt(process.env.COPEL_TIMEOUT_PROFUNDO_MIN || '90', 10));
const TIMEOUT_PROFUNDO_MS = TIMEOUT_PROFUNDO_MIN * 60 * 1000;

// Quantas vezes tenta abrir a OS de UM livro (incluindo recuperar sessão
// perdida) antes de desistir dele — nesse caso o livro simplesmente não
// entra no roster de hoje (a linha de SITUAÇÃO dele em contr_execucao_leitura,
// vinda do modo rápido de sempre, não é afetada).
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
// `update(osId, url)` sem precisar clicar em nada (ver abrirEExtrairOs).
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

// --- MODO PROFUNDO: abrir a OS de cada livro, 1 por vez, só na primeira
// extração bem-sucedida do dia (ver coletarDadosAcompanhamento e
// rosterUcsAcompanhamentoService.js). Esta seção reaproveita a lógica de
// abertura de OS que existiu neste arquivo antes da ADR 0028 (removida
// porque abrir OS o CICLO INTEIRO, o dia todo, deixava o site instável) —
// trazida de volta AQUI, restrita a rodar só 1x por dia, sem paralelismo
// (nenhuma das 5-8 abas simultâneas que causavam a instabilidade histórica).

// Extrai a tabela #tabFixedHeader da aba/tela de detalhe (aberta ao chamar
// update(), ver abrirEExtrairOs) — uma linha por UC/medidor do livro.
// Índices confirmados contra o HTML real na época (ver histórico desta ADR):
// 1=UC, 2=equip., 3=tipo espec., 5=faturar?, 7=leit. atual (input), 8=código
// (input). leit. atual e código são <input readonly value="..."> — o valor
// visível está no atributo value, não no innerText do <td>.
async function extrairLinhasDetalheOs(paginaDetalhe) {
  return paginaDetalhe.evaluate(() => {
    const table = document.querySelector('#tabFixedHeader');
    if (!table) return [];
    const valorCelula = td => {
      const input = td.querySelector('input');
      return (input ? input.value : td.innerText).trim();
    };
    return Array.from(table.querySelectorAll('tbody tr')).map(tr => {
      const tds = Array.from(tr.querySelectorAll('td'));
      return {
        uc: tds[1] ? valorCelula(tds[1]) : '',
        equipamento: tds[2] ? valorCelula(tds[2]) : '',
        tipoEspecificacao: tds[3] ? valorCelula(tds[3]) : '',
        faturamento: tds[5] ? valorCelula(tds[5]) : '',
        leituraAtual: tds[7] ? valorCelula(tds[7]) : '',
        codigo: tds[8] ? valorCelula(tds[8]) : '',
      };
    });
  });
}

async function contarLinhasTabFixedHeader(paginaDetalhe) {
  return paginaDetalhe
    .locator('#tabFixedHeader tbody tr')
    .count()
    .catch(() => 0);
}

// A tabela de UCs pode montar as linhas via JS de forma assíncrona/
// incremental depois de #tabFixedHeader já existir no DOM — extrair assim
// que o elemento aparece corre o risco de pegar só a 1ª linha. Espera a
// contagem de linhas parar de crescer entre duas checagens antes de extrair.
async function aguardarTabelaEstabilizar(paginaDetalhe) {
  let anterior = -1;
  for (let tentativa = 0; tentativa < 20; tentativa++) {
    const atual = await contarLinhasTabFixedHeader(paginaDetalhe);
    if (atual > 0 && atual === anterior) return atual;
    anterior = atual;
    await paginaDetalhe.waitForTimeout(500);
  }
  return anterior;
}

// Fecha a tela de detalhe da OS quando ela abriu na MESMA página (sem
// popup) — usa o botão "CANCELAR" em vez de page.goBack(): goBack() não
// restaura o estado JS da lista de livros (filtro/paginação via AJAX),
// deixando os livros seguintes inacessíveis. Fallback pra goBack() só se o
// botão não existir.
async function fecharTelaDetalheMesmaPagina(page) {
  const botaoCancelar = page.getByRole('button', { name: /cancelar/i }).or(
    page.locator('input[type="button"][value*="CANCELAR" i], input[type="submit"][value*="CANCELAR" i]'),
  );
  if ((await botaoCancelar.count()) > 0) {
    await botaoCancelar.first().click();
  } else {
    logWarn('[Coleta Acomp] ⚠️ Botão CANCELAR não encontrado — usando page.goBack() como fallback.');
    await page.goBack().catch(() => {});
  }
}

// Checa rapidamente se a página está num estado utilizável (a função
// update() e o formulário principal existem) ANTES de tentar abrir a OS —
// mais barato que descobrir isso só depois de um timeout de 20s esperando
// popup/"DADOS DE EXECUÇÃO".
async function paginaUtilizavel(page) {
  return page
    .evaluate(() => typeof window.update === 'function' && document.forms.length > 0)
    .catch(() => false);
}

// Tenta trazer a página de volta ao estado funcional: renavega pra URL de
// Acompanhamento e refaz filtro + busca. Até 3 tentativas com folga entre
// elas (transitório: sobrecarga momentânea do lado do servidor Copel, já
// documentado no histórico desta ADR). Diagnóstico salvo só uma vez por
// execução do modo profundo (via estadoDiagnostico compartilhado).
const MAX_TENTATIVAS_RECUPERAR_BUSCA = 3;

async function recuperarBusca(page, estadoDiagnostico) {
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_RECUPERAR_BUSCA; tentativa++) {
    await page.goto(URL_ACOMPANHAMENTO, { timeout: 60000 }).catch(erro => {
      logErro(`[Coleta Acomp] ⚠️ Falha ao renavegar (tentativa ${tentativa}/${MAX_TENTATIVAS_RECUPERAR_BUSCA}): ${erro.message}`);
    });
    try {
      await aplicarFiltroEBuscar(page);
      return true;
    } catch (erro) {
      logErro(`[Coleta Acomp] ⚠️ Falha ao refazer a busca (tentativa ${tentativa}/${MAX_TENTATIVAS_RECUPERAR_BUSCA}): ${erro.message}`);
      if (tentativa >= MAX_TENTATIVAS_RECUPERAR_BUSCA) {
        if (!estadoDiagnostico.recuperacaoSalvo) {
          estadoDiagnostico.recuperacaoSalvo = true;
          await salvarDiagnostico(page, 'profundo_recuperacao_falhou');
        }
        return false;
      }
      await page.waitForTimeout(3000);
    }
  }
  return false;
}

// Abre a OS de um único livro chamando DIRETO a função JS `update(osId,url)`
// que o próprio site define (é literalmente tudo que o link "número da OS"
// faz). Não depende de a linha estar visível — não precisa localizar nem
// expandir a etapa do livro. Lança erro se a OS não abrir a tempo (o
// chamador, coletarUcsDoLivro, decide se tenta de novo).
async function abrirEExtrairOs(page, alvo) {
  let popup = null;
  let usouMesmaPagina = false;
  try {
    // waitForEvent('popup') precisa ser registrado ANTES de disparar a
    // navegação — mas isso deixa a promise "solta" rejeitando sozinha por
    // timeout enquanto o código ainda está no evaluate(). `.catch(() => {})`
    // preventivo em CADA nível evita unhandled rejection.
    const promPopup = page.waitForEvent('popup', { timeout: 20000 });
    promPopup.catch(() => {});
    const promMesmaPagina = page
      .getByText('DADOS DE EXECUÇÃO', { exact: false })
      .first()
      .waitFor({ timeout: 20000, state: 'visible' });
    promMesmaPagina.catch(() => {});

    const esperaPopup = promPopup.then(p => ({ tipo: 'popup', p }));
    esperaPopup.catch(() => {});
    const esperaMesmaPagina = promMesmaPagina.then(() => ({ tipo: 'mesmaPagina' }));
    esperaMesmaPagina.catch(() => {});

    const combinada = Promise.any([esperaPopup, esperaMesmaPagina]);
    combinada.catch(() => {});

    const executou = await page.evaluate(
      ({ osId, url }) => {
        if (typeof window.update !== 'function') return false;
        window.update(osId, url);
        return true;
      },
      { osId: alvo.osId, url: alvo.url },
    );
    if (!executou) {
      throw new Error('função update() indisponível nesta página (sessão/busca perdida)');
    }

    const resultado = await combinada;

    if (resultado.tipo === 'popup') {
      popup = resultado.p;
      await popup.waitForSelector('#tabFixedHeader', { timeout: 15000 });
    } else {
      usouMesmaPagina = true;
      await page.waitForSelector('#tabFixedHeader', { timeout: 15000 });
    }

    const paginaDetalhe = popup || page;
    await aguardarTabelaEstabilizar(paginaDetalhe);
    return await extrairLinhasDetalheOs(paginaDetalhe);
  } finally {
    if (popup) {
      await popup.close().catch(() => {});
    } else if (usouMesmaPagina) {
      await fecharTelaDetalheMesmaPagina(page).catch(async erroFechar => {
        logWarn(
          `[Coleta Acomp] ⚠️ Falha ao fechar tela de detalhe do livro '${alvo.livro}': ${erroFechar.message} — renavegando pra lista.`,
        );
        await page.goto(URL_ACOMPANHAMENTO, { timeout: 60000 }).catch(() => {});
        await aplicarFiltroEBuscar(page).catch(() => {});
      });
    }
  }
}

// Processa UM livro do modo profundo: confirma que a página está saudável
// (recupera se não estiver) e delega a abrirEExtrairOs, com retry. Retorna
// sempre um array (vazio se desistir) — um livro sem UC coletada não perde a
// linha de SITUAÇÃO em contr_execucao_leitura (essa vem do modo rápido,
// sempre executado antes, ver coletarDadosAcompanhamento).
async function coletarUcsDoLivro(page, alvo, estadoDiagnostico) {
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_ABRIR_OS; tentativa++) {
    if (!(await paginaUtilizavel(page))) {
      logWarn(`[Coleta Acomp] 🔁 Sessão/busca perdida (livro '${alvo.livro}') — recuperando.`);
      const recuperou = await recuperarBusca(page, estadoDiagnostico);
      if (!recuperou) continue;
    }
    try {
      return await abrirEExtrairOs(page, alvo);
    } catch (erro) {
      logWarn(
        `[Coleta Acomp] ⚠️ Tentativa ${tentativa}/${MAX_TENTATIVAS_ABRIR_OS} falhou pro livro '${alvo.livro}': ${erro.message}`,
      );
    }
  }
  logErro(
    `[Coleta Acomp] ❌ Livro '${alvo.livro}' desistido após ${MAX_TENTATIVAS_ABRIR_OS} tentativas — sem UC no roster de hoje pra ele.`,
  );
  if (!estadoDiagnostico.osSalvo) {
    estadoDiagnostico.osSalvo = true;
    await salvarDiagnostico(page, `profundo_os_${alvo.livro}_falhou`);
  }
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
// UMA vez, serialmente (nunca em paralelo — foi o paralelismo, não a
// abertura de OS em si, que historicamente detonava a taxa de "sessão
// perdida", ver Adendos da ADR 0020). Só roda na primeira extração
// bem-sucedida do dia — depois disso, `coordenadas_ucs_mineradas` pode ficar
// desatualizada pro livro que foi reatribuído durante o dia (ADR 0028,
// Consequências), mas o roster de HOJE já foi capturado direto da fonte,
// então não depende mais dela pra saber quais UCs cada livro realmente tem.
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
        'livro(s), 1 por vez (pode levar 30-40min).',
    );
    const roster = [];
    const estadoDiagnostico = { recuperacaoSalvo: false, osSalvo: false };
    const inicioProfundo = Date.now();
    let processados = 0;
    let livrosComUc = 0;
    for (const alvo of livros) {
      if (Date.now() - inicioProfundo > TIMEOUT_PROFUNDO_MS) {
        logErro(
          `[Coleta Acomp] ⏱️ Modo profundo excedeu ${TIMEOUT_PROFUNDO_MIN}min — parando em ` +
            `${processados}/${livros.length} livro(s). ` +
            (roster.length > 0
              ? `Roster parcial (${roster.length} UC(s)) já coletado fica valendo hoje.`
              : 'Nenhuma UC coletada ainda — o próximo ciclo tenta o modo profundo de novo, do zero.'),
        );
        break;
      }
      const linhasUc = await coletarUcsDoLivro(page, alvo, estadoDiagnostico);
      // etapa normalizada pro mesmo padrão "só o número, 2 dígitos" usado no
      // resto do app (ver copelImportService.js#limparEtapa) — alvo.etapa
      // aqui já vem só o número (numeroDaEtapa), só falta o padStart.
      const etapaNormalizada = alvo.etapa ? String(alvo.etapa).padStart(2, '0') : null;
      for (const uc of linhasUc) {
        if (uc.uc) roster.push({ livro: alvo.livro, etapa: etapaNormalizada, unidadeConsumidora: uc.uc });
      }
      if (linhasUc.length > 0) livrosComUc++;
      processados++;
      if (processados % 25 === 0) {
        log(
          `[Coleta Acomp] 🔬 Progresso modo profundo: ${processados}/${livros.length} livro(s) ` +
            `(${livrosComUc} com UC até agora, ${roster.length} UC(s) no roster).`,
        );
      }
    }
    log(
      `[Coleta Acomp] ✅ Modo profundo concluído: ${processados}/${livros.length} livro(s) processado(s), ` +
        `${livrosComUc} com UC, ${roster.length} UC(s) no roster de hoje.`,
    );
    return { livros, roster };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { coletarDadosAcompanhamento };
