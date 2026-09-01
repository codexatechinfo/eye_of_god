const ExcelJS = require('exceljs');
const { CONFIG_IMPORTACAO } = require('../config/importacaoConfig');

function normalizar(texto) {
  return String(texto ?? '').trim();
}

// "YYYY-MM-DD" a partir dos componentes LOCAIS do Date (não `toISOString()`,
// que converte pra UTC e pode voltar um dia — mesma cilada de fuso horário
// já documentada em PRAZO_CONTR_SQL/monitoramentoService.js).
function formatarDataIso(data) {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

// Primeira linha da planilha é o cabeçalho e tem que bater exatamente (sem
// acento/caixa não importa) com uma coluna conhecida da tabela — nunca aceita
// nome de coluna vindo do arquivo sem checar contra o allowlist, pra não virar
// injeção de SQL via cabeçalho malicioso.
//
// `colunasDataIso` (opcional, ver CONFIG_IMPORTACAO): colunas de data que
// fogem do padrão DD/MM/YYYY do restante do schema e precisam de
// "YYYY-MM-DD" — hoje só `calendario_leitura.mes_ref`. Achado ao vivo
// (usuário reportou com print): sem essa exceção, uma célula do Excel
// formatada como data virava DD/MM/YYYY igual a qualquer outra coluna,
// quebrando `to_date(cal.mes_ref, 'YYYY-MM-DD')` em todo lugar que junta
// com essa tabela (mesmo sintoma do Adendo 1 da ADR 0023, mas ali a causa
// era uma importação ANTERIOR a este fix — a guarda de formato adicionada
// lá evita o crash, mas não corrige o dado; este fix ataca a causa real).
async function extrairLinhas(buffer, colunasValidas, colunasDataIso = []) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const planilha = workbook.worksheets[0];
  if (!planilha) {
    throw new Error('A planilha não tem nenhuma aba.');
  }

  const mapaColunas = new Map(colunasValidas.map(c => [c.toLowerCase(), c]));
  const cabecalho = [];
  const linhaCabecalho = planilha.getRow(1);
  linhaCabecalho.eachCell({ includeEmpty: true }, (celula, indice) => {
    const valor = normalizar(celula.value);
    const colunaReal = mapaColunas.get(valor.toLowerCase());
    if (valor && !colunaReal) {
      throw new Error(
        `Coluna "${valor}" (posição ${indice}) não existe nessa tabela. Colunas aceitas: ${colunasValidas.join(', ')}`,
      );
    }
    cabecalho[indice] = colunaReal || null;
  });

  if (!cabecalho.some(Boolean)) {
    throw new Error('Nenhuma coluna reconhecida na primeira linha da planilha.');
  }

  const setColunasDataIso = new Set(colunasDataIso);
  const linhas = [];
  planilha.eachRow((linha, numeroLinha) => {
    if (numeroLinha === 1) return;
    const objeto = {};
    let temAlgumValor = false;
    linha.eachCell({ includeEmpty: true }, (celula, indice) => {
      const coluna = cabecalho[indice];
      if (!coluna) return;
      let valor = celula.value;
      if (valor && typeof valor === 'object' && 'result' in valor) valor = valor.result; // fórmula
      // A maioria das colunas de data/hora do schema é texto livre no
      // formato DD/MM/YYYY (mesmo padrão que o scraper grava) — se a célula
      // do Excel estiver formatada como data, o ExcelJS entrega um objeto
      // Date, que precisa virar essa mesma string, senão quebra os
      // to_date(...) do resto do app. `colunasDataIso` é a exceção
      // conhecida (ver comentário de extrairLinhas).
      if (valor instanceof Date) {
        valor = setColunasDataIso.has(coluna) ? formatarDataIso(valor) : valor.toLocaleDateString('pt-BR');
      }
      if (valor !== null && valor !== undefined && valor !== '') temAlgumValor = true;
      objeto[coluna] = valor === '' ? null : valor;
    });
    if (temAlgumValor) linhas.push(objeto);
  });

  return linhas;
}

// node-postgres tem um bug conhecido e não corrigido (issue #2579) em INSERT
// multi-linha com muitos parâmetros de bind: a partir de certa combinação de
// quantidade/conteúdo (o limiar varia — relatos na comunidade vão de ~1.100
// a ~50.000 parâmetros), a mensagem Bind sai corrompida e o Postgres recusa
// com "bind message has N parameter formats but 0 parameters". Não dá pra
// prever o limiar (depende do conteúdo real, não só da contagem), então o
// INSERT é sempre fatiado em lotes bem abaixo de qualquer relato de quebra.
const LOTE_MAX_LINHAS = 300;

function montarInsert(tabela, colunas, linhas, empresaId, temEmpresa) {
  const colunasFinais = temEmpresa ? [...colunas, 'empresa_id'] : colunas;
  const valores = [];
  const placeholders = linhas.map((linha, i) => {
    const valoresLinha = colunas.map(c => linha[c] ?? null);
    if (temEmpresa) valoresLinha.push(empresaId);
    valores.push(...valoresLinha);
    const base = i * colunasFinais.length;
    return `(${colunasFinais.map((_, j) => `$${base + j + 1}`).join(', ')})`;
  });

  const sql = `INSERT INTO ${tabela} (${colunasFinais.map(c => `"${c}"`).join(', ')}) VALUES ${placeholders.join(', ')}`;
  return { sql, valores };
}

async function importarArquivo(db, tabela, empresaId, buffer) {
  const config = CONFIG_IMPORTACAO[tabela];
  if (!config) {
    throw new Error(`Tabela "${tabela}" não está habilitada para importação.`);
  }

  const linhas = await extrairLinhas(buffer, config.colunas, config.colunasDataIso);
  if (!linhas.length) {
    return { linhasProcessadas: 0, modo: config.modo, tabela };
  }

  if (config.modo === 'substituir') {
    if (config.temEmpresa) {
      await db.query(`DELETE FROM ${tabela} WHERE empresa_id = $1`, [empresaId]);
    } else {
      await db.query(`DELETE FROM ${tabela}`);
    }
  } else {
    // upsert: remove as linhas cuja chave (tupla, não coluna por coluna —
    // por isso o DELETE...USING unnest, e não vários "= ANY()" separados,
    // que combinariam valores de linhas diferentes do arquivo entre si)
    // bate com alguma linha do arquivo — o INSERT logo depois recria elas
    // (com o dado novo) e insere as que não existiam. Sem depender de
    // constraint UNIQUE na tabela (o scraper grava a mesma "chave de
    // negócio" várias vezes ao dia de propósito, em ciclos diferentes).
    const arraysChave = config.chave.map((c, i) => linhas.map(l => (l[c] ?? null) === null ? null : String(l[c])));
    const aliasChave = config.chave.map((c, i) => `k${i}`).join(', ');
    const unnestParams = config.chave.map((c, i) => `$${i + (config.temEmpresa ? 2 : 1)}::text[]`).join(', ');
    const condicoesChave = config.chave.map((c, i) => `t."${c}" = u.k${i}`).join(' AND ');
    const paramsBase = config.temEmpresa ? [empresaId, ...arraysChave] : arraysChave;

    await db.query(
      `DELETE FROM ${tabela} t
       USING unnest(${unnestParams}) AS u(${aliasChave})
       WHERE ${condicoesChave} ${config.temEmpresa ? 'AND t.empresa_id = $1' : ''}`,
      paramsBase,
    );
  }

  let linhasInseridas = 0;
  for (let i = 0; i < linhas.length; i += LOTE_MAX_LINHAS) {
    const lote = linhas.slice(i, i + LOTE_MAX_LINHAS);
    const { sql, valores } = montarInsert(tabela, config.colunas, lote, empresaId, config.temEmpresa);
    const { rowCount } = await db.query(sql, valores);
    linhasInseridas += rowCount;
  }

  return { linhasProcessadas: linhasInseridas, modo: config.modo, tabela, compartilhada: !config.temEmpresa };
}

// Gera um .xlsx com uma aba por tabela importável (mesmo conjunto de
// CONFIG_IMPORTACAO usado no import), cada aba com o cabeçalho — as mesmas
// colunas aceitas no import, na mesma ordem — e até 1 linha real de exemplo,
// pra servir de referência de formato pra quem for preparar uma planilha.
// Usa a sessão/RLS de quem chamou, sem filtro explícito de empresa: não-ROOT
// só enxerga linha da própria empresa porque a RLS já filtra sozinha; ROOT
// pode ver qualquer linha — mesmo comportamento de leitura já usado no resto
// do app, não é um caminho novo de acesso.
//
// `tabelaFiltro`: quando informado, só gera a aba dessa tabela (mesma
// escolha do usuário no seletor de import) — sem ele, gera todas.
async function gerarExemploTodasTabelas(db, tabelaFiltro) {
  const workbook = new ExcelJS.Workbook();
  const entradas = tabelaFiltro
    ? Object.entries(CONFIG_IMPORTACAO).filter(([tabela]) => tabela === tabelaFiltro)
    : Object.entries(CONFIG_IMPORTACAO);

  for (const [tabela, config] of entradas) {
    const planilha = workbook.addWorksheet(tabela);
    planilha.addRow(config.colunas);

    const colunasSql = config.colunas.map(c => `"${c}"`).join(', ');
    // req.db é uma transação real por requisição (abrirContextoTenant) — um
    // erro de SQL "envenena" a transação inteira até SAVEPOINT/ROLLBACK
    // TO/COMMIT (comportamento padrão do Postgres). Sem o SAVEPOINT aqui, a
    // primeira tabela com config desatualizada (ex. contr_execucao_leitura,
    // que ainda referencia colunas removidas pela ADR 0018) derrubaria TODAS
    // as tabelas seguintes do mesmo loop com "current transaction is
    // aborted" — confirmado ao vivo antes desse fix.
    await db.query('SAVEPOINT antes_exemplo');
    try {
      const { rows } = await db.query(`SELECT ${colunasSql} FROM ${tabela} LIMIT 1`);
      if (rows[0]) {
        planilha.addRow(config.colunas.map(c => rows[0][c] ?? ''));
      }
      await db.query('RELEASE SAVEPOINT antes_exemplo');
    } catch (erro) {
      await db.query('ROLLBACK TO SAVEPOINT antes_exemplo');
      planilha.addRow([`(config de import desatualizada: ${erro.message})`]);
    }
  }

  return workbook.xlsx.writeBuffer();
}

module.exports = { importarArquivo, gerarExemploTodasTabelas, CONFIG_IMPORTACAO };
