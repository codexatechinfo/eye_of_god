const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const SITUACAO_REGEX = /^(Em Execução|Atribuída)\s*\(([^)-]*)-(.*)\)$/;
const QTD_REGEX = /^(\d+)\/(\d+)$/;
const LIMITE_PARADO_MINUTOS = 20;

function parseQtd(str) {
  const match = QTD_REGEX.exec(str || '');
  if (!match) return { digitados: 0, naoDigitados: 0 };
  return { digitados: parseInt(match[1], 10), naoDigitados: parseInt(match[2], 10) };
}

function paraMinutosDoDia(horaStr) {
  const [h, m, s] = (horaStr || '0:0:0').split(':').map(Number);
  return h * 60 + m + (s || 0) / 60;
}

function diferencaMinutos(horaAntiga, horaRecente) {
  return Math.max(0, Math.round(paraMinutosDoDia(horaRecente) - paraMinutosDoDia(horaAntiga)));
}

async function listarAtividadeHoje() {
  const hoje = new Date().toLocaleDateString('pt-BR');

  const linhas = await prisma.$queryRawUnsafe(
    `
    SELECT livro, etapa, situacao, qtd_digitados_nao_digitados, hora_import
    FROM contr_execucao_leitura
    WHERE data_import = $1
      AND situacao IS NOT NULL
      AND situacao <> 'Pendente'
    ORDER BY hora_import ASC, id ASC
    `,
    hoje,
  );

  const porColaborador = new Map();
  let ultimaHoraGeral = null;

  for (const linha of linhas) {
    const match = SITUACAO_REGEX.exec((linha.situacao || '').trim());
    if (!match) continue;

    const nome = match[3].trim();
    const { digitados, naoDigitados } = parseQtd(linha.qtd_digitados_nao_digitados);
    // etapa vem às vezes como "ETAPA 09 - (66)" (contagem que varia a cada
    // ciclo) e às vezes já limpa ("09"); fica só com o número.
    const etapaLimpa = (linha.etapa || '').match(/\d+/)?.[0] ?? linha.etapa;
    const entrada = {
      horaImport: linha.hora_import,
      livro: linha.livro,
      etapa: etapaLimpa,
      situacao: match[1],
      digitados,
      naoDigitados,
    };

    if (!porColaborador.has(nome)) porColaborador.set(nome, []);
    porColaborador.get(nome).push(entrada);
    ultimaHoraGeral = linha.hora_import;
  }

  const colaboradores = [];

  for (const [nome, entradas] of porColaborador) {
    // Um colaborador pode ter vários livros em execução ao mesmo tempo, então as
    // entradas de livros diferentes se intercalam na ordem cronológica geral.
    // Agrupamos por livro para detectar mudanças reais e montar o histórico de cada um.
    const entradasPorLivro = new Map();
    for (const entrada of entradas) {
      if (!entradasPorLivro.has(entrada.livro)) entradasPorLivro.set(entrada.livro, []);
      entradasPorLivro.get(entrada.livro).push(entrada);
    }

    const livros = [];
    let ultimaMudancaColaborador = null;

    for (const [livro, lista] of entradasPorLivro) {
      const historico = [];
      let anterior = null;
      for (const entrada of lista) {
        const inalterado =
          anterior &&
          anterior.situacao === entrada.situacao &&
          anterior.digitados === entrada.digitados &&
          anterior.naoDigitados === entrada.naoDigitados;
        if (!inalterado) {
          historico.push({
            horaImport: entrada.horaImport,
            situacao: entrada.situacao,
            digitados: entrada.digitados,
            naoDigitados: entrada.naoDigitados,
          });
        }
        anterior = entrada;
      }

      const primeira = lista[0];
      const ultima = lista[lista.length - 1];
      const ultimaMudancaLivro = historico[historico.length - 1].horaImport;
      if (!ultimaMudancaColaborador || ultimaMudancaLivro > ultimaMudancaColaborador) {
        ultimaMudancaColaborador = ultimaMudancaLivro;
      }

      livros.push({
        livro,
        etapa: ultima.etapa,
        situacaoAtual: ultima.situacao,
        digitados: ultima.digitados,
        naoDigitados: ultima.naoDigitados,
        primeiraVez: primeira.horaImport,
        ultimaVez: ultima.horaImport,
        historico,
      });
    }

    livros.sort((a, b) => a.primeiraVez.localeCompare(b.primeiraVez));

    // Nem todos os livros de um colaborador aparecem em todo ciclo de coleta (a etapa
    // deles pode não ter sido revisitada naquele ciclo), então cada livro pode ter seu
    // próprio "último visto" diferente. O status "atual" de cada livro é simplesmente
    // o último status conhecido dele, independente de quando foi visto.
    const livrosEmExecucao = livros.filter(livro => livro.situacaoAtual === 'Em Execução');
    const totalEmExecucao = livrosEmExecucao.length;
    const totalRealizadas = livros.reduce((soma, livro) => soma + livro.digitados, 0);
    const totalPendentes = livros.reduce((soma, livro) => soma + livro.naoDigitados, 0);
    const minutosParado = diferencaMinutos(ultimaMudancaColaborador, ultimaHoraGeral);

    // Quatro categorias mutuamente exclusivas (a quinta, "sem serviço", é
    // implícita: colaborador que nem aparece aqui, sem nenhuma atividade hoje):
    //  - parado: tem serviço hoje mas não executou nenhuma leitura ainda.
    //  - ativo: já realizou leituras e sincronizou recentemente (< 20min).
    //  - semSincronismo: já realizou leituras, mas o último sincronismo foi há muito tempo.
    const parado = totalRealizadas === 0;
    const semSincronismo = totalRealizadas > 0 && minutosParado >= LIMITE_PARADO_MINUTOS;
    const ativo = totalRealizadas > 0 && minutosParado < LIMITE_PARADO_MINUTOS;

    colaboradores.push({
      colaborador: nome,
      totalRealizadas,
      totalPendentes,
      totalLivros: livros.length,
      totalEmExecucao,
      ultimaMudancaHora: ultimaMudancaColaborador,
      minutosParado,
      parado,
      ativo,
      semSincronismo,
      livros,
    });
  }

  const afastamentosHoje = await obterAfastamentosHoje();

  return { data: hoje, ultimaHoraGeral, colaboradores, afastamentosHoje };
}

// atestados.data_afastamento/data_retorno vêm quase sempre como "YYYY-MM-DD",
// mas há linhas malformadas ("DD/MM/YYYY", ou até com erro de digitação tipo
// "02/09/026"); tenta os formatos conhecidos e ignora o que não der pra
// interpretar em vez de derrubar a consulta inteira.
function paraDataIso(str) {
  if (!str) return null;
  const s = str.trim();

  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = /^(\d{2})\/(\d{2})\/(\d{2,4})$/.exec(s);
  if (m) {
    let ano = m[3];
    if (ano.length === 3) ano = `2${ano}`;
    else if (ano.length === 2) ano = `20${ano}`;
    return `${ano}-${m[2]}-${m[1]}`;
  }

  return null;
}

async function obterAfastamentosHoje() {
  const agora = new Date();
  const hojeIso = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}-${String(agora.getDate()).padStart(2, '0')}`;

  const linhas = await prisma.$queryRawUnsafe(`
    SELECT colaborador, data_afastamento, data_retorno, qtd_dias_afastado, "afastado_INSS", motivo_afastamento
    FROM atestados
  `);

  const porColaborador = {};

  for (const linha of linhas) {
    const inicio = paraDataIso(linha.data_afastamento);
    const fim = paraDataIso(linha.data_retorno);
    if (!inicio || !fim) continue;
    if (!(inicio <= hojeIso && hojeIso < fim)) continue;

    porColaborador[linha.colaborador] = {
      dataAfastamento: inicio,
      dataRetorno: fim,
      qtdDiasAfastado: linha.qtd_dias_afastado,
      afastadoInss: linha.afastado_INSS,
      motivoAfastamento: linha.motivo_afastamento,
    };
  }

  return porColaborador;
}

module.exports = { listarAtividadeHoje };
