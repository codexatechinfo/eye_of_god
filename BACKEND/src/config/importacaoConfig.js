// Fonte da verdade de quais tabelas aceitam importação de arquivo, quais
// colunas o arquivo pode preencher (nunca id/empresa_id — id é serial,
// empresa_id vem sempre do usuário logado, nunca do arquivo) e a regra de
// substituição, definida pelo usuário em 2026-08-24 (ver docs/adr — ainda
// sem número, próxima ADR a registrar).
//
// modo 'substituir': cada import apaga o que já existe (escopado por
//   empresa quando a tabela tem empresa_id) e recarrega do arquivo inteiro.
// modo 'upsert': linha do arquivo cujas colunas de `chave` batem com uma
//   linha já existente (mesma empresa, quando aplicável) substitui essa
//   linha; senão é inserida como nova.
const CONFIG_IMPORTACAO = {
  atestados: {
    modo: 'substituir',
    temEmpresa: true,
    colunas: [
      'mes_ref', 'matricula', 'colaborador', 'cargo', 'base', 'data_afastamento',
      'data_retorno', 'qtd_dias_afastado', 'CID', 'medico', 'CRM', 'afastado_INSS',
      'motivo_afastamento',
    ],
  },
  ativos_inativos: {
    modo: 'substituir',
    temEmpresa: true,
    colunas: [
      'situacao', 'matricula', 'colaborador', 'cargo', 'base', 'admissao',
      '45_dias', '90_dias', 'volta_afastamento', 'demissao', 'observacao',
      'data_atualizacao',
    ],
  },
  atribuidas_im: {
    modo: 'upsert',
    temEmpresa: true,
    chave: ['numero_os', 'dt_rec_abertura', 'qtd_digitados_nao_digitados'],
    colunas: [
      'tipo_ss', 'subtipo_os', 'mr', 'numero_os', 'los', 'local', 'livro', 'etapa',
      'dt_rec_abertura', 'dt_prev_limite', 'numero_solicitacao', 'uc', 'bairro',
      'releitura', 'qtd_digitados_nao_digitados', 'leiturista', 'dt_import',
      'hr_import', 'mes_ref',
    ],
  },
  pendentes_im: {
    modo: 'upsert',
    temEmpresa: true,
    chave: ['numero_os', 'dt_rec_abertura', 'qtd_digitados_nao_digitados'],
    colunas: [
      'tipo_ss', 'subtipo_os', 'mr', 'numero_os', 'los', 'local', 'livro', 'etapa',
      'dt_rec_abertura', 'dt_prev_limite', 'numero_solicitacao', 'uc', 'bairro',
      'releitura', 'qtd_digitados_nao_digitados', 'dt_import', 'hr_import', 'mes_ref',
    ],
  },
  em_execucao_im: {
    modo: 'upsert',
    temEmpresa: true,
    chave: ['numero_os', 'dt_rec_abertura', 'qtd_digitados_nao_digitados'],
    colunas: [
      'tipo_ss', 'subtipo_os', 'mr', 'numero_os', 'los', 'local', 'livro', 'etapa',
      'dt_rec_abertura', 'dt_prev_limite', 'numero_solicitacao', 'uc', 'bairro',
      'releitura', 'qtd_digitados_nao_digitados', 'leiturista', 'dt_import',
      'hr_import', 'mes_ref',
    ],
  },
  contr_execucao_leitura: {
    modo: 'upsert',
    temEmpresa: true,
    chave: ['numero_os', 'data_recebimento', 'hora_recebimento', 'qtd_digitados_nao_digitados'],
    colunas: [
      'etapa', 'tipo_oss', 'subtipo_os', 'numero_os', 'localidade', 'livro',
      'empreiteira', 'data_recebimento', 'hora_recebimento', 'data_prevista_limite',
      'data_ultima_atualizacao', 'qtd_digitados_nao_digitados',
      'qtd_com_leitura_sem_leitura', 'percentual_sem_leitura', 'qtd_fora_de_faixa_foto',
      'situacao', 'data_import', 'hora_import',
    ],
  },
  control_empreiteiras: {
    modo: 'upsert',
    temEmpresa: true,
    chave: ['data_da_leitura', 'hora_da_leitura', 'nome_do_usuario', 'unidade_consumidora'],
    colunas: [
      'concessionaria', 'empreiteira', 'equipe', 'nome_do_usuario', 'mes_ref_livro',
      'data_da_leitura', 'hora_da_leitura', 'unidade_consumidora', 'codigo_da_localidade',
      'descricao_da_localidade', 'tipo_de_localizacao_da_uc', 'etapa', 'livro',
      'status_releitura', 'equipamento', 'especificacao', 'mensagem',
      'mensagem_auxiliar', 'observacao_de_campo', 'status_foto',
      'faturamento_em_campo', 'status_impressao_do_comunicado', 'forma_de_entrega',
    ],
  },
  // Ver ADR 0009 — deixou de ser compartilhada: cada empresa pode ter seu
  // próprio contrato/região, logo seu próprio calendário de prazos.
  calendario_leitura: {
    modo: 'upsert',
    temEmpresa: true,
    chave: ['mes_ref'],
    colunas: [
      'mes_ref', 'etapa', 'prazo_leitura', 'prazo_regulatorio', 'envio_releitura',
      'prazo_releitura', 'envio_massiva', 'prazo_massiva', 'vencimento_fatura',
      'envio_leitura', 'prazo_leitura_fimm',
    ],
  },
  // Ver ADR 0009 — mesma razão de calendario_leitura: região/contrato varia por empresa.
  cidades_localidades: {
    modo: 'substituir',
    temEmpresa: true,
    colunas: ['regional', 'cidade', 'distrito', 'local'],
  },
  prazo_reg_livros: {
    modo: 'upsert',
    temEmpresa: true,
    chave: ['mes_ref'],
    colunas: [
      'mes_ref', 'regional', 'municipio', 'local', 'etapa', 'livro', 'ultimo_executor',
      'primeira', 'ultima', 'prazo_calendario', 'dias_iniciais', 'dias_finais',
      'tempo_de_execucao', 'volume_de_leituras', 'calendario_mes_seguinte',
    ],
  },
  suspensao: {
    modo: 'substituir',
    temEmpresa: true,
    colunas: [
      'mes_ref', 'matricula', 'colaborador', 'cargo', 'base', 'data_falta',
      'justificativa', 'observacao',
    ],
  },
  // Ver ADR 0009 — idem: coordenadas de UC variam conforme a região atendida pela empresa.
  tab_ligacao_coordenadas: {
    modo: 'upsert',
    temEmpresa: true,
    chave: ['UC'],
    colunas: ['UC', 'latitude', 'longitude'],
  },
  // Ver ADR 0024 — mesmo cabeçalho de control_empreiteiras (planilha fornecida
  // pelo usuário bate coluna a coluna), mesma chave de upsert por consistência.
  base_dados_leitura: {
    modo: 'upsert',
    temEmpresa: true,
    chave: ['data_da_leitura', 'hora_da_leitura', 'nome_do_usuario', 'unidade_consumidora'],
    colunas: [
      'concessionaria', 'empreiteira', 'equipe', 'nome_do_usuario', 'mes_ref_livro',
      'data_da_leitura', 'hora_da_leitura', 'unidade_consumidora', 'codigo_da_localidade',
      'descricao_da_localidade', 'tipo_de_localizacao_da_uc', 'etapa', 'livro',
      'status_releitura', 'equipamento', 'especificacao', 'mensagem',
      'mensagem_auxiliar', 'observacao_de_campo', 'status_foto',
      'faturamento_em_campo', 'status_impressao_do_comunicado', 'forma_de_entrega',
    ],
  },
  // Ver ADR 0021 — chave por UC: linha com unidade_consumidora já existente
  // substitui a linha (coordenada/endereço atualizados); UC nova é só
  // inserida. geom/geom_area são geometry(Point,4326)/geometry(Polygon,4326)
  // de verdade (não texto) — testado que o driver aceita o valor de texto
  // hexadecimal (WKB) vindo da planilha direto num bind parametrizado sem
  // tratamento especial, porque geometry_in() do PostGIS já reconhece esse
  // formato como entrada válida.
  coordenadas_ucs_mineradas: {
    modo: 'upsert',
    temEmpresa: true,
    chave: ['unidade_consumidora'],
    colunas: [
      'unidade_consumidora', 'regiao', 'cod_local', 'nom_municipio', 'localidade',
      'endereco', 'tipo_logradouro', 'logradouro', 'numero_imovel', 'zona',
      'classe_principal', 'etapa', 'livro', 'sequencia', 'situacao_uc', 'latitude',
      'longitude', 'coord_confirmada', 'geom', 'geom_area',
    ],
  },
};

module.exports = { CONFIG_IMPORTACAO };
