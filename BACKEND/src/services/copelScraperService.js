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
// aplicados via AJAX), deixando os livros seguintes da mesma etapa
// inacessíveis/errados. "CANCELAR" é o mecanismo que o próprio site
// oferece pra fechar a tela e devolve a lista no estado certo. Fallback
// pra goBack() só se o botão não existir.
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
  // Não espera a tabela ficar visível aqui: o Adendo 7 já confirmou (com
  // diagnóstico real) que depois de CANCELAR a etapa quase sempre volta
  // RECOLHIDA e só reaparece quando alguém reclica no link da etapa — não
  // sozinha. Um waitFor({state:'visible'}) aqui esperava, na prática, os
  // 15s inteiros do timeout TODA VEZ (silenciado por .catch, sem log nenhum)
  // antes de seguir em frente — 15s mortos por livro processado via "mesma
  // página" (o caso mais comum). garantirEtapaVisivel(), chamada no início
  // da próxima volta do loop de livros, já cuida de checar visibilidade e
  // reclicar ativamente se preciso — esperar aqui era trabalho duplicado e
  // mais lento (espera passiva por algo que só um clique ativo resolve).
}

// Lê o cabeçalho (etapa/localidade/livro/...) e o número do livro de uma
// linha da tabela de livros. Retorna null se a linha estiver vazia (sem
// nenhum dado — acontece em linhas de rodapé/separador).
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
// id="item" (confirmado no print do usuário: várias tabelas empilhadas na
// mesma página, uma por etapa, cada uma com seu cabeçalho "ETAPA N - (M)"
// acima). Um seletor CSS `#item` sempre resolve pra PRIMEIRA ocorrência
// desse id no documento — foi a causa real de um bug ao vivo: depois de
// processar a etapa 15 e abrir a etapa 16, o código continuava clicando
// nos livros da etapa 15 (a primeira tabela #item do DOM), porque nunca
// escopava a busca pra tabela da etapa certa. Usa XPath relativo ao link
// da etapa ("following::table[@id='item'][1]" — a primeira tabela #item
// que aparece DEPOIS do link no documento) em vez de um seletor global.
function tabelaDaEtapa(etapaLink) {
  return etapaLink.locator('xpath=following::table[@id="item"][1]');
}

// A lista de etapas da aba Acompanhamento carrega de forma "preguiçosa": o
// usuário confirmou que todas as etapas já estão disponíveis, mas só
// aparecem no DOM conforme a página rola pra baixo — o mesmo processo manual
// de antes do scraper existir. Sem isso, o loop de etapas parava cedo (ex.:
// achava que só existiam 18 etapas quando na verdade havia muitas mais mais
// abaixo) porque `count()` só enxerga o que já foi renderizado.
//
// Dois ajustes em cima da versão original (Adendo 13 da ADR 0018), depois de
// a versão paralelizada (ADR 0020) ter montado a fila de etapas incompleta —
// só 2 de N: 1) rola em PASSOS (altura de uma janela por vez), não num salto
// direto pro fim (`scrollTo(0, scrollHeight)`) — se o carregamento do
// próximo lote depende de a rolagem "passar" pelos itens já carregados (ex.:
// intersection observer no fim da lista atual), pular direto pro fim pode
// não disparar o gatilho certo. 2) exige 4 leituras estáveis seguidas (não
// 2) com mais tempo entre elas — no fluxo sequencial antigo essa função
// era chamada de novo a cada etapa processada, dando várias chances ao
// longo de minutos; aqui só há UMA chance antes de montar a fila
// definitiva, então precisa ser mais rigorosa antes de decidir que acabou.
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
// coordenarAbas mais abaixo: cada aba carrega sua PRÓPRIA cópia da lista,
// de forma independente, então o texto completo pode divergir ligeiramente
// entre elas mesmo sendo a mesma etapa).
function numeroDaEtapa(texto) {
  const match = String(texto ?? '').match(/ETAPA\s+(\d+)/i);
  return match ? match[1] : null;
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

// Processa TODOS os livros de uma etapa já aberta (clique já feito antes de
// chamar) — extraído do loop original pra poder rodar em qualquer `page`,
// permitindo que várias abas processem etapas diferentes em paralelo (ver
// coletarDadosAcompanhamento). `estadoDiagnostico` é um objeto mutável
// {osSalvo, etapaSalvo} — um por ABA (worker), não global: cada aba só
// salva 1 diagnóstico de cada categoria por ela mesma, evitando spam de
// screenshots sem perder o sinal quando várias abas falham por motivos
// diferentes ao mesmo tempo.
async function processarEtapa({ page, etapaLink, etapa, registros, rotulo, estadoDiagnostico }) {
  log(`[Coleta Acomp]${rotulo} ➡️ Processando etapa: ${etapa}`);
  await etapaLink.click();
  // Nada de tempo fixo: espera a tabela de livros DESTA etapa (não
  // qualquer #item — ver tabelaDaEtapa) ficar visível. Isso já é o
  // sinal certo — um waitForLoadState('networkidle') extra só atrasava
  // sem necessidade (ver comentário em fecharTelaDetalheMesmaPagina).
  const tabelaAtual = tabelaDaEtapa(etapaLink);
  await tabelaAtual.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});

  const totalLivrosInicial = await tabelaAtual.locator('tbody tr').count();
  log(`[Coleta Acomp]${rotulo} 📄 ${totalLivrosInicial} livros na etapa '${etapa}' — abrindo cada OS...`);

  // Processa livro a livro RELENDO A LISTA DO ZERO a cada vez, rastreando
  // por número do livro (não por índice de posição). Usuário observou ao
  // vivo, com índice fixo, o código reabrindo o MESMO "número da OS" em
  // vez de avançar pro próximo — sinal de que a lista de livros pode
  // reordenar/remontar via AJAX depois de fechar uma OS, então a posição
  // N nem sempre aponta pro mesmo livro entre uma leitura e a próxima.
  // Só o número do livro em si é uma identidade confiável.
  const livrosProcessados = new Set();
  let livrosComUc = 0;
  let totalUcs = 0;
  // Trava de segurança contra loop infinito, caso a lista fique
  // crescendo/reaparecendo de um jeito que nunca convirja — não deve
  // acontecer no fluxo normal, mas é melhor abortar com log claro do
  // que travar o processo indefinidamente numa etapa.
  const limiteLivros = totalLivrosInicial + 50;
  const MAX_TENTATIVAS_REABRIR_ETAPA = 3;

  async function garantirEtapaVisivel() {
    for (let tentativa = 0; tentativa < MAX_TENTATIVAS_REABRIR_ETAPA; tentativa++) {
      if (await tabelaAtual.isVisible().catch(() => false)) return true;
      // Não é erro — o site recolhe a etapa a cada CANCELAR (ver
      // Adendo 7), então isso é esperado a cada livro, não uma falha.
      log(
        `[Coleta Acomp]${rotulo} 🔄 Etapa '${etapa}' recolheu (comportamento normal do site) — ` +
          `reabrindo (${livrosProcessados.size}/${totalLivrosInicial} livros já coletados, ` +
          `tentativa ${tentativa + 1}/${MAX_TENTATIVAS_REABRIR_ETAPA}).`,
      );
      await etapaLink.click().catch(() => {});
      await tabelaAtual.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    }
    return tabelaAtual.isVisible().catch(() => false);
  }

  while (true) {
    if (livrosProcessados.size < totalLivrosInicial) {
      await garantirEtapaVisivel();
    }

    const linhasAtuais = tabelaAtual.locator('tbody tr');
    const totalAtual = await linhasAtuais.count();

    let linhaAlvo = null;
    let cabecalhoAlvo = null;
    for (let i = 0; i < totalAtual; i++) {
      const cabecalho = await lerCabecalhoLinha(linhasAtuais.nth(i), etapa);
      if (!cabecalho) continue;
      if (livrosProcessados.has(cabecalho.livro)) continue;
      linhaAlvo = linhasAtuais.nth(i);
      cabecalhoAlvo = cabecalho;
      break;
    }

    if (!linhaAlvo) {
      // totalAtual > 0 mas nenhuma linha "bateu" (nem vazia nem já
      // processada) — sinal de que a lista existe mas está num estado
      // inesperado (linhas vazias, ou o "número do livro" mudou de
      // valor entre leituras). Loga e salva diagnóstico pra investigar,
      // já que a contagem esperada (totalLivrosInicial) não bate com o
      // que foi de fato processado.
      if (livrosProcessados.size < totalLivrosInicial && !estadoDiagnostico.osSalvo) {
        const amostra =
          totalAtual > 0
            ? await linhasAtuais
                .nth(0)
                .locator('td')
                .allInnerTexts()
                .catch(() => ['<falhou ao ler>'])
            : [];
        logErro(
          `[Coleta Acomp]${rotulo} ❌ Etapa '${etapa}': parou em ${livrosProcessados.size} livros ` +
            `processados (esperado ${totalLivrosInicial}), tabela com ${totalAtual} linhas ` +
            `visíveis depois de tentar reabrir. 1ª linha: ${JSON.stringify(amostra)}`,
        );
        estadoDiagnostico.osSalvo = true;
        await salvarDiagnostico(page, `${rotulo.replace(/[^\w-]/g, '_')}_lista_travada_${etapa.replace(/[^\w-]/g, '_')}`);
      }
      break; // nenhum livro pendente sobrou na lista atual
    }

    if (livrosProcessados.size >= limiteLivros) {
      logErro(
        `[Coleta Acomp]${rotulo} ❌ Etapa '${etapa}' passou de ${limiteLivros} livros processados ` +
          `(esperado ~${totalLivrosInicial}) — abortando a etapa pra não travar indefinidamente.`,
      );
      break;
    }

    livrosProcessados.add(cabecalhoAlvo.livro);

    // "Número da OS" (numero_os no parser antigo) é a célula de índice
    // 3 contando com o checkbox — ex.: <a href="javascript:update('ID',
    // 'editarTarefasLeituraAction.do?acompanhamento=S')">2026...</a>.
    // Clicar de verdade (não simular via fetch) porque a função
    // update() do site pode depender de estado JS/sessão que não dá
    // pra replicar de fora.
    const linkOs = linhaAlvo.locator('td').nth(3).locator('a');
    if ((await linkOs.count()) === 0) continue;

    let popup = null;
    let usouMesmaPagina = false;
    try {
      // waitForEvent('popup') precisa ser registrado ANTES do clique
      // (senão corre risco de perder o evento se o popup abrir rápido
      // demais) — mas isso deixa a promise "solta" rejeitando sozinha
      // por timeout enquanto o código ainda está no `await
      // linkOs.click()`. `.catch(() => {})` preventivo precisa estar em
      // CADA nível (original, `.then()`, e a combinação final) pra
      // realmente eliminar o risco de unhandled rejection — um catch só
      // na promise original não bastou (ver Adendo 6 da ADR 0018).
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

      // Timing instrumentado (a pedido do usuário, que viu uma aba "parada
      // esperando a vez" enquanto outra processava) — o clique + espera da
      // resposta é a única ação de rede pesada por livro. Comparando os
      // intervalos [INÍCIO, FIM] de abas diferentes no log dá pra ver se
      // elas realmente ficam com requisição em voo ao mesmo tempo (paralelo
      // de verdade) ou se sempre se revezam (sinal de que o servidor
      // processa a mesma sessão HTTP de forma serializada, já que todas as
      // abas compartilham o mesmo login — ver ADR 0020).
      const inicioReq = Date.now();
      log(`[Coleta Acomp]${rotulo} ⏱️ INÍCIO abrir OS livro '${cabecalhoAlvo.livro}'`);

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
      // A tabela de UCs pode popular as linhas de forma assíncrona
      // depois de #tabFixedHeader já existir — espera a contagem
      // estabilizar antes de extrair (ver aguardarTabelaEstabilizar).
      await aguardarTabelaEstabilizar(paginaDetalhe);
      const linhasUc = await extrairLinhasDetalheOs(paginaDetalhe);
      log(`[Coleta Acomp]${rotulo} ⏱️ FIM abrir OS livro '${cabecalhoAlvo.livro}' (${Date.now() - inicioReq}ms)`);
      for (const uc of linhasUc) {
        registros.push({ ...cabecalhoAlvo, ...uc });
      }
      if (linhasUc.length > 0) {
        livrosComUc++;
        totalUcs += linhasUc.length;
        log(
          `[Coleta Acomp]${rotulo} 📖 Livro '${cabecalhoAlvo.livro}' — ${linhasUc.length} UCs ` +
            `(${livrosProcessados.size}/${totalLivrosInicial} da etapa '${etapa}').`,
        );
      } else {
        logWarn(`[Coleta Acomp]${rotulo} ⚠️ Livro '${cabecalhoAlvo.livro}' abriu a OS mas 0 UCs extraídas.`);
      }
    } catch (erroOs) {
      logErro(
        `[Coleta Acomp]${rotulo} ⚠️ Falha ao abrir OS do livro '${cabecalhoAlvo.livro}' (etapa ${etapa}): ${erroOs.message}`,
      );
      if (!estadoDiagnostico.osSalvo) {
        estadoDiagnostico.osSalvo = true;
        await salvarDiagnostico(page, `${rotulo.replace(/[^\w-]/g, '_')}_os_${cabecalhoAlvo.livro}_falhou`);
      }
      // "All promises were rejected" (nem popup nem "DADOS DE EXECUÇÃO"
      // apareceram a tempo) não significa que o clique não teve efeito —
      // a navegação real pode só ter completado DEPOIS do timeout (rede
      // lenta, mais comum sob 8 abas competindo pela mesma sessão). Nesse
      // caso nem popup nem usouMesmaPagina foram marcados, então o finally
      // normal não fecharia nada, deixando a tela de detalhe (URL
      // editarTarefasLeituraAction.do) aberta e a aba PRESA nela pro resto
      // da execução — sem nenhuma etapa visível, sem formulário de busca,
      // incapaz de se recuperar sozinha (confirmado com diagnóstico real:
      // uma checagem única e instantânea aqui não bastava — a tela às vezes
      // só aparecia alguns segundos depois dela). Poll de até 10s (bem mais
      // curto que os 20s do timeout original, só cobrindo o "quase lá") em
      // vez de uma checagem única.
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

  log(
    `[Coleta Acomp]${rotulo} ✅ Etapa '${etapa}': ${livrosComUc}/${livrosProcessados.size} livros com OS aberta ` +
      `(${totalLivrosInicial} na lista original), ${totalUcs} UCs coletadas.`,
  );

  await etapaLink.click(); // recolhe a etapa atual antes de ir pra próxima
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

// Cada worker (1 por aba) consome números de etapa da fila COMPARTILHADA
// (`filaEtapas.shift()` — síncrono, sem race condition real mesmo com
// vários workers "concorrentes", já que JS processa um passo de cada vez)
// até ela esvaziar. Localiza a etapa correspondente NA SUA PRÓPRIA página
// pelo número (não por índice nem pelo texto completo — ver numeroDaEtapa),
// já que cada aba carregou sua cópia da lista de forma independente.
//
// `tentativasPorEtapa` (Map compartilhado entre workers) limita quantas
// vezes um número pode ser devolvido à fila por "não encontrado nesta aba" —
// sem isso, uma etapa que genuinamente não existe em nenhuma aba (número
// extraído errado, etapa removida do portal entre a montagem da fila e a
// tentativa) ficaria sendo re-adicionada pra sempre, travando a coleta.
const MAX_TENTATIVAS_LOCALIZAR_ETAPA = 5;

async function worker(page, rotulo, filaEtapas, registros, tentativasPorEtapa) {
  const estadoDiagnostico = { osSalvo: false, etapaSalvo: false };

  while (filaEtapas.length > 0) {
    const numeroAlvo = filaEtapas.shift();
    if (numeroAlvo === undefined) break;

    const etapas = page.locator('a.color:has-text("ETAPA")');
    let textos = await etapas.allInnerTexts();
    let indice = textos.findIndex(t => numeroDaEtapa(t) === numeroAlvo);
    if (indice === -1) {
      // Pode ser que ESTA aba especificamente ainda não tenha terminado de
      // carregar sua própria cópia da lista (cada aba rola de forma
      // independente — ver aguardarTodasEtapasCarregadas). Tenta rolar mais
      // antes de desistir, em vez de simplesmente descartar a etapa.
      log(
        `[Coleta Acomp]${rotulo} 🔄 Etapa número ${numeroAlvo} não encontrada ainda — rolando mais pra procurar.`,
      );
      await aguardarTodasEtapasCarregadas(page);
      textos = await etapas.allInnerTexts();
      indice = textos.findIndex(t => numeroDaEtapa(t) === numeroAlvo);
    }
    if (indice === -1 && textos.length === 0) {
      // Visto ao vivo (diagnóstico automático confirmou duas causas
      // diferentes ao longo da investigação): 1) a aba pode ficar PRESA na
      // tela de detalhe de uma OS (URL editarTarefasLeituraAction.do) que
      // nunca foi fechada — "All promises were rejected" seguido da
      // navegação real completando só depois da checagem de "apareceu
      // tarde"; 2) mesmo com goto() forçando a URL certa de volta, o
      // FORMULÁRIO de filtro às vezes simplesmente não carrega — corpo da
      // página vazio, só o menu, mesmo depois dos 30s de auto-wait do
      // Playwright em cima do `selectOption`. O segundo caso parece
      // transitório (sobrecarga momentânea do servidor sob várias abas
      // competindo pela mesma sessão) — vale a pena tentar de novo em vez
      // de desistir na primeira falha.
      logWarn(
        `[Coleta Acomp]${rotulo} 🔁 Nenhuma etapa na página (aba provavelmente presa em outra tela) — renavegando e refazendo busca.`,
      );
      await recuperarAba(page, rotulo, estadoDiagnostico);
      textos = await etapas.allInnerTexts();
      indice = textos.findIndex(t => numeroDaEtapa(t) === numeroAlvo);
    }
    if (indice === -1) {
      const tentativas = (tentativasPorEtapa.get(numeroAlvo) ?? 0) + 1;
      tentativasPorEtapa.set(numeroAlvo, tentativas);
      if (tentativas >= MAX_TENTATIVAS_LOCALIZAR_ETAPA) {
        logErro(
          `[Coleta Acomp]${rotulo} ❌ Etapa número ${numeroAlvo} não encontrada em ${tentativas} tentativas ` +
            '(em nenhuma aba) — desistindo dela pra não travar a coleta.',
        );
        continue;
      }
      // Ainda não achou depois de garantir a lista carregada — devolve pra
      // fila em vez de perder a etapa silenciosamente; outra aba (ou esta
      // mesma, numa próxima volta) tenta de novo.
      logWarn(
        `[Coleta Acomp]${rotulo} ⚠️ Etapa número ${numeroAlvo} não existe nesta aba mesmo após recarregar ` +
          `(tentativa ${tentativas}/${MAX_TENTATIVAS_LOCALIZAR_ETAPA}) — devolvendo pra fila.`,
      );
      filaEtapas.push(numeroAlvo);
      continue;
    }

    const etapaLink = etapas.nth(indice);
    const etapaTexto = textos[indice].trim();

    // Todo o processamento desta etapa fica dentro de um try/catch de nível
    // de etapa — um erro fatal não tratado internamente (ex.: o clique de
    // recolher no fim de processarEtapa) não pode derrubar o worker
    // inteiro, senão as etapas restantes da fila ficam sem ninguém pra
    // processá-las (ver Adendo 12 da ADR 0018 — mesmo raciocínio, agora por
    // worker em vez de por execução inteira).
    try {
      await processarEtapa({ page, etapaLink, etapa: etapaTexto, registros, rotulo, estadoDiagnostico });
    } catch (erroEtapa) {
      logErro(
        `[Coleta Acomp]${rotulo} ❌ Etapa '${etapaTexto}' interrompida por erro irrecuperável: ${erroEtapa.message} — ` +
          'seguindo para a próxima etapa da fila.',
      );
      if (!estadoDiagnostico.etapaSalvo) {
        estadoDiagnostico.etapaSalvo = true;
        await salvarDiagnostico(page, `${rotulo.replace(/[^\w-]/g, '_')}_etapa_falhou_${etapaTexto.replace(/[^\w-]/g, '_')}`);
      }
    }
  }
  log(`[Coleta Acomp]${rotulo} 🏁 Fila de etapas esgotada — aba encerrada.`);
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

    // Números de etapa únicos (não o texto inteiro — ver numeroDaEtapa),
    // na ordem em que aparecem. Vira a fila de trabalho compartilhada entre
    // todas as abas.
    const textosEtapas = await page.locator('a.color:has-text("ETAPA")').allInnerTexts();
    const filaEtapas = [...new Set(textosEtapas.map(numeroDaEtapa).filter(Boolean))];
    log(`[Coleta Acomp] 📋 ${filaEtapas.length} etapas encontradas: ${filaEtapas.join(', ')}`);

    if (filaEtapas.length === 0) {
      log('[Coleta Acomp] ✅ Nenhuma etapa para processar.');
      return [];
    }

    // Não abre mais abas do que etapas existem — sem sentido ter 8 abas
    // ociosas pra processar 2 etapas.
    const paralelismoConfigurado = Math.max(1, parseInt(process.env.COPEL_PARALELISMO_ACOMP || '8', 10));
    const totalAbas = Math.min(paralelismoConfigurado, filaEtapas.length);
    log(`[Coleta Acomp] 🧵 Abrindo ${totalAbas} aba(s) em paralelo para processar as etapas.`);

    const paginas = [page];
    for (let i = 1; i < totalAbas; i++) {
      const novaPagina = await context.newPage();
      await novaPagina.goto(URL_ACOMPANHAMENTO, { timeout: 60000 });
      await aplicarFiltroEBuscar(novaPagina);
      paginas.push(novaPagina);
    }

    const registros = [];
    const tentativasPorEtapa = new Map();
    await Promise.all(
      paginas.map((pg, i) => worker(pg, ` [Aba ${i + 1}/${totalAbas}]`, filaEtapas, registros, tentativasPorEtapa)),
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
