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

      const rows = await page.evaluate(() => {
        const tables = Array.from(document.querySelectorAll('table#item'));
        return tables.map(table => {
          if (table.offsetParent !== null) {
            const rows = Array.from(table.querySelectorAll('tbody tr'));
            return rows.map(row =>
              Array.from(row.querySelectorAll('td')).map(cell =>
                cell.innerText.trim().replace(/\s+/g, ' ')
              )
            );
          }
          return [];
        }).flat();
      });

      console.log(`[Coleta Acomp] 📄 ${rows.length} linhas extraídas na etapa '${etapa}'`);

      for (let row of rows) {
        if (row.length >= 2) row = row.slice(1);
        while (row.length < 14) row.push('');

        let data = '', hora = '';
        if (row[6] && row[6].includes(' ')) {
          [data, hora] = row[6].split(' ', 2);
        } else {
          data = row[6];
        }

        const linha = [
          etapa, row[0], row[1], row[2], row[3], row[4], row[5],
          data, hora, row[7], row[8], row[9], row[10], row[11], row[12], row[13]
        ];

        if (linha.slice(1).some(c => c && c.trim())) {
          registros.push(linha);
        }
      }

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