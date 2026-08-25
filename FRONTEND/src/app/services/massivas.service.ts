import { Injectable, OnDestroy, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { environment } from '../../environments/environment';

export interface ContagemMassivas {
  livros: number;
  leituras: number;
}

export interface FaixasDias {
  menor27: ContagemMassivas;
  igual33: ContagemMassivas;
  maior34: ContagemMassivas;
}

export interface ResumoMassivas {
  sucesso: boolean;
  dataImport: string | null;
  horaImport: string | null;
  pendentes: ContagemMassivas;
  atribuidas: ContagemMassivas;
  emExecucao: ContagemMassivas;
  total: ContagemMassivas;
  noPrazo: ContagemMassivas;
  prazoFinal: ContagemMassivas;
  atrasadas: ContagemMassivas;
  faixasDias: FaixasDias;
}

export interface OpcoesFiltroMassivas {
  sucesso: boolean;
  regionais: string[];
  etapas: string[];
}

export interface DetalheLinha {
  status: string;
  tipo_servico: 'leitura' | 'releitura' | 'massiva';
  livro: string;
  etapa: string;
  regional: string | null;
  dt_prev_limite: string | null;
  digitados: number;
  nao_digitados: number;
  leiturista: string | null;
  // Dias efetivos frente ao prazo regulatório (prazo_reg_livros — ver ADR
  // 0012 Adendo 4). Só vem preenchido pra leitura/releitura; livro de
  // massiva ou sem correspondência na planilha vem null.
  dias_prazo_regulatorio: number | null;
  // Data (e hora, quando tem) de recebimento — leitura/releitura vem de
  // contr_execucao_leitura.data_recebimento/hora_recebimento ("DD/MM/YYYY
  // HH:MM"); massiva vem de dt_rec_abertura (mesmo formato, já concatenado
  // na origem). null = ainda não recebido/aberto.
  data_recebimento: string | null;
}

export interface DetalheMassivas {
  sucesso: boolean;
  dataImport: string | null;
  horaImport: string | null;
  linhas: DetalheLinha[];
}

export type StatusMassivas = 'todos' | 'pendentes' | 'atribuidas' | 'emExecucao';
export type VisualizacaoMassivas = 'livros' | 'leituras';
export type PrazoMassivas = '' | 'noPrazo' | 'final' | 'atrasada';
export type TipoServico = 'todos' | 'leitura' | 'releitura' | 'massiva' | 'leiturarelitura';
// Filtro clicável das faixas de dias (aba Monitoramento de Livros — ver ADR
// 0012 Adendo 4). Só faz efeito lá; na aba Massivas o backend ignora porque
// o join com prazo_reg_livros usa o livro de contr_execucao_leitura.
export type FaixaDiasMassivas = '' | 'menor27' | 'igual33' | 'maior34';

// Escopo fixo da aba: "massiva" é a aba Massivas (só massiva, sem opção de
// trocar); "leiturarelitura" é a aba Monitoramento de Livros (leitura e
// releitura, nunca massiva — tem aba própria). Ver ADR 0010.
export type EscopoMassivas = 'massiva' | 'leiturarelitura';

export interface HistoricoLivroEvento {
  status: string;
  etapa: string;
  regional: string | null;
  dataImport: string;
  horaImport: string;
  dtPrevLimite: string | null;
  digitados: number;
  naoDigitados: number;
  leiturista: string | null;
  primeiraAparicao: boolean;
  mudancaStatus: boolean;
  mudancaColaborador: boolean;
}

export interface HistoricoLivroMassivas {
  sucesso: boolean;
  livro: string;
  eventos: HistoricoLivroEvento[];
}

// Sem providedIn: 'root' de propósito — cada <app-massivas-view> (aba
// Massivas e aba Monitoramento de Livros) precisa da sua própria instância
// com filtro próprio, não uma só compartilhada entre as duas abas. Ver
// providers: [MassivasService] em massivas-view.ts.
@Injectable()
export class MassivasService implements OnDestroy {
  private apiUrl = environment.apiUrl;

  // Setado uma vez por iniciar() e nunca mudado depois — é pra onde
  // limparFiltros()/onTipoServicoChange() voltam o filtro de tipo, nunca
  // pro genérico 'todos' (que incluiria massiva na aba de leitura/releitura).
  private escopo: EscopoMassivas = 'leiturarelitura';

  regionais = signal<string[]>([]);
  etapas = signal<string[]>([]);

  filtroRegional = signal('');
  filtroLivro = signal('');
  filtroEtapa = signal('');
  filtroColaborador = signal('');
  filtroStatus = signal<StatusMassivas>('todos');
  filtroPrazo = signal<PrazoMassivas>('');
  filtroFaixaDias = signal<FaixaDiasMassivas>('');
  filtroTipoServico = signal<TipoServico>('leiturarelitura');

  visualizacao = signal<VisualizacaoMassivas>('livros');

  resumo = signal<ResumoMassivas | null>(null);
  carregando = signal(true);
  erro = signal<string | null>(null);

  detalhe = signal<DetalheLinha[]>([]);
  carregandoDetalhe = signal(true);
  erroDetalhe = signal<string | null>(null);

  // Paginação da tabela "Detalhe por livro" — client-side (o detalhe inteiro
  // já vem numa única resposta). Fica no service (não no componente) pra
  // resetar de forma centralizada em buscarTudo(), e porque cada aba já tem
  // sua própria instância de MassivasService (ADR 0010), então a página fica
  // isolada por aba do mesmo jeito que os outros filtros já ficam.
  paginaAtual = signal(1);
  itensPorPagina = signal(50);

  livroSelecionado = signal<string | null>(null);
  historicoLivro = signal<HistoricoLivroEvento[]>([]);
  carregandoHistorico = signal(false);
  erroHistorico = signal<string | null>(null);
  private cacheHistorico = new Map<string, HistoricoLivroEvento[]>();

  private debounceId?: ReturnType<typeof setTimeout>;
  private intervaloId?: ReturnType<typeof setInterval>;
  // Mesmo intervalo do polling de atividade em colaboradores.service.ts —
  // o painel (livros, %, faixas de dias) tem que acompanhar sozinho a
  // evolução dos dados importados, não só quando o usuário mexe num filtro.
  private readonly INTERVALO_ATUALIZACAO_MS = 60000;

  constructor(private http: HttpClient) {}

  // Chamado pelo componente no ngOnInit, uma vez, com o escopo fixo da aba
  // (nunca muda depois). Antes disso o service não busca nada sozinho — o
  // fetch automático no constructor rodava antes do @Input() estar
  // disponível, então sempre pegava o valor padrão errado pra aba.
  iniciar(escopo: EscopoMassivas): void {
    this.escopo = escopo;
    this.filtroTipoServico.set(escopo);
    this.carregarOpcoesFiltro();
    this.buscarTudo();
    // resetarPagina: false — o polling só atualiza os números, não deve
    // chutar o usuário de volta pra página 1 a cada 60s enquanto ele
    // navega a tabela.
    this.intervaloId = setInterval(() => this.buscarTudo(false), this.INTERVALO_ATUALIZACAO_MS);
  }

  ngOnDestroy(): void {
    if (this.intervaloId) clearInterval(this.intervaloId);
    if (this.debounceId) clearTimeout(this.debounceId);
  }

  carregarOpcoesFiltro(): void {
    let params = new HttpParams();
    if (this.filtroTipoServico() !== 'todos') params = params.set('tipoServico', this.filtroTipoServico());

    this.http.get<OpcoesFiltroMassivas>(`${this.apiUrl}/massivas/opcoes-filtro`, { params }).subscribe({
      next: resposta => {
        this.regionais.set(resposta.regionais);
        this.etapas.set(resposta.etapas);
      },
    });
  }

  private montarParams(): HttpParams {
    let params = new HttpParams();
    if (this.filtroRegional()) params = params.set('regional', this.filtroRegional());
    if (this.filtroLivro()) params = params.set('livro', this.filtroLivro());
    if (this.filtroEtapa()) params = params.set('etapa', this.filtroEtapa());
    if (this.filtroColaborador()) params = params.set('colaborador', this.filtroColaborador());
    if (this.filtroStatus() !== 'todos') params = params.set('status', this.filtroStatus());
    if (this.filtroPrazo()) params = params.set('prazo', this.filtroPrazo());
    if (this.filtroFaixaDias()) params = params.set('faixaDias', this.filtroFaixaDias());
    if (this.filtroTipoServico() !== 'todos') params = params.set('tipoServico', this.filtroTipoServico());
    return params;
  }

  buscarTudo(resetarPagina = true): void {
    if (resetarPagina) this.paginaAtual.set(1);
    this.buscarResumo();
    this.buscarDetalhe();
  }

  buscarResumo(): void {
    this.carregando.set(true);
    this.erro.set(null);

    this.http.get<ResumoMassivas>(`${this.apiUrl}/massivas/resumo`, { params: this.montarParams() }).subscribe({
      next: resposta => {
        this.resumo.set(resposta);
        this.carregando.set(false);
      },
      error: () => {
        this.erro.set('Não foi possível carregar os dados de massivas.');
        this.carregando.set(false);
      },
    });
  }

  buscarDetalhe(): void {
    this.carregandoDetalhe.set(true);
    this.erroDetalhe.set(null);

    this.http.get<DetalheMassivas>(`${this.apiUrl}/massivas/detalhe`, { params: this.montarParams() }).subscribe({
      next: resposta => {
        this.detalhe.set(resposta.linhas);
        this.carregandoDetalhe.set(false);
      },
      error: () => {
        this.erroDetalhe.set('Não foi possível carregar a tabela de massivas.');
        this.carregandoDetalhe.set(false);
      },
    });
  }

  buscarComDebounce(): void {
    if (this.debounceId) clearTimeout(this.debounceId);
    this.debounceId = setTimeout(() => this.buscarTudo(), 350);
  }

  limparFiltros(): void {
    this.filtroRegional.set('');
    this.filtroLivro.set('');
    this.filtroEtapa.set('');
    this.filtroColaborador.set('');
    this.filtroStatus.set('todos');
    this.filtroPrazo.set('');
    this.filtroFaixaDias.set('');
    this.filtroTipoServico.set(this.escopo);
    this.carregarOpcoesFiltro();
    this.buscarTudo();
  }

  onTipoServicoChange(): void {
    this.filtroRegional.set('');
    this.filtroEtapa.set('');
    this.carregarOpcoesFiltro();
    this.buscarTudo();
  }

  alternarVisualizacao(): void {
    this.visualizacao.set(this.visualizacao() === 'livros' ? 'leituras' : 'livros');
  }

  abrirHistoricoLivro(livro: string): void {
    this.livroSelecionado.set(livro);
    this.erroHistorico.set(null);

    const cache = this.cacheHistorico.get(livro);
    if (cache) {
      this.historicoLivro.set(cache);
      this.carregandoHistorico.set(false);
      return;
    }

    this.carregandoHistorico.set(true);
    this.historicoLivro.set([]);

    this.http
      .get<HistoricoLivroMassivas>(`${this.apiUrl}/massivas/historico-livro`, { params: new HttpParams().set('livro', livro) })
      .subscribe({
        next: resposta => {
          this.cacheHistorico.set(livro, resposta.eventos);
          this.historicoLivro.set(resposta.eventos);
          this.carregandoHistorico.set(false);
        },
        error: () => {
          this.erroHistorico.set('Não foi possível carregar o histórico do livro.');
          this.carregandoHistorico.set(false);
        },
      });
  }

  fecharHistoricoLivro(): void {
    this.livroSelecionado.set(null);
  }
}
