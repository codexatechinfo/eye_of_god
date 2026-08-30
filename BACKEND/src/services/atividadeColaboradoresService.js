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

function hojeIso() {
  const agora = new Date();
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}-${String(agora.getDate()).padStart(2, '0')}`;
}

// "YYYY-MM-DD" (formato do <input type="date"> do frontend) -> "DD/MM/YYYY"
// (formato de contr_execucao_leitura.data_import). Sem validação de
// intervalo aqui — uma data sem dado simplesmente devolve listas vazias.
function isoParaDataBr(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso || '').trim());
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

// Mesma regra de massivasService.js (condicaoTipoServico/TIPO_SERVICO_CONTR_SQL,
// ADR 0012 Adendo 8): sem data_recebimento ainda, não dá pra saber se vai
// virar leitura ou releitura; recebido antes do prazo é leitura, recebido no
// prazo ou depois já é releitura (usuário confirmou: data_recebimento >=
// data_prevista_limite é releitura, não só estritamente depois).
function classificarTipoServico(dataRecebimento, dataPrevistaLimite) {
  if (!dataRecebimento) return null;
  const recebimento = paraDataOrdenavel(dataRecebimento);
  const prevista = paraDataOrdenavel((dataPrevistaLimite || '').split(' ')[0]);
  if (!recebimento || !prevista) return null;
  return recebimento < prevista ? 'leitura' : 'releitura';
}

// "Dias do prazo regulatório" por livro — mesma fonte/fórmula de
// obterFaixasDias/EFETIVO_PRAZO_REG_SQL em massivasService.js (ADR 0012
// Adendo 4), só que calculada aqui em JS em vez de SQL: como "hoje" (o valor
// de data_import) é constante pra toda a consulta de listarAtividadeHoje, um
// mapa livro->efetivo buscado uma vez só é mais simples e mais barato que
// juntar prazo_reg_livros numa query que já processa todas as linhas cruas
// do dia. prazo_reg_livros é só consulta (nunca fonte de linha, mesma regra
// da ADR 0012) — livro sem correspondência no mapa fica null, "não
// avaliado", nunca 0.
//
// Confirmado com o usuário: só vale pra LEITURA urbana (etapa 01-19) —
// releitura e etapa rural (21-38) ficam de fora mesmo quando o número do
// livro bate (o mesmo livro pode ter sido leitura antes e virar releitura
// depois); massiva nunca teve essa correspondência. Quem chama este mapa
// (listarAtividadeHoje) precisa checar tipoServico === 'leitura' e etapa
// urbana antes de usar o valor — ver massivasService.js pro mesmo filtro em
// SQL.
// dataConsultaIso ("YYYY-MM-DD"): mês de referência do prazo regulatório é
// o da data CONSULTADA, não necessariamente o mês corrente — importa ao
// navegar pra uma data passada de um mês diferente do atual.
async function obterMapaPrazoRegulatorio(db, dataConsultaIso) {
  const { rows } = await db.query(
    `
    SELECT livro, dias_finais, prazo_calendario
    FROM prazo_reg_livros
    WHERE mes_ref = to_char(date_trunc('month', $1::date), 'YYYY-MM-DD')
    `,
    [dataConsultaIso || hojeIso()],
  );
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
// massivasService.js). Pega o batch mais recente de cada tabela DENTRO da
// data pedida (não o mais recente de sempre) — pra consulta de data
// passada refletir a massiva daquele dia, não a de hoje.
//
// Cada tabela pode ter mais de uma linha por (leiturista, livro) — o mesmo
// padrão de sub-lote visto em massivasService.contarFonteMassiva/detalheMassiva
// — então dedup igual lá: dentro da mesma categoria fica com a linha de
// menor quantidade restante (mais avançada); entre categorias, "Em Execução"
// vence "Atribuída".
async function listarColaboradoresMassivaHoje(db, dataBr) {
  const restante = `(CASE WHEN t.qtd_digitados_nao_digitados ~ '^[0-9]+/[0-9]+$'
    THEN split_part(t.qtd_digitados_nao_digitados, '/', 1)::int + split_part(t.qtd_digitados_nao_digitados, '/', 2)::int
    ELSE 0 END)`;

  const { rows: linhas } = await db.query(`
    WITH ultimo_atribuidas AS (
      SELECT dt_import, hr_import FROM atribuidas_im WHERE dt_import = $1 ORDER BY id DESC LIMIT 1
    ), ultimo_execucao AS (
      SELECT dt_import, hr_import FROM em_execucao_im WHERE dt_import = $1 ORDER BY id DESC LIMIT 1
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
  `, [dataBr]);

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
      // Massiva só olha o lote mais recente (sem histórico de lotes
      // anteriores pra comparar), então não dá pra saber se uma UC foi
      // realizada de fato neste ciclo — fica sempre null aqui.
      ultimaExecucao: null,
      historico: [{ horaImport: linha.hr_import, situacao: linha.situacao, digitados, naoDigitados }],
    });
  }

  return porColaborador;
}

// Estado de `digitados` de cada livro no ÚLTIMO lote ANTES do dia
// consultado — usado como ponto de partida pra detectar UC realizada
// justo no primeiro lote de hoje. A coleta roda 24h contínua (ADR 0020);
// o "primeiro lote de hoje" de um livro não é necessariamente logo cedo,
// e pode já vir depois de leituras feitas mais cedo no mesmo dia, antes do
// scraper ter passado por ele. Sem esse baseline, comparar só dentro dos
// lotes de hoje (anterior = null no primeiro) não detecta essas execuções
// — usuário perguntou justamente se "sincronismo" refletia UC executada de
// verdade; esse é o caso em que ficaria escondido sem essa consulta.
// `id` (não `data_import`) decide "antes de hoje": monotonicamente
// crescente com o horário real de inserção, não sofre do formato texto
// DD/MM/YYYY.
async function obterBaselineDigitadosPorLivro(db, hoje) {
  const { rows } = await db.query(
    `
    WITH corte_do_dia AS (
      -- "Antes do dia consultado" tem que ser por id, não por
      -- data_import <> $1 — essa comparação pegaria dado de dias
      -- SEGUINTES também (ex.: virou a data em tempo real desde que o
      -- usuário abriu a tela, já existe coleta do dia seguinte na tabela).
      -- id < primeiro id do dia consultado é a única forma correta de
      -- dizer "estado no fim do dia anterior".
      SELECT MIN(id) AS primeiro_id FROM contr_execucao_leitura WHERE data_import = $1
    ), livros_do_dia AS (
      SELECT DISTINCT livro FROM contr_execucao_leitura WHERE data_import = $1
    ), ultimo_lote_anterior AS (
      SELECT DISTINCT ON (c.livro) c.livro, c.data_import, c.hora_import
      FROM contr_execucao_leitura c
      JOIN livros_do_dia ld ON ld.livro = c.livro
      CROSS JOIN corte_do_dia cd
      WHERE c.id < cd.primeiro_id
      ORDER BY c.livro, c.id DESC
    ), baseline_dedup AS (
      SELECT DISTINCT ON (c.livro, c.uc) c.livro, c.uc, c.codigo
      FROM contr_execucao_leitura c
      JOIN ultimo_lote_anterior u ON u.livro = c.livro AND u.data_import = c.data_import AND u.hora_import = c.hora_import
      WHERE c.uc IS NOT NULL
      ORDER BY c.livro, c.uc, c.id DESC
    )
    SELECT livro, SUM(CASE WHEN codigo IS NOT NULL THEN 1 ELSE 0 END)::int AS digitados
    FROM baseline_dedup
    GROUP BY livro
    `,
    [hoje],
  );
  return new Map(rows.map(linha => [linha.livro, linha.digitados]));
}

// dataIso ("YYYY-MM-DD", mesmo formato do <input type="date"> do
// frontend): quando informada, consulta a atividade DAQUELE dia em vez de
// hoje — usuário pediu pra poder navegar dias de execução passados pelo
// calendário da aba Trilho. undefined/null continua consultando hoje.
async function listarAtividadeHoje(db, dataIso) {
  const hojeIsoConsultado = dataIso || hojeIso();
  const hoje = isoParaDataBr(hojeIsoConsultado) || new Date().toLocaleDateString('pt-BR');

  // Agregado por (livro, hora_import) — um livro agora tem várias linhas
  // (uma por UC/medidor, ver ADR 0018 Adendo 2), todas compartilhando o
  // mesmo cabeçalho (etapa/situacao/colaborador/datas) dentro do mesmo
  // ciclo de coleta; sem esse GROUP BY a query devolveria N linhas quase
  // idênticas por livro em vez de uma por snapshot. `colaborador` já vem
  // separado da coluna própria (populada no import — ver
  // parseSituacaoColaborador em copelImportService.js), não precisa mais
  // ser extraído de dentro de `situacao` via regex.
  const [{ rows: linhas }, mapaPrazoRegulatorio, baselinePorLivro] = await Promise.all([
    db.query(
      `
      WITH linhas_dedup AS (
        -- O scraper às vezes grava a mesma UC mais de uma vez dentro do
        -- MESMO lote (mesmo hora_import, até com codigo diferente entre as
        -- cópias) — usuário reportou um caso real: livro com 348 linhas
        -- brutas mas só 273 UCs distintas naquele lote. Sem este DISTINCT ON,
        -- o SUM(...) abaixo conta a UC duplicada mais de uma vez, inflando
        -- digitados/nao_digitados/impedimentos em relação ao painel de
        -- detalhe do livro (que já deduplica por UC — ver
        -- listarUcsAtuaisDoLivro em massivasService.js). id (bigserial,
        -- estritamente cronológico) desempata de forma determinística —
        -- hora_import só tem granularidade de segundo e não distingue
        -- duplicatas do mesmo lote.
        SELECT DISTINCT ON (livro, hora_import, uc)
          id, livro, etapa, situacao, colaborador, hora_import,
          data_recebimento, data_prevista_limite, codigo
        FROM contr_execucao_leitura
        WHERE data_import = $1
          AND situacao IS NOT NULL
          AND situacao <> 'Pendente'
        ORDER BY livro, hora_import, uc, id DESC
      )
      SELECT livro, etapa, situacao, colaborador, hora_import,
        data_recebimento, data_prevista_limite,
        SUM(CASE WHEN codigo IS NOT NULL THEN 1 ELSE 0 END)::int AS digitados,
        SUM(CASE WHEN codigo IS NULL THEN 1 ELSE 0 END)::int AS nao_digitados,
        SUM(CASE WHEN codigo IS NOT NULL AND codigo NOT IN ('000', '099') THEN 1 ELSE 0 END)::int AS impedimentos
      FROM linhas_dedup
      GROUP BY livro, etapa, situacao, colaborador, hora_import, data_recebimento, data_prevista_limite
      ORDER BY hora_import ASC, MIN(id) ASC
      `,
      [hoje],
    ),
    obterMapaPrazoRegulatorio(db, hojeIsoConsultado),
    obterBaselineDigitadosPorLivro(db, hoje),
  ]);

  const porColaborador = new Map();
  let ultimaHoraGeral = null;

  for (const linha of linhas) {
    const nome = (linha.colaborador || '').trim();
    if (!nome) continue;

    const digitados = linha.digitados;
    const naoDigitados = linha.nao_digitados;
    const impedimentos = linha.impedimentos;
    // etapa vem às vezes como "ETAPA 09 - (66)" (contagem que varia a cada
    // ciclo) e às vezes já limpa ("09"); fica só com o número.
    const etapaLimpa = (linha.etapa || '').match(/\d+/)?.[0] ?? linha.etapa;
    const entrada = {
      horaImport: linha.hora_import,
      livro: linha.livro,
      etapa: etapaLimpa,
      situacao: linha.situacao,
      digitados,
      naoDigitados,
      impedimentos,
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
      // "Último sincronismo" tem que significar UC realizada de fato
      // (digitados aumentando), não qualquer mudança no lote — usuário
      // reportou o sintoma certo: uma troca de situação sozinha (ex.:
      // "Atribuída" -> "Em Execução", assumiu o livro mas ainda não leu
      // nenhuma UC) fazia o sincronismo avançar sem nenhuma leitura
      // acontecer. `historico` continua registrando qualquer mudança (útil
      // pra mostrar a evolução do status do livro), mas o horário do
      // sincronismo agora vem só daqui.
      let ultimaExecucaoLivro = null;
      // Ponto de partida pra detectar UC realizada logo no PRIMEIRO lote de
      // hoje — sem isso, `digitadosAnterior` começaria null e uma execução
      // que já tivesse acontecido antes do primeiro scraping de hoje
      // passaria despercebida (ver obterBaselineDigitadosPorLivro).
      let digitadosAnterior = baselinePorLivro.get(livro) ?? null;
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
        if (digitadosAnterior !== null && entrada.digitados > digitadosAnterior) {
          ultimaExecucaoLivro = entrada.horaImport;
        }
        digitadosAnterior = entrada.digitados;
        anterior = entrada;
      }

      const primeira = lista[0];
      const ultima = lista[lista.length - 1];
      if (ultimaExecucaoLivro && (!ultimaMudancaColaborador || ultimaExecucaoLivro > ultimaMudancaColaborador)) {
        ultimaMudancaColaborador = ultimaExecucaoLivro;
      }

      const tipoServico = classificarTipoServico(ultima.dataRecebimento, ultima.dataPrevistaLimite);
      const etapaUrbana = Number(ultima.etapa) >= 1 && Number(ultima.etapa) <= 19;
      const prazoRegulatorio = tipoServico === 'leitura' && etapaUrbana ? mapaPrazoRegulatorio.get(Number(livro)) : null;

      livros.push({
        livro,
        etapa: ultima.etapa,
        situacaoAtual: ultima.situacao,
        digitados: ultima.digitados,
        naoDigitados: ultima.naoDigitados,
        impedimentos: ultima.impedimentos,
        tipoServico,
        diasPrazoRegulatorio: prazoRegulatorio
          ? calcularDiasPrazoRegulatorio(hoje, prazoRegulatorio.prazoCalendario, prazoRegulatorio.diasFinais)
          : null,
        primeiraVez: primeira.horaImport,
        ultimaVez: ultima.horaImport,
        // Último horário em que UMA UC de fato virou realizada hoje neste
        // livro (não confundir com ultimaVez, que é só o último lote
        // importado, independente de ter mudado algo) — null se nenhuma UC
        // foi realizada hoje (livro só teve o `digitados` de dias
        // anteriores, sem nada novo). Usado pro card "Último sincronismo"
        // do painel de detalhe (aba Trilho).
        ultimaExecucao: ultimaExecucaoLivro,
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
    // Soma de todos os livros do colaborador (não só o livro aberto no
    // painel de detalhe) — pedido explícito do usuário pro card
    // "Impedimentos" do card expandido do colaborador.
    const totalImpedimentos = livros.reduce((soma, livro) => soma + (livro.impedimentos || 0), 0);
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
      totalImpedimentos,
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
  const massivaPorColaborador = await listarColaboradoresMassivaHoje(db, hoje);
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
      // Mesma regra de "parado" já usada pra leitura/releitura (linha 259):
      // tem serviço hoje mas ainda não realizou nada. Estava fixo em
      // ativo:true/parado:false pra todo colaborador só-massiva, mesmo quem
      // tinha 0 executadas — usuário reportou colaborador com REALIZADAS: 0
      // aparecendo como "ativo".
      const paradoMassiva = digitadosMassiva === 0;
      colaboradores.push({
        colaborador: nome,
        totalRealizadas: digitadosMassiva,
        totalPendentes: pendentesMassiva,
        // Massiva não tem coluna "codigo" (fonte é atribuidas_im/em_execucao_im,
        // não contr_execucao_leitura) — impedimento só existe pra leitura/releitura.
        totalImpedimentos: 0,
        totalLivros: livrosMassiva.length,
        totalEmExecucao: emExecucaoMassiva,
        ultimaMudancaHora: livrosMassiva[0].ultimaVez,
        minutosParado: 0,
        parado: paradoMassiva,
        ativo: !paradoMassiva,
        semSincronismo: false,
        livros: livrosMassiva,
      });
    }
  }

  // Três fontes de justificativa de ausência — atestados primeiro (tem
  // motivo/INSS, mais detalhado), licença de ativos_inativos e suspensão da
  // tabela suspensao só preenchem quem não tinha nada nas fontes anteriores.
  const [afastamentosHoje, licencasHoje, suspensoesHoje] = await Promise.all([
    obterAfastamentosHoje(db, hojeIsoConsultado),
    obterLicencasAtivosInativosHoje(db, hojeIsoConsultado),
    obterSuspensoesHoje(db, hojeIsoConsultado),
  ]);
  for (const [nome, info] of Object.entries(licencasHoje)) {
    if (!afastamentosHoje[nome]) afastamentosHoje[nome] = info;
  }
  for (const [nome, info] of Object.entries(suspensoesHoje)) {
    if (!afastamentosHoje[nome]) afastamentosHoje[nome] = info;
  }

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

async function obterAfastamentosHoje(db, dataConsultaIso) {
  const dataRef = dataConsultaIso || hojeIso();

  const { rows: linhas } = await db.query(`
    SELECT colaborador, data_afastamento, data_retorno, qtd_dias_afastado, "afastado_INSS", motivo_afastamento
    FROM atestados
  `);

  const porColaborador = {};

  for (const linha of linhas) {
    const inicio = paraDataIso(linha.data_afastamento);
    const fim = paraDataIso(linha.data_retorno);
    if (!inicio || !fim) continue;
    if (!(inicio <= dataRef && dataRef < fim)) continue;

    porColaborador[linha.colaborador] = {
      origem: 'atestado',
      dataAfastamento: inicio,
      dataRetorno: fim,
      qtdDiasAfastado: linha.qtd_dias_afastado,
      afastadoInss: linha.afastado_INSS,
      motivoAfastamento: linha.motivo_afastamento,
    };
  }

  return porColaborador;
}

// Segunda fonte de justificativa de ausência, além de atestados: RH marca
// licença/afastamento em ativos_inativos.situacao no formato "A2 -
// DD/MM/YYYY" (data de início), com volta_afastamento trazendo a data de
// retorno ("YYYY-MM-DD") ou o texto "INDETERMINADO" quando ainda não
// definida. Só entra se hoje já está dentro do período — data de início já
// chegou e (retorno indeterminado OU ainda não chegou a data de retorno).
async function obterLicencasAtivosInativosHoje(db, dataConsultaIso) {
  const dataRef = dataConsultaIso || hojeIso();

  const { rows: linhas } = await db.query(`
    SELECT colaborador, situacao, volta_afastamento
    FROM ativos_inativos
    WHERE situacao ILIKE 'A2 - %'
  `);

  const porColaborador = {};

  for (const linha of linhas) {
    const match = /^A2\s*-\s*(\d{2})\/(\d{2})\/(\d{4})$/.exec((linha.situacao || '').trim());
    if (!match) continue;
    const inicio = `${match[3]}-${match[2]}-${match[1]}`;
    if (dataRef < inicio) continue;

    const voltaTexto = (linha.volta_afastamento || '').trim();
    const indeterminado = voltaTexto.toUpperCase() === 'INDETERMINADO';
    const fim = indeterminado ? null : paraDataIso(voltaTexto);
    if (!indeterminado && fim && dataRef >= fim) continue;

    porColaborador[linha.colaborador] = {
      origem: 'licenca',
      dataAfastamento: inicio,
      dataRetorno: fim,
      qtdDiasAfastado: null,
      afastadoInss: null,
      motivoAfastamento: indeterminado ? 'Afastado por tempo indeterminado' : null,
    };
  }

  return porColaborador;
}

// Terceira fonte de justificativa de ausência: tabela suspensao (importada
// manualmente por planilha, ver importacaoConfig.js — modo "substituir",
// recarrega tudo a cada import), uma linha por dia de falta justificada
// (data_falta), não um período com início/fim como atestado/licença. "Hoje
// contempla" aqui é: existe uma linha com data_falta = hoje. Igual às outras
// duas fontes, só preenche quem ainda não tem entrada (prioridade menor).
async function obterSuspensoesHoje(db, dataConsultaIso) {
  const dataRef = dataConsultaIso || hojeIso();

  const { rows: linhas } = await db.query(`
    SELECT colaborador, data_falta, justificativa, observacao
    FROM suspensao
  `);

  const porColaborador = {};

  for (const linha of linhas) {
    const data = paraDataIso(linha.data_falta);
    if (!data || data !== dataRef) continue;

    porColaborador[linha.colaborador] = {
      origem: 'suspensao',
      dataAfastamento: data,
      dataRetorno: data,
      qtdDiasAfastado: '1',
      afastadoInss: null,
      motivoAfastamento: linha.justificativa || linha.observacao || 'Suspensão/falta justificada',
    };
  }

  return porColaborador;
}

module.exports = { listarAtividadeHoje };
