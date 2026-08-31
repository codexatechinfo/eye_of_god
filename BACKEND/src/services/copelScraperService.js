const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { log, logWarn, logErro } = require('../utils/logTempo');

const DIR_DIAGNOSTICO = path.join(__dirname, '..', '..', 'diagnosticos');
const URL_ACOMPANHAMENTO = 'https://www.copel.com/lis/acompanhamentoAction.do#';

// Teto de duração pro processamento de livros de um ciclo — Coleta Acomp e
// Massivas nunca logam ao mesmo tempo (copelSessaoLock.js): um ciclo que
// trava ou degrada (já aconteceu, um caso real levou ~38min pra completar)
// deixa o OUTRO job inteiro bloqueado esperando essa exclusão liberar. Sem
// teto, um ciclo genuinamente travado prenderia Massivas indefinidamente.
// Ao estourar, aborta com o que já foi coletado até agora (não descarta
// nada, só para de esperar os livros restantes) — o próximo ciclo (5s
// depois, ver coletaJob.js) recomeça do zero e pega o que ficou de fora.
const TIMEOUT_CICLO_MIN = Math.max(5, parseInt(process.env.COPEL_TIMEOUT_CICLO_MIN || '45', 10));
const TIMEOUT_CICLO_MS = TIMEOUT_CICLO_MIN * 60 * 1000;

// slowMo adaptativo ENTRE ciclos — não dentro de um ciclo, porque o
// Playwright não deixa trocar `slowMo` depois que o browser já foi lançado
// (`chromium.launch()` fixa o valor pro browser inteiro). Duas tentativas
// anteriores de reduzir o atraso (slowMo=0 puro, depois um espaçamento
// cirúrgico só no disparo de abertura de livro) foram testadas ao vivo e
// revertidas — as duas fizeram a taxa de "sessão perdida" disparar (ver
// Adendos desta ADR). Em vez de adivinhar um valor fixo, cada ciclo agora
// MEDE sua própria taxa de falha (sessão perdida + falha ao abrir OS,
// contando toda tentativa, inclusive retentativas) e ajusta o slowMo do
// PRÓXIMO ciclo: sobe quando a taxa está alta (portal mais instável hoje),
// desce quando está baixa (portal mais estável) — sem precisar de ajuste
// manual no .env. Começa no único valor com resultado bom já comprovado ao
// vivo (100ms). Estado em memória do processo (não persiste em disco/banco
// — reinício do servidor volta pro valor inicial, que é seguro por
// definição).
const SLOWMO_MIN_MS = 30;
const SLOWMO_MAX_MS = 500;
const SLOWMO_INICIAL_MS = Math.max(SLOWMO_MIN_MS, parseInt(process.env.COPEL_SLOWMO_INICIAL_MS || '100', 10));
// Acima disso, sobe o atraso pro próximo ciclo; abaixo disso, desce.
const TAXA_FALHA_ALTA = 0.15;
const TAXA_FALHA_BAIXA = 0.05;
let slowMoAdaptativoMs = SLOWMO_INICIAL_MS;

// Chamado no fim de cada ciclo, depois que os workers terminam/o timeout
// vence — ajusta `slowMoAdaptativoMs` pro PRÓXIMO ciclo usar. Amostra
// pequena demais (ex.: ciclo sem nenhum livro pra processar) não ajusta
// nada, pra não reagir a ruído estatístico.
function ajustarSlowMoAdaptativo(estatisticas) {
  const total = estatisticas.sucessos + estatisticas.falhas;
  if (total < 10) return;

  const taxaFalha = estatisticas.falhas / total;
  const anterior = slowMoAdaptativoMs;

  if (taxaFalha > TAXA_FALHA_ALTA) {
    slowMoAdaptativoMs = Math.min(SLOWMO_MAX_MS, Math.round(slowMoAdaptativoMs * 1.5));
  } else if (taxaFalha < TAXA_FALHA_BAIXA) {
    slowMoAdaptativoMs = Math.max(SLOWMO_MIN_MS, Math.round(slowMoAdaptativoMs * 0.8));
  }

  const percentual = (taxaFalha * 100).toFixed(1);
  if (slowMoAdaptativoMs !== anterior) {
    log(
      `[Coleta Acomp] 🎚️ slowMo adaptativo ajustado: ${anterior}ms → ${slowMoAdaptativoMs}ms ` +
        `(taxa de falha do ciclo: ${percentual}%, ${estatisticas.falhas}/${total} tentativas) — vale a partir do PRÓXIMO ciclo.`,
    );
  } else {
    log(`[Coleta Acomp] 🎚️ slowMo adaptativo mantido em ${slowMoAdaptativoMs}ms (taxa de falha do ciclo: ${percentual}%, ${estatisticas.falhas}/${total} tentativas).`);
  }
}

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
  // Não espera nada ficar visível aqui: a etapa pode voltar RECOLHIDA
  // depois de CANCELAR, mas isso deixou de importar — abrirEExtrairOs()
  // não depende mais de a linha do livro estar visível pra abrir a
  // próxima OS (chama a função update() do site direto via JS).
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

// Extrai id da OS e URL de destino a partir do href
// `javascript:update('12105126','editarTarefasLeituraAction.do?...')` do
// link "número da OS" de cada linha. O osId é o identificador globalmente
// único de cada livro/OS na página (diferente do "número do livro" exibido,
// que é só um rótulo e pode não ser único entre etapas) — usado como chave
// da fila de livros: como cada osId só é extraído UMA vez ao montar a fila,
// não existe forma de duas abas processarem o mesmo livro duas vezes.
// A URL é capturada linha a linha (não fixada como constante) porque é o
// SEGUNDO argumento que o próprio site passa pra update() em cada link —
// mesmo que toda amostra observada até agora use sempre a mesma URL, nada
// garante que TODO tipo de OS (ex.: releitura, alguma situação especial)
// use a mesma; ler direto do href de cada linha elimina essa suposição sem
// custo nenhum (o href já é lido de qualquer forma pra tirar o osId).
function extrairDadosOs(href) {
  const match = String(href ?? '').match(/update\('(\d+)'\s*,\s*'([^']*)'\)/);
  return match ? { osId: match[1], url: match[2] } : null;
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
    const dadosOs = extrairDadosOs(href);
    if (!dadosOs) continue;
    livros.push({ ...dadosOs, ...cabecalho });
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

// Abre a OS de um único livro chamando DIRETO a função JS `update(osId,url)`
// que o próprio site define (é literalmente tudo que o link "número da OS"
// faz: href="javascript:update('12105126','editarTarefasLeituraAction.do?...)").
// Como o osId já foi extraído ao montar a fila (ver extrairLivrosDaEtapa) e
// a função + o formulário que ela usa (`document.forms[0]`) já existem na
// página independente de qual etapa está expandida, não precisa localizar
// a etapa nem clicar em nada pra revelar a linha — `.click()` do Playwright
// é que exige visibilidade, chamar a função via `page.evaluate()` não.
// Elimina de vez o ciclo de "etapa recolhida — reabrindo" que só existia
// por essa exigência de visibilidade, não por falta de dado carregado.
async function abrirEExtrairOs({ page, alvo, registros, rotulo, estadoDiagnostico }) {
  let popup = null;
  let usouMesmaPagina = false;
  try {
    // waitForEvent('popup') precisa ser registrado ANTES de disparar a
    // navegação (senão corre risco de perder o evento se o popup abrir
    // rápido demais) — mas isso deixa a promise "solta" rejeitando sozinha
    // por timeout enquanto o código ainda está no `await page.evaluate(...)`.
    // `.catch(() => {})` preventivo precisa estar em CADA nível (original,
    // `.then()`, e a combinação final) pra realmente eliminar o risco de
    // unhandled rejection — um catch só na promise original não bastou.
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
    log(`[Coleta Acomp]${rotulo} ⏱️ INÍCIO abrir OS livro '${alvo.livro}' (etapa ${alvo.etapa})`);

    // Mesmo efeito de clicar no link, sem exigir que a linha esteja
    // visível: chama a função global que o href="javascript:..." chamaria,
    // com a URL exata que o próprio site definiu pra ESTE livro (extraída
    // do href na montagem da fila — ver extrairDadosOs), não uma constante
    // genérica pra todos.
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
    // A tabela de UCs pode popular as linhas de forma assíncrona depois de
    // #tabFixedHeader já existir — espera a contagem estabilizar antes de
    // extrair (ver aguardarTabelaEstabilizar).
    await aguardarTabelaEstabilizar(paginaDetalhe);
    const linhasUc = await extrairLinhasDetalheOs(paginaDetalhe);
    log(`[Coleta Acomp]${rotulo} ⏱️ FIM abrir OS livro '${alvo.livro}' (${Date.now() - inicioReq}ms)`);
    for (const uc of linhasUc) {
      registros.push({ ...alvo, ...uc });
    }
    if (linhasUc.length > 0) {
      log(
        `[Coleta Acomp]${rotulo} 📖 Livro '${alvo.livro}' (etapa ${alvo.etapa}) — ` +
          `${linhasUc.length} UCs coletadas.`,
      );
    } else {
      logWarn(`[Coleta Acomp]${rotulo} ⚠️ Livro '${alvo.livro}' abriu a OS mas 0 UCs extraídas.`);
    }
    return 'ok';
  } catch (erroOs) {
    logErro(`[Coleta Acomp]${rotulo} ⚠️ Falha ao abrir OS do livro '${alvo.livro}' (etapa ${alvo.etapa}): ${erroOs.message}`);
    if (!estadoDiagnostico.osSalvo) {
      estadoDiagnostico.osSalvo = true;
      await salvarDiagnostico(page, `${rotulo.replace(/[^\w-]/g, '_')}_os_${alvo.livro}_falhou`);
    }
    // "All promises were rejected" (nem popup nem "DADOS DE EXECUÇÃO"
    // apareceram a tempo) não significa que a navegação não teve efeito —
    // ela pode só ter completado DEPOIS do timeout (rede lenta, mais comum
    // sob várias abas competindo pela mesma sessão). Poll de até 10s (bem
    // mais curto que os 20s do timeout original, só cobrindo o "quase lá")
    // em vez de uma checagem única.
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
    return 'falhou_abrir_os';
  } finally {
    if (popup) {
      await popup.close().catch(() => {});
    } else if (usouMesmaPagina) {
      // Precisa ser à prova de erro: uma exceção aqui dentro do `finally`
      // descarta silenciosamente o `return 'ok'` do `try` acima — mesmo com
      // `linhasUc` já extraída e empurrada em `registros` com sucesso. O
      // worker então trata essa extração (que JÁ funcionou) como falha e
      // devolve o livro pra fila; na retentativa bem-sucedida, as MESMAS UCs
      // são extraídas de novo, duplicando linhas (com `codigo` podendo
      // divergir entre as cópias, já que minutos se passam entre uma
      // tentativa e outra). Causa raiz real de um bug em produção: todo
      // livro coletado saía com ~20% de UCs duplicadas. Ver ADR 0018 Adendo 18.
      await fecharTelaDetalheMesmaPagina(page).catch(async erroFechar => {
        logWarn(
          `[Coleta Acomp]${rotulo} ⚠️ Falha ao fechar tela de detalhe do livro '${alvo.livro}': ` +
            `${erroFechar.message} — UCs já extraídas com sucesso, seguindo mesmo assim. ` +
            'Renavegando pra lista pra não deixar esta aba presa na tela de detalhe.',
        );
        await page.goto(URL_ACOMPANHAMENTO, { timeout: 60000 }).catch(() => {});
        await aplicarFiltroEBuscar(page).catch(() => {});
      });
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

// Checa rapidamente se a página está num estado utilizável (a função
// update() e o formulário principal existem) ANTES de tentar abrir a OS —
// mais barato e mais rápido que descobrir isso só depois de um timeout de
// 20s esperando popup/"DADOS DE EXECUÇÃO". Mesmo sintoma já documentado no
// ADR 0020 (URL certa, mas corpo da página só com o menu, sem formulário)
// vira `false` aqui, sem precisar de nenhuma tentativa de interação.
async function paginaUtilizavel(page) {
  return page
    .evaluate(() => typeof window.update === 'function' && document.forms.length > 0)
    .catch(() => false);
}

// Processa UM livro da fila compartilhada: confirma que a página desta aba
// está num estado saudável e delega a abertura da OS pra abrirEExtrairOs
// (que chama update() direto — não precisa mais localizar/expandir a etapa
// nem achar a linha certa na tabela, ver comentário lá). Retorna 'ok' em
// sucesso, 'sessao_perdida' se a página precisou ser recuperada (o worker
// devolve o livro pra fila pra tentar de novo), ou 'falhou_abrir_os' se a
// OS em si não abriu a tempo (não é retentado — mesmo comportamento de
// antes: um livro cuja OS falha ao abrir é abandonado, não fica em loop).
async function processarLivro({ page, alvo, registros, rotulo, estadoDiagnostico }) {
  if (!(await paginaUtilizavel(page))) {
    logWarn(
      `[Coleta Acomp]${rotulo} 🔁 Sessão/busca perdida nesta aba (livro '${alvo.livro}') — ` +
        'renavegando e refazendo busca.',
    );
    await recuperarAba(page, rotulo, estadoDiagnostico);
    return 'sessao_perdida';
  }

  return abrirEExtrairOs({ page, alvo, registros, rotulo, estadoDiagnostico });
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
// (sessão perdida na aba, ou a OS não abriu a tempo) — sem isso, um livro
// que genuinamente nunca funciona (OS removida do portal entre a montagem
// da fila e a tentativa) ficaria sendo re-adicionado pra sempre, travando
// a coleta. Diferença de comportamento em relação à versão anterior: antes
// uma falha ao abrir a OS abandonava o livro na hora (sem retry); agora
// esse tipo de falha também é retentado até o limite, já que o mecanismo
// de retry passou a existir de qualquer forma pra cobrir sessão perdida —
// mais resiliente a timeouts transitórios sob carga, sem custo extra.
//
// `estatisticasCiclo` (objeto compartilhado entre workers, `{sucessos,
// falhas}`) conta TODA tentativa de abrir livro neste ciclo — usado só no
// fim do ciclo por ajustarSlowMoAdaptativo, não influencia nenhuma decisão
// dentro do worker em si.
const MAX_TENTATIVAS_PROCESSAR_LIVRO = 5;

async function worker(page, rotulo, filaLivros, registros, tentativasPorLivro, estatisticasCiclo) {
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

    // Conta TODA tentativa (inclusive retentativa), não só o resultado
    // final por livro — é a mesma métrica usada pra medir a taxa de
    // colisão de sessão ao vivo (ver ajustarSlowMoAdaptativo, topo do
    // arquivo): cada tentativa é uma chance de colidir com outra aba.
    if (resultado === 'ok') {
      estatisticasCiclo.sucessos++;
    } else {
      estatisticasCiclo.falhas++;
    }

    if (resultado === 'ok') {
      processados++;
      continue;
    }

    const tentativas = (tentativasPorLivro.get(alvo.osId) ?? 0) + 1;
    tentativasPorLivro.set(alvo.osId, tentativas);
    if (tentativas >= MAX_TENTATIVAS_PROCESSAR_LIVRO) {
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
        `(tentativa ${tentativas}/${MAX_TENTATIVAS_PROCESSAR_LIVRO}) — devolvendo pra fila.`,
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
  //
  // HISTÓRICO do slowMo em headless — duas tentativas de tirar, as duas
  // revertidas depois de testar ao vivo: 1) slowMo=0 puro → taxa de
  // "sessão perdida" disparou pra quase 1 evento por livro; 2) trocar por
  // um espaçamento cirúrgico só no instante do `update()` (abrir livro),
  // não em toda ação → mesmo resultado ruim (~1:1 perdas/sucessos num
  // ciclo real de ~6min, 54 perdas contra 51 sucessos) — ou seja, a
  // colisão de sessão não está concentrada só nesse instante específico,
  // é mais ampla do que a hipótese assumia. Terceira tentativa: em vez de
  // um valor fixo (adivinhado ou travado no último bom), `slowMoAdaptativoMs`
  // (topo do arquivo) — ajustado ciclo a ciclo pela taxa de falha real
  // observada, começando no valor comprovado (100ms). Não muda DENTRO do
  // ciclo (Playwright não permite), só entre um ciclo e o próximo.
  const headless = process.env.COPEL_HEADLESS !== 'false';
  const browser = await chromium.launch({ headless, slowMo: headless ? slowMoAdaptativoMs : 300 });
  // Um `browserContext` explícito, compartilhado por TODAS as abas — é o
  // que faz elas dividirem a mesma sessão (cookies), sem precisar logar de
  // novo em cada uma. `browser.newPage()` direto criaria um context NOVO E
  // ISOLADO a cada chamada (sem cookies compartilhados), recaindo no mesmo
  // problema de sessão única por usuário que o lock entre Coleta Acomp e
  // Massivas já corrige em outro nível (ver copelSessaoLock.js) — aqui
  // dentro da MESMA coleta, ter várias sessões brigando pelo mesmo login
  // seria exatamente esse problema, só que multiplicado por N abas.
  const context = await browser.newContext();

  // Bloqueia imagem/CSS/fonte/mídia — a extração só lê tabela/formulário
  // (texto e atributos via evaluate), nunca depende do visual renderizado
  // (não há mais nenhum `.click()` condicionado a elemento visível, ver
  // ADR 0020). Registrado no CONTEXT (não por página) pra valer em toda
  // aba nova criada a partir dele, sem precisar repetir por aba. Reduz
  // tráfego e tempo de carregamento por navegação — importa mais ainda com
  // várias abas competindo pela mesma sessão/rede. Testado ao vivo: cada
  // abertura de OS carrega ~94 recursos de rede (nenhum cache entre livros
  // na mesma aba, mesmo formulário/URL — o servidor não devolve 304 em
  // nada disso), então esse bloqueio vale em TODO livro aberto, não só uma
  // vez. Também bloqueia scripts de `/tags/calendar/` (widget de
  // date-picker, sem relação com #tabFixedHeader, a tabela que extraímos)
  // — testado ao vivo que a extração continua correta sem eles (~94 → ~43
  // requisições por livro). `jquery.min.js`/`jquery.fixedheadertable.js`
  // NÃO são bloqueados de propósito: o plugin `fixedheadertable` parece
  // ser aplicado exatamente na tabela `#tabFixedHeader`, então bloqueá-los
  // é risco real de quebrar como a tabela se monta.
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
    // osId é o identificador globalmente único de cada livro/OS (ver
    // extrairDadosOs) — garante que a MESMA OS nunca entra duas vezes na
    // fila, mesmo que a tabela de alguma etapa tenha uma linha repetida
    // (o DOM já demonstrou anomalias antes, ver ADR 0020) ou que a mesma OS
    // apareça listada sob mais de uma etapa por algum motivo do portal. Sem
    // essa garantia na ORIGEM da fila, um livro duplicado aqui vira um
    // livro processado duas vezes por abas diferentes — duas extrações
    // completas das mesmas UCs, sem nenhuma constraint no banco pra barrar
    // isso na importação (contr_execucao_leitura não tem UNIQUE além do id
    // surrogate).
    const osIdsVistos = new Set();
    let duplicadosDescartados = 0;
    for (let i = 0; i < totalEtapas; i++) {
      const etapaLink = etapasLocator.nth(i);
      const etapaTexto = await etapaLink.innerText();
      const etapaNumero = numeroDaEtapa(etapaTexto);
      if (!etapaNumero) continue;
      const livrosDaEtapa = await extrairLivrosDaEtapa(etapaLink, etapaNumero);
      for (const livro of livrosDaEtapa) {
        if (osIdsVistos.has(livro.osId)) {
          duplicadosDescartados++;
          continue;
        }
        osIdsVistos.add(livro.osId);
        filaLivros.push(livro);
      }
    }
    if (duplicadosDescartados > 0) {
      logWarn(`[Coleta Acomp] ⚠️ ${duplicadosDescartados} livro(s) com osId repetido descartado(s) ao montar a fila (evita processar/importar a mesma OS duas vezes).`);
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
    // Sucessos/falhas de TODA tentativa de abrir livro neste ciclo (não só
    // o resultado final por livro) — usado por ajustarSlowMoAdaptativo no
    // fim do ciclo, pra decidir o slowMo do PRÓXIMO ciclo.
    const estatisticasCiclo = { sucessos: 0, falhas: 0 };
    const trabalho = Promise.all(
      paginas.map((pg, i) => worker(pg, ` [Aba ${i + 1}/${totalAbas}]`, filaLivros, registros, tentativasPorLivro, estatisticasCiclo)),
    );
    // Se algum worker escapar do try/catch interno (não deveria, mas é
    // "só" uma rede de segurança) DEPOIS do timeout já ter vencido a corrida
    // abaixo, essa rejeição não teria mais ninguém esperando por ela —
    // sem este catch preventivo, viraria unhandled rejection.
    trabalho.catch(() => {});

    const timeoutCiclo = new Promise(resolve => setTimeout(() => resolve('timeout'), TIMEOUT_CICLO_MS));
    const resultado = await Promise.race([trabalho.then(() => 'concluido'), timeoutCiclo]);

    if (resultado === 'timeout') {
      logErro(
        `[Coleta Acomp] ⏱️ Ciclo excedeu ${TIMEOUT_CICLO_MIN}min de processamento de livros — ` +
          `abortando com ${registros.length} registro(s) já coletado(s) até agora (fila ainda tinha ` +
          `${filaLivros.length} livro(s) pendente(s)). O próximo ciclo recomeça do zero.`,
      );
    }

    // Fecha só as abas extras — a principal fecha junto com o browser no
    // finally. Se o timeout venceu a corrida, algum worker pode ainda estar
    // no meio de uma operação numa dessas páginas — fechar aqui e o browser
    // inteiro logo depois (finally) é o que realmente interrompe ele.
    await Promise.all(paginas.slice(1).map(p => p.close().catch(() => {})));

    ajustarSlowMoAdaptativo(estatisticasCiclo);

    log('[Coleta Acomp] ✅ Extração concluída.');
    return registros;
  } finally {
    await browser.close();
  }
}

module.exports = { coletarDadosAcompanhamento };
