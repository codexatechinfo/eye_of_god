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

// "DD/MM/YYYY" -> "YYYY-MM-DD", só pra poder comparar duas datas como string.
function paraDataOrdenavel(dataStr) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((dataStr || '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Mesma regra da ADR 0006 (massivasService.js, condicaoTipoServico): sem
// data_recebimento ainda, não dá pra saber se vai virar leitura ou
// releitura; recebido até o prazo é leitura, depois do prazo é releitura.
function classificarTipoServico(dataRecebimento, dataPrevistaLimite) {
  if (!dataRecebimento) return null;
  const recebimento = paraDataOrdenavel(dataRecebimento);
  const prevista = paraDataOrdenavel((dataPrevistaLimite || '').split(' ')[0]);
  if (!recebimento || !prevista) return null;
  return recebimento <= prevista ? 'leitura' : 'releitura';
}

// "Dias do prazo regulatório" por livro — mesma fonte/fórmula de
// obterFaixasDias/EFETIVO_PRAZO_REG_SQL em massivasService.js (ADR 0012
// Adendo 4), só que calculada aqui em JS em vez de SQL: como "hoje" (o valor
// de data_import) é constante pra toda a consulta de listarAtividadeHoje, um
// mapa livro->efetivo buscado uma vez só é mais simples e mais barato que
// juntar prazo_reg_livros numa query que já processa todas as linhas cruas
// do dia. prazo_reg_livros é só consulta (nunca fonte de linha, mesma regra
// da ADR 0012) — livro sem correspondência no mapa fica null, "não
// avaliado", nunca 0. Só vale pra leitura/releitura (livro de massiva não
// tem essa correspondência — nunca fez sentido pra esse escopo).
async function obterMapaPrazoRegulatorio(db) {
  const { rows } = await db.query(`
    SELECT livro, dias_finais, prazo_calendario
    FROM prazo_reg_livros
    WHERE mes_ref = to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM-DD')
  `);
  const mapa = new Map();
  for (const linha of rows) {
    const chave = Number(linha.livro);
    if (Number.isFinite(chave)) {
      mapa.set(chave, { diasFinais: Number(linha.dias_finais), prazoCalendario: linha.prazo_calendario });
    }
  }
  return mapa;
}

// hoje: "DD/MM/YYYY" (mesmo formato de data_import); prazoCalendario: "YYYY-MM-DD".
function calcularDiasPrazoRegulatorio(hoje, prazoCalendario, diasFinais) {
  const [d, m, a] = hoje.split('/').map(Number);
  const hojeMs = Date.UTC(a, m - 1, d);
  const [pa, pm, pd] = prazoCalendario.split('-').map(Number);
  const prazoMs = Date.UTC(pa, pm - 1, pd);
  const diffDias = Math.round((hojeMs - prazoMs) / 86400000);
  return diasFinais + diffDias;
}

// Só atribuidas_im/em_execucao_im têm leiturista (pendentes_im não tem
// ninguém atribuído ainda, então não entra aqui — ver TABELAS_MASSIVA em
// massivasService.js). Pega sempre o batch mais recente de cada tabela.
//
// Cada tabela pode ter mais de uma linha por (leiturista, livro) — o mesmo
// padrão de sub-lote visto em massivasService.contarFonteMassiva/detalheMassiva
// — então dedup igual lá: dentro da mesma categoria fica com a linha de
// menor quantidade restante (mais avançada); entre categorias, "Em Execução"
// vence "Atribuída".
async function listarColaboradoresMassivaHoje(db) {
  const restante = `(CASE WHEN t.qtd_digitados_nao_digitados ~ '^[0-9]+/[0-9]+$'
    THEN split_part(t.qtd_digitados_nao_digitados, '/', 1)::int + split_part(t.qtd_digitados_nao_digitados, '/', 2)::int
    ELSE 0 END)`;

  const { rows: linhas } = await db.query(`
    WITH ultimo_atribuidas AS (
      SELECT dt_import, hr_import FROM atribuidas_im ORDER BY id DESC LIMIT 1
    ), ultimo_execucao AS (
      SELECT dt_import, hr_import FROM em_execucao_im ORDER BY id DESC LIMIT 1
    ), atribuidas AS (
      SELECT DISTINCT ON (t.leiturista, t.livro)
        t.leiturista, t.livro, t.etapa, t.qtd_digitados_nao_digitados, t.hr_import,
        'Atribuída' AS situacao, 1 AS prioridade
      FROM atribuidas_im t, ultimo_atribuidas u
      WHERE t.dt_import = u.dt_import AND t.hr_import = u.hr_import AND t.leiturista IS NOT NULL
      ORDER BY t.leiturista, t.livro, ${restante} ASC
    ), execucao AS (
      SELECT DISTINCT ON (t.leiturista, t.livro)
        t.leiturista, t.livro, t.etapa, t.qtd_digitados_nao_digitados, t.hr_import,
        'Em Execução' AS situacao, 2 AS prioridade
      FROM em_execucao_im t, ultimo_execucao u
      WHERE t.dt_import = u.dt_import AND t.hr_import = u.hr_import AND t.leiturista IS NOT NULL
      ORDER BY t.leiturista, t.livro, ${restante} ASC
    )
    SELECT DISTINCT ON (leiturista, livro) leiturista, livro, etapa, qtd_digitados_nao_digitados, hr_import, situacao
    FROM (SELECT * FROM atribuidas UNION ALL SELECT * FROM execucao) unidos
    ORDER BY leiturista, livro, prioridade DESC
  `);

  const porColaborador = new Map();
  for (const linha of linhas) {
    const nome = (linha.leiturista || '').trim();
    if (!nome) continue;
    const { digitados, naoDigitados } = parseQtd(linha.qtd_digitados_nao_digitados);
    const etapaLimpa = (linha.etapa || '').match(/\d+/)?.[0] ?? linha.etapa;

    if (!porColaborador.has(nome)) porColaborador.set(nome, []);
    porColaborador.get(nome).push({
      livro: linha.livro,
      etapa: etapaLimpa,
      situacaoAtual: linha.situacao,
      digitados,
      naoDigitados,
      tipoServico: 'massiva',
      diasPrazoRegulatorio: null,
      primeiraVez: linha.hr_import,
      ultimaVez: linha.hr_import,
      historico: [{ horaImport: linha.hr_import, situacao: linha.situacao, digitados, naoDigitados }],
    });
  }

  return porColaborador;
}

async function listarAtividadeHoje(db) {
  const hoje = new Date().toLocaleDateString('pt-BR');

  const [{ rows: linhas }, mapaPrazoRegulatorio] = await Promise.all([
    db.query(
      `
      SELECT livro, etapa, situacao, qtd_digitados_nao_digitados, hora_import,
        data_recebimento, data_prevista_limite
      FROM contr_execucao_leitura
      WHERE data_import = $1
        AND situacao IS NOT NULL
        AND situacao <> 'Pendente'
      ORDER BY hora_import ASC, id ASC
      `,
      [hoje],
    ),
    obterMapaPrazoRegulatorio(db),
  ]);

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
      dataRecebimento: linha.data_recebimento,
      dataPrevistaLimite: linha.data_prevista_limite,
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

      const prazoRegulatorio = mapaPrazoRegulatorio.get(Number(livro));

      livros.push({
        livro,
        etapa: ultima.etapa,
        situacaoAtual: ultima.situacao,
        digitados: ultima.digitados,
        naoDigitados: ultima.naoDigitados,
        tipoServico: classificarTipoServico(ultima.dataRecebimento, ultima.dataPrevistaLimite),
        diasPrazoRegulatorio: prazoRegulatorio
          ? calcularDiasPrazoRegulatorio(hoje, prazoRegulatorio.prazoCalendario, prazoRegulatorio.diasFinais)
          : null,
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

  // Colaboradores só com massiva atribuída não aparecem em contr_execucao_leitura
  // (que é só leitura/releitura) e cairiam em "sem serviço" mesmo trabalhando —
  // mescla quem já está na lista e cria entrada nova pra quem só tem massiva.
  const massivaPorColaborador = await listarColaboradoresMassivaHoje(db);
  for (const [nome, livrosMassiva] of massivaPorColaborador) {
    const existente = colaboradores.find(c => c.colaborador === nome);
    const digitadosMassiva = livrosMassiva.reduce((soma, l) => soma + l.digitados, 0);
    const pendentesMassiva = livrosMassiva.reduce((soma, l) => soma + l.naoDigitados, 0);
    const emExecucaoMassiva = livrosMassiva.filter(l => l.situacaoAtual === 'Em Execução').length;

    if (existente) {
      existente.livros.push(...livrosMassiva);
      existente.totalRealizadas += digitadosMassiva;
      existente.totalPendentes += pendentesMassiva;
      existente.totalLivros += livrosMassiva.length;
      existente.totalEmExecucao += emExecucaoMassiva;
    } else {
      colaboradores.push({
        colaborador: nome,
        totalRealizadas: digitadosMassiva,
        totalPendentes: pendentesMassiva,
        totalLivros: livrosMassiva.length,
        totalEmExecucao: emExecucaoMassiva,
        ultimaMudancaHora: livrosMassiva[0].ultimaVez,
        minutosParado: 0,
        parado: false,
        ativo: true,
        semSincronismo: false,
        livros: livrosMassiva,
      });
    }
  }

  const afastamentosHoje = await obterAfastamentosHoje(db);

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

async function obterAfastamentosHoje(db) {
  const agora = new Date();
  const hojeIso = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}-${String(agora.getDate()).padStart(2, '0')}`;

  const { rows: linhas } = await db.query(`
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
