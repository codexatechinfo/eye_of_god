const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { log, logWarn, logErro } = require('../utils/logTempo');

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

// Extrai a tabela #tabFixedHeader da aba de detalhe (aberta via clique no
// link "número da OS", ver comentário mais abaixo) — uma linha por UC/
// medidor do livro. Índices confirmados contra o HTML real (usuário
// forneceu print + <table id="tabFixedHeader"> completa): 0=num leit.,
// 1=UC, 2=equip., 3=tipo espec., 4=função espec., 5=faturar?, 6=forma,
// 7=leit. atual (input), 8=mensagem 1 (input), 9=mensagem 2 (input),
// 10=lacre (input), 11=Observação (input), 12=checkbox/refresh.
// leit. atual e mensagem 1 são <input readonly value="..."> — o valor
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

// Fecha a tela de detalhe da OS quando ela abriu na MESMA página (sem
// popup) — usa o botão "CANCELAR" (visível no print do usuário, ao lado de
// "GRAVAR") em vez de page.goBack(). Causa raiz de um bug real: goBack()
// não restaura o estado JS da lista de livros da etapa (filtro/paginação
// aplicados via AJAX), deixando os livros seguintes inacessíveis/errados.
// "CANCELAR" é o mecanismo que o próprio site oferece pra fechar a tela e
// devolve a lista no estado certo. Fallback pra goBack() só se o botão não
// existir.
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
  // Não espera a tabela ficar visível aqui: depois de CANCELAR a etapa
  // quase sempre volta RECOLHIDA e só reaparece quando alguém reclica no
  // link da etapa — não sozinha. garantirEtapaVisivel(), chamada antes de
  // processar o próximo livro da fila, já cuida de checar visibilidade e
  // reclicar ativamente se preciso.
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

async function contarLinhasTabFixedHeader(paginaDetalhe) {
  return paginaDetalhe
    .locator('#tabFixedHeader tbody tr')
    .count()
    .catch(() => 0);
}

// A tabela de UCs pode montar as linhas via JS de forma assíncrona/
// incremental depois de #tabFixedHeader já existir no DOM — extrair
// assim que o elemento aparece corre o risco de pegar só a 1ª linha (foi
// exatamente o sintoma reportado: 1 registro por livro num livro com
// 200+ UCs reais). Espera a contagem de linhas parar de crescer entre
// duas checagens (500ms de intervalo, até 10s no total) antes de extrair.
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

// Extrai só o número da etapa ("18" de "ETAPA 18 - (309)") — o texto
// completo inclui a contagem de livros ENTRE PARÊNTESES, que muda a cada
// consulta e não é confiável como identificador entre abas diferentes (ver
// worker mais abaixo: cada aba carrega sua PRÓPRIA cópia da lista, de
// forma independente, então o texto completo pode divergir ligeiramente
// entre elas mesmo sendo a mesma etapa).
function numeroDaEtapa(texto) {
  const match = String(texto ?? '').match(/ETAPA\s+(\d+)/i);
  return match ? match[1] : null;
}

// Extrai o id interno da OS a partir do href
// `javascript:update('12105126','editarTarefasLeituraAction.do?...')` do
// link "número da OS" de cada linha — é o identificador globalmente único
// de cada livro/OS na página (diferente do "número do livro" exibido, que
// é só um rótulo e pode não ser único entre etapas). Usado como chave da
// fila de livros: como cada osId só é extraído UMA vez ao montar a fila,
// não existe forma de duas abas processarem o mesmo livro duas vezes.
function extrairOsId(href) {
  const match = String(href ?? '').match(/update\('(\d+)'/);
  return match ? match[1] : null;
}

// Lê TODOS os livros de uma etapa (já com a tabela no DOM, visível ou não —
// ver aguardarTodasEtapasCarregadas) sem precisar clicar/expandir a etapa:
// innerText e getAttribute funcionam em elemento oculto, só .click() exige
// visibilidade. Cada item vira uma entrada da fila compartilhada por livro.
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
    const osId = extrairOsId(href);
    if (!osId) continue;
    livros.push({ osId, ...cabecalho });
  }
  return livros;
}

// Aplica os mesmos filtros (concessionária/empreiteira) e busca — comum
// tanto à aba principal (depois do login) quanto às abas extras (que já
// herdam a sessão via cookies do mesmo browser context, sem precisar logar
// de novo). Deixa a lista de etapas completamente carregada ao final.
async function aplicarFiltroEBuscar(page) {
  await page.selectOption('select[name="searchConcessionariaId"]', { label: 'COMPANHIA PARANAENSE DE ENERGIA' });
  await page.selectOption('select[name="searchEmpreiteiraId"]', { label: 'F IMM BRASIL LTDA' });
  await page.click('#botaoBuscar');
  await page.waitForSelector('a.color:has-text("ETAPA")', { timeout: 60000 });
  await aguardarTodasEtapasCarregadas(page);
}

const MAX_TENTATIVAS_REABRIR_ETAPA = 3;

// Garante que a tabela de livros da etapa DESTE livro está visível nesta
// aba antes de tentar clicar num livro dentro dela — o site recolhe a
// etapa a cada CANCELAR (ver fecharTelaDetalheMesmaPagina), então isso é
// esperado a cada livro processado, não uma falha. Como a fila agora
// mistura livros de etapas diferentes, essa checagem roda por livro (não
// mais uma vez só por etapa inteira).
async function garantirEtapaVisivel(etapaLink, tabelaAtual, rotulo, etapaNumero) {
  for (let tentativa = 0; tentativa < MAX_TENTATIVAS_REABRIR_ETAPA; tentativa++) {
    if (await tabelaAtual.isVisible().catch(() => false)) return true;
    log(
      `[Coleta Acomp]${rotulo} 🔄 Etapa '${etapaNumero}' recolhida — reabrindo ` +
        `(tentativa ${tentativa + 1}/${MAX_TENTATIVAS_REABRIR_ETAPA}).`,
    );
    await etapaLink.click().catch(() => {});
    await tabelaAtual.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  }
  return tabelaAtual.isVisible().catch(() => false);
}

// Abre a OS de um único livro (clique no link "número da OS"), extrai as
// UCs do detalhe e fecha a tela (popup ou mesma página). Extraído do fluxo
// original pra rodar por livro isolado em vez de dentro de um loop de
// etapa inteira.
async function abrirEExtrairOs({ page, linhaAlvo, cabecalhoAlvo, registros, rotulo, estadoDiagnostico }) {
  const linkOs = linhaAlvo.locator('td').nth(3).locator('a');
  let popup = null;
  let usouMesmaPagina = false;
  try {
    // waitForEvent('popup') precisa ser registrado ANTES do clique (senão
    // corre risco de perder o evento se o popup abrir rápido demais) — mas
    // isso deixa a promise "solta" rejeitando sozinha por timeout enquanto
    // o código ainda está no `await linkOs.click()`. `.catch(() => {})`
    // preventivo precisa estar em CADA nível (original, `.then()`, e a
    // combinação final) pra realmente eliminar o risco de unhandled
    // rejection — um catch só na promise original não bastou.
    const promPopup = page.waitForEvent('popup', { timeout: 20000 });
    promPopup.catch(() => {});
    const promMesmaPagina = page
      .getByText('DADOS DE EXECUÇÃO', { exact: false })
      .first()
      .waitFor({ timeout: 20000, state: 'visible' });
    promMesmaPagina.catch(() => {});

    // Promise.any (não race): resolve assim que QUALQUER uma tiver
    // sucesso, e só rejeita se as DUAS falharem.
    const esperaPopup = promPopup.then(p => ({ tipo: 'popup', p }));
    esperaPopup.catch(() => {});
    const esperaMesmaPagina = promMesmaPagina.then(() => ({ tipo: 'mesmaPagina' }));
    esperaMesmaPagina.catch(() => {});

    const combinada = Promise.any([esperaPopup, esperaMesmaPagina]);
    combinada.catch(() => {});

    const inicioReq = Date.now();
    log(`[Coleta Acomp]${rotulo} ⏱️ INÍCIO abrir OS livro '${cabecalhoAlvo.livro}' (etapa ${cabecalhoAlvo.etapa})`);

    await linkOs.click();
    const resultado = await combinada;

    if (resultado.tipo === 'popup') {
      popup = resultado.p;
      await popup.waitForSelector('#tabFixedHeader', { timeout: 15000 });
    } else {
      usouMesmaPagina = true;
      await page.waitForSelector('#tabFixedHeader', { timeout: 15000 });
    }

    const paginaDetalhe = popup || page;
    // A tabela de UCs pode popular as linhas de forma assíncrona depois de
    // #tabFixedHeader já existir — espera a contagem estabilizar antes de
    // extrair (ver aguardarTabelaEstabilizar).
    await aguardarTabelaEstabilizar(paginaDetalhe);
    const linhasUc = await extrairLinhasDetalheOs(paginaDetalhe);
    log(`[Coleta Acomp]${rotulo} ⏱️ FIM abrir OS livro '${cabecalhoAlvo.livro}' (${Date.now() - inicioReq}ms)`);
    for (const uc of linhasUc) {
      registros.push({ ...cabecalhoAlvo, ...uc });
    }
    if (linhasUc.length > 0) {
      log(
        `[Coleta Acomp]${rotulo} 📖 Livro '${cabecalhoAlvo.livro}' (etapa ${cabecalhoAlvo.etapa}) — ` +
          `${linhasUc.length} UCs coletadas.`,
      );
    } else {
      logWarn(`[Coleta Acomp]${rotulo} ⚠️ Livro '${cabecalhoAlvo.livro}' abriu a OS mas 0 UCs extraídas.`);
    }
  } catch (erroOs) {
    logErro(
      `[Coleta Acomp]${rotulo} ⚠️ Falha ao abrir OS do livro '${cabecalhoAlvo.livro}' (etapa ${cabecalhoAlvo.etapa}): ${erroOs.message}`,
    );
    if (!estadoDiagnostico.osSalvo) {
      estadoDiagnostico.osSalvo = true;
      await salvarDiagnostico(page, `${rotulo.replace(/[^\w-]/g, '_')}_os_${cabecalhoAlvo.livro}_falhou`);
    }
    // "All promises were rejected" (nem popup nem "DADOS DE EXECUÇÃO"
    // apareceram a tempo) não significa que o clique não teve efeito — a
    // navegação real pode só ter completado DEPOIS do timeout (rede lenta,
    // mais comum sob várias abas competindo pela mesma sessão). Poll de
    // até 10s (bem mais curto que os 20s do timeout original, só cobrindo
    // o "quase lá") em vez de uma checagem única.
    if (!popup && !usouMesmaPagina) {
      const textoExecucao = page.getByText('DADOS DE EXECUÇÃO', { exact: false }).first();
      for (let tentativa = 0; tentativa < 10 && !usouMesmaPagina; tentativa++) {
        const apareceuTarde = await textoExecucao.isVisible().catch(() => false);
        if (apareceuTarde) {
          usouMesmaPagina = true;
          break;
        }
        await page.waitForTimeout(1000);
      }
    }
  } finally {
    if (popup) {
      await popup.close().catch(() => {});
    } else if (usouMesmaPagina) {
      await fecharTelaDetalheMesmaPagina(page);
    }
  }
}

// Tenta trazer uma aba "cega" (sem nenhuma etapa visível) de volta ao
// estado funcional: renavega pra URL de Acompanhamento e refaz filtro +
// busca. Visto ao vivo que isso às vezes falha na primeira tentativa (o
// formulário de filtro não carrega, corpo da página vazio, mesmo depois do
// goto ter ido pra URL certa) — parece transitório (sobrecarga momentânea
// do servidor sob várias abas competindo pela mesma sessão), então tenta
// até 3 vezes com uma folga entre elas antes de desistir. Diagnóstico
// salvo só na última tentativa falha, e só uma vez por aba.
const MAX_TENTATIVAS_RECUPERAR_ABA = 3;

async function recuperarAba(page, rotulo, estadoDiagnostico) {
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_RECUPERAR_ABA; tentativa++) {
    await page.goto(URL_ACOMPANHAMENTO, { timeout: 60000 }).catch(erro => {
      logErro(`[Coleta Acomp]${rotulo} ⚠️ Falha ao renavegar (tentativa ${tentativa}/${MAX_TENTATIVAS_RECUPERAR_ABA}): ${erro.message}`);
    });
    try {
      await aplicarFiltroEBuscar(page);
      return; // sucesso — não precisa das próximas tentativas
    } catch (erro) {
      logErro(
        `[Coleta Acomp]${rotulo} ⚠️ Falha ao refazer a busca (tentativa ${tentativa}/${MAX_TENTATIVAS_RECUPERAR_ABA}): ${erro.message}`,
      );
      if (tentativa >= MAX_TENTATIVAS_RECUPERAR_ABA) {
        if (!estadoDiagnostico.recuperacaoSalvo) {
          estadoDiagnostico.recuperacaoSalvo = true;
          await salvarDiagnostico(page, `${rotulo.replace(/[^\w-]/g, '_')}_recuperacao_falhou`);
        }
        return;
      }
      await page.waitForTimeout(3000);
    }
  }
}

// Processa UM livro da fila compartilhada: localiza a etapa dele NA
// PRÓPRIA página do worker (cada aba carregou sua cópia da lista de forma
// independente), garante que a tabela dessa etapa está visível, localiza a
// linha certa por osId (não por índice nem por número do livro — ver
// extrairOsId) e abre a OS. Retorna 'ok' em caso de sucesso, ou um motivo
// curto de falha pra o worker decidir se devolve o livro pra fila.
async function processarLivro({ page, alvo, registros, rotulo, estadoDiagnostico }) {
  const etapas = page.locator('a.color:has-text("ETAPA")');
  let textos = await etapas.allInnerTexts();
  let indice = textos.findIndex(t => numeroDaEtapa(t) === alvo.etapa);

  if (indice === -1) {
    // Pode ser que ESTA aba especificamente ainda não tenha terminado de
    // rolar até o fim quando este livro foi retirado da fila.
    log(
      `[Coleta Acomp]${rotulo} 🔄 Etapa '${alvo.etapa}' (livro '${alvo.livro}') não encontrada ainda nesta ` +
        'aba — rolando mais pra procurar.',
    );
    await aguardarTodasEtapasCarregadas(page);
    textos = await etapas.allInnerTexts();
    indice = textos.findIndex(t => numeroDaEtapa(t) === alvo.etapa);
  }

  if (indice === -1 && textos.length === 0) {
    // A aba pode ter ficado PRESA na tela de detalhe de uma OS anterior, ou
    // o formulário de filtro simplesmente não carregou (sobrecarga
    // momentânea do servidor sob várias abas competindo pela mesma sessão).
    logWarn(
      `[Coleta Acomp]${rotulo} 🔁 Nenhuma etapa na página (aba provavelmente presa em outra tela) — ` +
        'renavegando e refazendo busca.',
    );
    await recuperarAba(page, rotulo, estadoDiagnostico);
    textos = await etapas.allInnerTexts();
    indice = textos.findIndex(t => numeroDaEtapa(t) === alvo.etapa);
  }

  if (indice === -1) return 'etapa_nao_encontrada';

  const etapaLink = etapas.nth(indice);
  const tabelaAtual = tabelaDaEtapa(etapaLink);
  const visivel = await garantirEtapaVisivel(etapaLink, tabelaAtual, rotulo, alvo.etapa);
  if (!visivel) return 'etapa_nao_abriu';

  const linhas = tabelaAtual.locator('tbody tr');
  const total = await linhas.count();
  let linhaAlvo = null;
  for (let i = 0; i < total; i++) {
    const linkOs = linhas.nth(i).locator('td').nth(3).locator('a');
    if ((await linkOs.count()) === 0) continue;
    const href = await linkOs.getAttribute('href');
    if (extrairOsId(href) === alvo.osId) {
      linhaAlvo = linhas.nth(i);
      break;
    }
  }

  if (!linhaAlvo) return 'linha_nao_encontrada';

  await abrirEExtrairOs({ page, linhaAlvo, cabecalhoAlvo: alvo, registros, rotulo, estadoDiagnostico });
  return 'ok';
}

// Cada worker (1 por aba) consome LIVROS (não mais etapas inteiras) da
// fila COMPARTILHADA (`filaLivros.shift()` — síncrono, sem race condition
// real mesmo com vários workers "concorrentes", já que JS processa um
// passo de cada vez) até ela esvaziar. Como cada livro só existe UMA vez
// no array (montado numa única leitura no início — ver
// coletarDadosAcompanhamento), nenhum livro pode ser processado duas vezes
// por abas diferentes, e nenhuma etapa grande prende uma aba inteira
// enquanto outras abas ficam ociosas — o problema real observado com a
// fila por etapa: uma etapa com poucos livros terminava rápido e a aba
// ficava esperando, enquanto uma etapa com 100+ livros segurava outra aba
// sozinha.
//
// `tentativasPorLivro` (Map compartilhado entre workers, chaveado por
// osId) limita quantas vezes um livro pode ser devolvido à fila por falha
// — sem isso, um livro que genuinamente não é localizável (osId extraído
// errado, OS removida do portal entre a montagem da fila e a tentativa)
// ficaria sendo re-adicionado pra sempre, travando a coleta.
const MAX_TENTATIVAS_LOCALIZAR_LIVRO = 5;

async function worker(page, rotulo, filaLivros, registros, tentativasPorLivro) {
  const estadoDiagnostico = { osSalvo: false, etapaSalvo: false };
  let processados = 0;

  while (filaLivros.length > 0) {
    const alvo = filaLivros.shift();
    if (!alvo) break;

    let resultado;
    try {
      resultado = await processarLivro({ page, alvo, registros, rotulo, estadoDiagnostico });
    } catch (erro) {
      logErro(
        `[Coleta Acomp]${rotulo} ❌ Livro '${alvo.livro}' (etapa ${alvo.etapa}) falhou de forma inesperada: ${erro.message}`,
      );
      resultado = 'erro_inesperado';
    }

    if (resultado === 'ok') {
      processados++;
      continue;
    }

    const tentativas = (tentativasPorLivro.get(alvo.osId) ?? 0) + 1;
    tentativasPorLivro.set(alvo.osId, tentativas);
    if (tentativas >= MAX_TENTATIVAS_LOCALIZAR_LIVRO) {
      logErro(
        `[Coleta Acomp]${rotulo} ❌ Livro '${alvo.livro}' (etapa ${alvo.etapa}) falhou ${tentativas}x ` +
          `(${resultado}) — desistindo dele pra não travar a coleta.`,
      );
      if (!estadoDiagnostico.etapaSalvo) {
        estadoDiagnostico.etapaSalvo = true;
        await salvarDiagnostico(page, `${rotulo.replace(/[^\w-]/g, '_')}_livro_${alvo.livro}_desistiu`);
      }
      continue;
    }

    logWarn(
      `[Coleta Acomp]${rotulo} ⚠️ Livro '${alvo.livro}' (etapa ${alvo.etapa}) — ${resultado} ` +
        `(tentativa ${tentativas}/${MAX_TENTATIVAS_LOCALIZAR_LIVRO}) — devolvendo pra fila.`,
    );
    filaLivros.push(alvo);
  }
  log(`[Coleta Acomp]${rotulo} 🏁 Fila de livros esgotada — ${processados} livro(s) processado(s) nesta aba — encerrada.`);
}

async function coletarDadosAcompanhamento() {
  // COPEL_HEADLESS=false abre o Chromium com janela visível — útil pra
  // acompanhar ao vivo o que o site está fazendo durante uma investigação;
  // default headless (sem janela), que é o certo pro job rodando sozinho o
  // dia inteiro em produção.
  const headless = process.env.COPEL_HEADLESS !== 'false';
  const browser = await chromium.launch({ headless, slowMo: headless ? 100 : 300 });
  // Um `browserContext` explícito, compartilhado por TODAS as abas — é o
  // que faz elas dividirem a mesma sessão (cookies), sem precisar logar de
  // novo em cada uma. `browser.newPage()` direto criaria um context NOVO E
  // ISOLADO a cada chamada (sem cookies compartilhados), recaindo no mesmo
  // problema de sessão única por usuário que o lock entre Coleta Acomp e
  // Massivas já corrige em outro nível (ver copelSessaoLock.js) — aqui
  // dentro da MESMA coleta, ter várias sessões brigando pelo mesmo login
  // seria exatamente esse problema, só que multiplicado por N abas.
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    log('[Coleta Acomp] 🔐 Fazendo login...');
    await page.goto(URL_ACOMPANHAMENTO, { timeout: 60000 });
    await page.fill("input[name='j_username']", process.env.COPEL_USERNAME);
    await page.fill("input[name='j_password']", process.env.COPEL_PASSWORD);
    await page.click("input[type='submit'].lgn_btn");

    try {
      await page.waitForSelector('a.submenu', { timeout: 60000 });
    } catch (erroLogin) {
      await salvarDiagnostico(page, 'login_falhou');
      throw erroLogin;
    }
    log('[Coleta Acomp] ✅ Login realizado com sucesso.');

    log('[Coleta Acomp] 🔎 Acessando aba Acompanhamento...');
    await page.click("a.submenu:has-text('acompanhamento')");
    await aplicarFiltroEBuscar(page);

    // A página, depois da busca, já carrega TODAS as etapas E todos os
    // livros de cada uma no DOM de uma vez só — o clique em "ETAPA N - (M)"
    // só alterna a visibilidade (ShowHide()) de uma tabela que já existe,
    // não busca dado novo (confirmado com o HTML real da página). Por isso
    // dá pra ler todos os livros de todas as etapas aqui, de uma vez, sem
    // precisar clicar/expandir etapa por etapa.
    const etapasLocator = page.locator('a.color:has-text("ETAPA")');
    const totalEtapas = await etapasLocator.count();
    const filaLivros = [];
    for (let i = 0; i < totalEtapas; i++) {
      const etapaLink = etapasLocator.nth(i);
      const etapaTexto = await etapaLink.innerText();
      const etapaNumero = numeroDaEtapa(etapaTexto);
      if (!etapaNumero) continue;
      const livrosDaEtapa = await extrairLivrosDaEtapa(etapaLink, etapaNumero);
      filaLivros.push(...livrosDaEtapa);
    }
    log(`[Coleta Acomp] 📋 ${filaLivros.length} livro(s) encontrado(s) em ${totalEtapas} etapa(s).`);

    if (filaLivros.length === 0) {
      log('[Coleta Acomp] ✅ Nenhum livro para processar.');
      return [];
    }

    // Não abre mais abas do que livros existem — sem sentido ter 5 abas
    // ociosas pra processar 2 livros.
    const paralelismoConfigurado = Math.max(1, parseInt(process.env.COPEL_PARALELISMO_ACOMP || '8', 10));
    const totalAbas = Math.min(paralelismoConfigurado, filaLivros.length);
    log(`[Coleta Acomp] 🧵 Abrindo ${totalAbas} aba(s) em paralelo para processar os livros.`);

    const paginas = [page];
    for (let i = 1; i < totalAbas; i++) {
      const novaPagina = await context.newPage();
      await novaPagina.goto(URL_ACOMPANHAMENTO, { timeout: 60000 });
      await aplicarFiltroEBuscar(novaPagina);
      paginas.push(novaPagina);
    }

    const registros = [];
    const tentativasPorLivro = new Map();
    await Promise.all(
      paginas.map((pg, i) => worker(pg, ` [Aba ${i + 1}/${totalAbas}]`, filaLivros, registros, tentativasPorLivro)),
    );

    // Fecha só as abas extras — a principal fecha junto com o browser no
    // finally.
    await Promise.all(paginas.slice(1).map(p => p.close().catch(() => {})));

    log('[Coleta Acomp] ✅ Extração concluída.');
    return registros;
  } finally {
    await browser.close();
  }
}

module.exports = { coletarDadosAcompanhamento };
