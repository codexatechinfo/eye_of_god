const { log, logWarn, logErro } = require('../utils/logTempo');

// Colunas gravadas em contr_execucao_leitura. Vem em dois grupos: o
// "cabeçalho" do livro (etapa/localidade/livro/empreiteira/datas/situacao/
// colaborador — extraído da lista de livros da etapa, um por livro, repetido
// em toda UC daquele livro) e o "detalhe da OS" (uc/codigo/equipamento/
// tipo_especificacao/faturamento/leitura_atual — extraído da tabela que abre
// ao clicar no link "número da OS" de cada livro, um registro por UC/medidor).
// Ver copelScraperService.js — coletarDadosAcompanhamento() já entrega os
// registros como objetos com esses campos, um objeto por UC.
const CAMPOS_TABELA = [
  'etapa', 'localidade', 'livro', 'empreiteira', 'data_recebimento',
  'hora_recebimento', 'data_prevista_limite', 'situacao', 'colaborador',
  'uc', 'codigo', 'equipamento', 'tipo_especificacao', 'faturamento', 'leitura_atual',
];

// Máximo de linhas por INSERT — evita estourar o limite de 65535
// parâmetros do Postgres (15 colunas × linha + 3 metadados). Um livro agora
// pode gerar dezenas de linhas (uma por UC), então o volume por lote de
// coleta cresceu bastante em relação a quando era uma linha por livro.
const LOTE_MAX_LINHAS = 300;

// O portal da Copel mostra a etapa como link "ETAPA 18 - (528)" — o número
// entre parênteses é a contagem de itens visíveis naquele momento (muda a
// cada ciclo de coleta, não é parte da etapa) e o scraper lê esse texto como
// veio. Sem limpar aqui, a coluna fica inconsistente com o resto do banco
// (calendario_leitura.etapa é sempre só o número, "09", "18" etc.) e quebra
// qualquer JOIN por etapa. Extrai só o número e normaliza pra 2 dígitos.
function limparEtapa(valor) {
  const numero = String(valor ?? '').match(/\d+/)?.[0];
  return numero ? numero.padStart(2, '0') : (valor || null);
}

// Mesma regex de SITUACAO_REGEX (atividadeColaboradoresService.js): a
// coluna crua vem como "Em Execução (CPO-NOME DO COLABORADOR)" ou
// "Atribuída (CPO-NOME)". Separa em situação (só a palavra) e colaborador
// (só o nome, sem o prefixo tipo "CPO-"). "Pendente" nunca tem colaborador
// atribuído — não bate no regex, cai no fallback.
const SITUACAO_COM_COLABORADOR = /^(Em Execução|Atribuída)\s*\(([^)-]*)-(.*)\)$/;

function parseSituacaoColaborador(valorBruto) {
  const texto = String(valorBruto ?? '').trim();
  const match = SITUACAO_COM_COLABORADOR.exec(texto);
  if (match) {
    return { situacao: match[1], colaborador: match[3].trim() };
  }
  return { situacao: texto || null, colaborador: null };
}

async function importarParaPostgres(db, registros, empresaId) {
  if (!registros.length) {
    log('⚠️ Nenhum registro para importar.');
    return { inseridos: 0 };
  }

  const agora = new Date();
  const dataImport = agora.toLocaleDateString('pt-BR');
  const horaImport = agora.toLocaleTimeString('pt-BR');

  log(`[Coleta Acomp] 📥 Inserindo ${registros.length} registros na tabela 'contr_execucao_leitura'...`);

  const colunas = [...CAMPOS_TABELA, 'data_import', 'hora_import', 'empresa_id'];
  const linhas = registros.map(reg => {
    const { situacao, colaborador } = parseSituacaoColaborador(reg.situacaoBruta);
    const obj = {
      etapa: limparEtapa(reg.etapa),
      localidade: reg.localidade || null,
      livro: reg.livro || null,
      empreiteira: reg.empreiteira || null,
      data_recebimento: reg.dataRecebimento || null,
      hora_recebimento: reg.horaRecebimento || null,
      data_prevista_limite: reg.dataPrevistaLimite || null,
      situacao,
      colaborador,
      uc: reg.uc || null,
      codigo: reg.codigo || null,
      equipamento: reg.equipamento || null,
      tipo_especificacao: reg.tipoEspecificacao || null,
      faturamento: reg.faturamento || null,
      leitura_atual: reg.leituraAtual || null,
      data_import: dataImport,
      hora_import: horaImport,
      empresa_id: empresaId,
    };
    return colunas.map(campo => obj[campo]);
  });

  let totalInseridos = 0;
  let lotesComFalha = 0;
  let linhasPerdidas = 0;
  const totalLotes = Math.ceil(linhas.length / LOTE_MAX_LINHAS);
  for (let inicio = 0; inicio < linhas.length; inicio += LOTE_MAX_LINHAS) {
    const numeroLote = inicio / LOTE_MAX_LINHAS + 1;
    const lote = linhas.slice(inicio, inicio + LOTE_MAX_LINHAS);
    const valores = [];
    const placeholders = lote.map((linha, i) => {
      valores.push(...linha);
      const base = i * colunas.length;
      return `(${colunas.map((_, j) => `$${base + j + 1}`).join(', ')})`;
    });

    const sql = `INSERT INTO contr_execucao_leitura (${colunas.join(', ')}) VALUES ${placeholders.join(', ')}`;

    // db é uma transação real por ciclo (abrirContextoTenant) — sem
    // SAVEPOINT, um erro num ÚNICO lote (linha malformada, valor fora do
    // tipo esperado etc.) "envenena" a transação inteira (comportamento
    // padrão do Postgres: "current transaction is aborted" pra qualquer
    // comando seguinte), e o catch de coletaJob.js faz ROLLBACK — perdendo
    // TODOS os lotes já inseridos com sucesso na mesma chamada, não só o
    // problemático. Um ciclo real pode ter 60+ lotes de até 300 linhas
    // (~18 mil UCs); perder o ciclo inteiro por causa de ~300 linhas ruins
    // não é aceitável dado o pedido explícito de não perder dado. Mesmo
    // padrão já usado em importacaoService.js (ADR 0021 Adendo 3) pro
    // mesmo tipo de problema.
    await db.query(`SAVEPOINT lote_import_${numeroLote}`);
    try {
      const { rowCount } = await db.query(sql, valores);
      await db.query(`RELEASE SAVEPOINT lote_import_${numeroLote}`);
      totalInseridos += rowCount;
      log(`[Coleta Acomp] 📥 Lote ${numeroLote}/${totalLotes} inserido (${totalInseridos}/${linhas.length}).`);
    } catch (erroLote) {
      await db.query(`ROLLBACK TO SAVEPOINT lote_import_${numeroLote}`);
      lotesComFalha++;
      linhasPerdidas += lote.length;
      logErro(
        `[Coleta Acomp] ❌ Lote ${numeroLote}/${totalLotes} falhou ao inserir (${lote.length} linha(s) perdida(s) ` +
          `SÓ deste lote, os demais lotes seguem intactos): ${erroLote.message}`,
      );
    }
  }

  if (lotesComFalha > 0) {
    logWarn(
      `[Coleta Acomp] ⚠️ ${lotesComFalha} lote(s) de ${totalLotes} falharam ao importar — ` +
        `${linhasPerdidas} linha(s) não gravada(s) neste ciclo. Investigar os erros acima; ` +
        'as UCs desses lotes específicos ficam sem registro até o próximo ciclo re-coletar.',
    );
  }

  log(`[Coleta Acomp] ✅ ${totalInseridos} registros inseridos com sucesso.`);
  return { inseridos: totalInseridos, lotesComFalha, linhasPerdidas };
}

module.exports = { importarParaPostgres };
