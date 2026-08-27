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

async function coletarDadosAcompanhamento() {
  const browser = await chromium.launch({ headless: true, slowMo: 100 });
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
    await page.waitForTimeout(2000);

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

      const etapa = (await etapas.nth(etapaIndex).innerText()).trim();
      if (etapasProcessadas.has(etapa)) {
        etapaIndex++;
        continue;
      }

      console.log(`[Coleta Acomp] ➡️ Processando etapa ${etapaIndex + 1}/${count}: ${etapa}`);
      await etapas.nth(etapaIndex).click();
      await page.waitForTimeout(8000);

      const linhasEtapa = page.locator('table#item:visible tbody tr');
      const totalLivros = await linhasEtapa.count();
      console.log(`[Coleta Acomp] 📄 ${totalLivros} livros na etapa '${etapa}' — abrindo cada OS...`);

      let livrosComUc = 0;
      let totalUcs = 0;

      for (let i = 0; i < totalLivros; i++) {
        const linha = linhasEtapa.nth(i);
        const celulas = await linha.locator('td').allInnerTexts();
        // Primeira célula é o checkbox de seleção (sem texto) — mesmo
        // padrão do parser antigo.
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

        if (!Object.values(cabecalho).some(v => v && String(v).trim())) continue;

        // "Número da OS" (numero_os no parser antigo) é a célula de índice
        // 3 contando com o checkbox — ex.: <a href="javascript:update('ID',
        // 'editarTarefasLeituraAction.do?acompanhamento=S')">2026...</a>.
        // Clicar de verdade (não simular via fetch) porque a função
        // update() do site pode depender de estado JS/sessão que não dá
        // pra replicar de fora.
        //
        // Usuário descreveu como "abre em popup/nova aba", mas o primeiro
        // ciclo real (após esta mudança) deu timeout esperando o evento
        // 'popup' em todos os livros testados — sinal de que a "nova tela"
        // pode ser, na prática, um modal/iframe carregado via AJAX dentro
        // da MESMA página (padrão comum em telas Struts como esta), não uma
        // janela nova de verdade. Cobre os dois casos: espera popup E
        // #tabFixedHeader aparecer na própria `page` em paralelo, usa o que
        // vier primeiro. Se nenhum vier, salva diagnóstico (só na primeira
        // falha do ciclo, pra não gerar uma captura por livro) e pula.
        const linkOs = linha.locator('td').nth(3).locator('a');
        if ((await linkOs.count()) === 0) continue;

        let popup = null;
        let usouMesmaPagina = false;
        try {
          // Promise.any (não race): resolve assim que QUALQUER uma tiver
          // sucesso, e só rejeita se as DUAS falharem. Com race, a que
          // expira primeiro derrubaria a tentativa mesmo que a outra ainda
          // estivesse a caminho de dar certo.
          const esperaPopup = page.waitForEvent('popup', { timeout: 10000 }).then(p => ({ tipo: 'popup', p }));
          const esperaMesmaPagina = page
            .waitForSelector('#tabFixedHeader', { timeout: 10000, state: 'visible' })
            .then(() => ({ tipo: 'mesmaPagina' }));

          await linkOs.click();
          const resultado = await Promise.any([esperaPopup, esperaMesmaPagina]);

          if (resultado.tipo === 'popup') {
            popup = resultado.p;
            await popup.waitForSelector('#tabFixedHeader', { timeout: 15000 });
          } else {
            usouMesmaPagina = true;
          }

          const paginaDetalhe = popup || page;
          const linhasUc = await extrairLinhasDetalheOs(paginaDetalhe);
          for (const uc of linhasUc) {
            registros.push({ ...cabecalho, ...uc });
          }
          if (linhasUc.length > 0) {
            livrosComUc++;
            totalUcs += linhasUc.length;
          }
        } catch (erroOs) {
          console.error(
            `[Coleta Acomp] ⚠️ Falha ao abrir OS do livro '${cabecalho.livro}' (etapa ${etapa}): ${erroOs.message}`,
          );
          if (!diagnosticoOsSalvo) {
            diagnosticoOsSalvo = true;
            await salvarDiagnostico(page, `os_${cabecalho.livro}_falhou`);
          }
        } finally {
          if (popup) {
            await popup.close().catch(() => {});
          } else if (usouMesmaPagina) {
            // Voltou na mesma página (sem popup) — precisa voltar pra lista
            // de livros da etapa antes do próximo clique.
            await page.goBack().catch(() => {});
            await page.waitForTimeout(1000);
          }
        }
      }

      console.log(
        `[Coleta Acomp] ✅ Etapa '${etapa}': ${livrosComUc}/${totalLivros} livros com OS aberta, ${totalUcs} UCs coletadas.`,
      );

      etapasProcessadas.add(etapa);
      await etapas.nth(etapaIndex).click();
      etapaIndex++;
      await page.waitForTimeout(2000);
    }

    console.log('[Coleta Acomp] ✅ Extração concluída.');
    return registros;
  } finally {
    await browser.close();
  }
}

module.exports = { coletarDadosAcompanhamento };
