const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DIR_DIAGNOSTICO = path.join(__dirname, '..', '..', 'diagnosticos');

async function salvarDiagnostico(page, motivo) {
  try {
    if (!fs.existsSync(DIR_DIAGNOSTICO)) fs.mkdirSync(DIR_DIAGNOSTICO, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(DIR_DIAGNOSTICO, `acomp_${motivo}_${timestamp}`);

    await page.screenshot({ path: `${base}.png`, fullPage: true });
    const textoVisivel = await page.evaluate(() => document.body.innerText.slice(0, 3000));
    fs.writeFileSync(`${base}.txt`, `URL: ${page.url()}\n\n${textoVisivel}`, 'utf-8');

    console.log(`[Coleta Acomp] 📸 Diagnóstico salvo: ${base}.png / .txt`);
  } catch (erroDiagnostico) {
    console.error('[Coleta Acomp] ⚠️ Não foi possível salvar diagnóstico:', erroDiagnostico.message);
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
    console.warn('[Coleta Acomp] ⚠️ Botão CANCELAR não encontrado — usando page.goBack() como fallback.');
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

async function coletarDadosAcompanhamento() {
  // COPEL_HEADLESS=false abre o Chromium com janela visível — útil pra
  // acompanhar ao vivo o que o site está fazendo durante uma investigação;
  // default headless (sem janela), que é o certo pro job rodando sozinho o
  // dia inteiro em produção.
  const headless = process.env.COPEL_HEADLESS !== 'false';
  const browser = await chromium.launch({ headless, slowMo: headless ? 100 : 300 });
  const page = await browser.newPage();

  try {
    console.log('[Coleta Acomp] 🔐 Fazendo login...');
    await page.goto('https://www.copel.com/lis/acompanhamentoAction.do#', { timeout: 60000 });
    await page.fill("input[name='j_username']", process.env.COPEL_USERNAME);
    await page.fill("input[name='j_password']", process.env.COPEL_PASSWORD);
    await page.click("input[type='submit'].lgn_btn");

    try {
      await page.waitForSelector('a.submenu', { timeout: 60000 });
    } catch (erroLogin) {
      await salvarDiagnostico(page, 'login_falhou');
      throw erroLogin;
    }
    console.log('[Coleta Acomp] ✅ Login realizado com sucesso.');

    console.log('[Coleta Acomp] 🔎 Acessando aba Acompanhamento...');
    await page.click("a.submenu:has-text('acompanhamento')");
    await page.selectOption('select[name="searchConcessionariaId"]', { label: 'COMPANHIA PARANAENSE DE ENERGIA' });
    await page.selectOption('select[name="searchEmpreiteiraId"]', { label: 'F IMM BRASIL LTDA' });
    await page.click('#botaoBuscar');
    await page.waitForSelector('a.color:has-text("ETAPA")', { timeout: 60000 });

    const registros = [];
    let etapaIndex = 0;
    const etapasProcessadas = new Set();
    // Só salva um diagnóstico (screenshot + texto) por execução inteira do
    // scraper, não um por livro que falhar — evita gerar centenas de
    // capturas se o problema for sistêmico (ex.: popup nunca abre).
    let diagnosticoOsSalvo = false;

    while (true) {
      const etapas = page.locator('a.color:has-text("ETAPA")');
      const count = await etapas.count();
      if (etapaIndex >= count) break;

      const etapaLink = etapas.nth(etapaIndex);
      const etapa = (await etapaLink.innerText()).trim();
      if (etapasProcessadas.has(etapa)) {
        etapaIndex++;
        continue;
      }

      console.log(`[Coleta Acomp] ➡️ Processando etapa ${etapaIndex + 1}/${count}: ${etapa}`);
      await etapaLink.click();
      // Nada de tempo fixo: espera a tabela de livros DESTA etapa (não
      // qualquer #item — ver tabelaDaEtapa) ficar visível. Isso já é o
      // sinal certo — um waitForLoadState('networkidle') extra só atrasava
      // sem necessidade (ver comentário em fecharTelaDetalheMesmaPagina).
      const tabelaAtual = tabelaDaEtapa(etapaLink);
      await tabelaAtual.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});

      const totalLivrosInicial = await tabelaAtual.locator('tbody tr').count();
      console.log(`[Coleta Acomp] 📄 ${totalLivrosInicial} livros na etapa '${etapa}' — abrindo cada OS...`);

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
      // "CANCELAR" fecha a tela de detalhe, mas pode devolver com a etapa
      // inteira RECOLHIDA (não só "lista vazia") — confirmado com
      // diagnóstico real: depois de processar o 1º livro, um screenshot
      // mostrou a etapa de volta ao estado fechado (só o cabeçalho "ETAPA
      // 15 - (2)" visível, sem a tabela de livros abaixo). Nesse caso o
      // elemento da 2ª linha AINDA EXISTE no DOM (Playwright resolve o
      // locator normalmente) mas fica invisível — `count()` de linhas não
      // detecta isso (a linha "existe"), só checar visibilidade da tabela
      // detecta. Sem essa checagem, o clique subsequente ficava 30s inteiro
      // tentando em vão ("element is not visible") em vez de reabrir a
      // etapa primeiro. Verificada a cada volta do loop, antes de procurar
      // o próximo livro pendente.
      const MAX_TENTATIVAS_REABRIR_ETAPA = 3;

      async function garantirEtapaVisivel() {
        for (let tentativa = 0; tentativa < MAX_TENTATIVAS_REABRIR_ETAPA; tentativa++) {
          if (await tabelaAtual.isVisible().catch(() => false)) return true;
          // Não é erro — o site recolhe a etapa a cada CANCELAR (ver
          // Adendo 7), então isso é esperado a cada livro, não uma falha.
          // console.log em vez de warn/error pra não soar alarmante numa
          // execução normal.
          console.log(
            `[Coleta Acomp] 🔄 Etapa '${etapa}' recolheu (comportamento normal do site) — ` +
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
          if (livrosProcessados.size < totalLivrosInicial && !diagnosticoOsSalvo) {
            const amostra =
              totalAtual > 0
                ? await linhasAtuais
                    .nth(0)
                    .locator('td')
                    .allInnerTexts()
                    .catch(() => ['<falhou ao ler>'])
                : [];
            console.error(
              `[Coleta Acomp] ❌ Etapa '${etapa}': parou em ${livrosProcessados.size} livros ` +
                `processados (esperado ${totalLivrosInicial}), tabela com ${totalAtual} linhas ` +
                `visíveis depois de tentar reabrir. 1ª linha: ${JSON.stringify(amostra)}`,
            );
            diagnosticoOsSalvo = true;
            await salvarDiagnostico(page, `lista_travada_${etapa.replace(/[^\w-]/g, '_')}`);
          }
          break; // nenhum livro pendente sobrou na lista atual
        }

        if (livrosProcessados.size >= limiteLivros) {
          console.error(
            `[Coleta Acomp] ❌ Etapa '${etapa}' passou de ${limiteLivros} livros processados ` +
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
        //
        // Usuário descreveu como "abre em popup/nova aba", mas o primeiro
        // ciclo real deu timeout esperando o evento 'popup' em todos os
        // livros — a "nova tela" é, na prática, um modal/iframe carregado
        // via AJAX dentro da MESMA página. Cobre os dois casos: espera
        // popup E o texto "DADOS DE EXECUÇÃO" (cabeçalho de seção exclusivo
        // da tela de detalhe da OS, visto no print do usuário) aparecer na
        // própria `page`, em paralelo, usa o que vier primeiro.
        //
        // Não usa #tabFixedHeader como sinal de "mudou de tela": esse id é
        // de um plugin JS genérico de tabela com cabeçalho fixo
        // ("fixedheader fht-table", visto na classe CSS do HTML fornecido
        // pelo usuário) que pode estar reaproveitado em MAIS de uma tela do
        // sistema, inclusive talvez na própria lista de livros — usá-lo
        // como sinal de mudança foi a causa real de um bug encontrado ao
        // vivo: 1 registro por livro em vez de todas as UCs (a extração
        // rodava contra a tabela errada, ou cedo demais).
        const linkOs = linhaAlvo.locator('td').nth(3).locator('a');
        if ((await linkOs.count()) === 0) continue;

        let popup = null;
        let usouMesmaPagina = false;
        try {
          // waitForEvent('popup') precisa ser registrado ANTES do clique
          // (senão corre risco de perder o evento se o popup abrir rápido
          // demais) — mas isso deixa a promise "solta" rejeitando sozinha
          // por timeout enquanto o código ainda está no `await
          // linkOs.click()`. Bug real visto ao vivo: se o clique demorasse
          // mais que os 10s do timeout, a rejeição acontecia ANTES do
          // Promise.any ter chance de consumi-la, virando uma unhandled
          // rejection que derrubava o processo Node inteiro (nodemon "app
          // crashed").
          //
          // Confirmado com um teste isolado (fora deste arquivo) que o V8
          // marca como "unhandled" QUALQUER promise da cadeia que rejeita
          // antes de ter um handler anexado — inclusive as derivadas de
          // `.then()` e o resultado final do `Promise.any()`, não só as
          // promises originais. `.catch(() => {})` preventivo precisa
          // estar em CADA nível (original, `.then()`, e a combinação final)
          // pra realmente eliminar o risco; um catch só na promise
          // original não bastou.
          const promPopup = page.waitForEvent('popup', { timeout: 10000 });
          promPopup.catch(() => {});
          const promMesmaPagina = page
            .getByText('DADOS DE EXECUÇÃO', { exact: false })
            .first()
            .waitFor({ timeout: 10000, state: 'visible' });
          promMesmaPagina.catch(() => {});

          // Promise.any (não race): resolve assim que QUALQUER uma tiver
          // sucesso, e só rejeita se as DUAS falharem. Com race, a que
          // expira primeiro derrubaria a tentativa mesmo que a outra ainda
          // estivesse a caminho de dar certo.
          const esperaPopup = promPopup.then(p => ({ tipo: 'popup', p }));
          esperaPopup.catch(() => {});
          const esperaMesmaPagina = promMesmaPagina.then(() => ({ tipo: 'mesmaPagina' }));
          esperaMesmaPagina.catch(() => {});

          const combinada = Promise.any([esperaPopup, esperaMesmaPagina]);
          combinada.catch(() => {});

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
          for (const uc of linhasUc) {
            registros.push({ ...cabecalhoAlvo, ...uc });
          }
          if (linhasUc.length > 0) {
            livrosComUc++;
            totalUcs += linhasUc.length;
            // Log por livro: sem isso, uma etapa de centenas de livros só
            // mostra 1 linha de progresso no final inteiro (usuário
            // reportou "pelo console parece que não estava coletando",
            // mesmo funcionando corretamente — os avisos de "reabrindo a
            // etapa" a cada livro, sem nenhuma confirmação de sucesso no
            // meio, davam essa impressão).
            console.log(
              `[Coleta Acomp] 📖 Livro '${cabecalhoAlvo.livro}' — ${linhasUc.length} UCs ` +
                `(${livrosProcessados.size}/${totalLivrosInicial} da etapa '${etapa}').`,
            );
          } else {
            console.warn(`[Coleta Acomp] ⚠️ Livro '${cabecalhoAlvo.livro}' abriu a OS mas 0 UCs extraídas.`);
          }
        } catch (erroOs) {
          console.error(
            `[Coleta Acomp] ⚠️ Falha ao abrir OS do livro '${cabecalhoAlvo.livro}' (etapa ${etapa}): ${erroOs.message}`,
          );
          if (!diagnosticoOsSalvo) {
            diagnosticoOsSalvo = true;
            await salvarDiagnostico(page, `os_${cabecalhoAlvo.livro}_falhou`);
          }
        } finally {
          if (popup) {
            await popup.close().catch(() => {});
          } else if (usouMesmaPagina) {
            await fecharTelaDetalheMesmaPagina(page);
          }
        }
      }

      console.log(
        `[Coleta Acomp] ✅ Etapa '${etapa}': ${livrosComUc}/${livrosProcessados.size} livros com OS aberta ` +
          `(${totalLivrosInicial} na lista original), ${totalUcs} UCs coletadas.`,
      );

      etapasProcessadas.add(etapa);
      await etapaLink.click(); // recolhe a etapa atual antes de ir pra próxima
      etapaIndex++;
      // Sem espera extra aqui — a próxima volta do while já espera a
      // tabela da PRÓXIMA etapa ficar visível antes de prosseguir.
    }

    console.log('[Coleta Acomp] ✅ Extração concluída.');
    return registros;
  } finally {
    await browser.close();
  }
}

module.exports = { coletarDadosAcompanhamento };
