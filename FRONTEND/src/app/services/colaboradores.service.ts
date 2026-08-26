import { Injectable, computed, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { environment } from '../../environments/environment';

export function normalizarRegional(base: string): string {
  return base
    .replace(/^COPEL\s+/i, '')
    .replace(/\s+(LEITURA|ADM)$/i, '')
    .trim();
}

export function hojeIso(): string {
  const agora = new Date();
  const ano = agora.getFullYear();
  const mes = String(agora.getMonth() + 1).padStart(2, '0');
  const dia = String(agora.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

export interface Colaborador {
  matricula: string;
  colaborador: string;
  cargo: string;
  base: string;
  admissao: string;
  data_atualizacao: string;
}

export interface ColaboradoresResponse {
  sucesso: boolean;
  total: number;
  colaboradores: Colaborador[];
}

export interface OpcoesFiltroResponse {
  sucesso: boolean;
  cargos: string[];
  regionais: string[];
}

export interface HistoricoLivroItem {
  horaImport: string;
  situacao: string;
  digitados: number;
  naoDigitados: number;
}

export interface LivroAtividade {
  livro: string;
  etapa: string;
  situacaoAtual: string;
  digitados: number;
  naoDigitados: number;
  // null = ainda sem data_recebimento, não dá pra saber se vai virar leitura
  // ou releitura (mesma regra da ADR 0006/0011); 'massiva' = livro vindo das
  // tabelas de massiva (atribuidas_im/em_execucao_im), não de contr_execucao_leitura.
  tipoServico: 'leitura' | 'releitura' | 'massiva' | null;
  // Dias efetivos frente ao prazo regulatório (prazo_reg_livros — ver ADR
  // 0012 Adendo 4). null = livro sem correspondência na planilha (não
  // avaliado) ou de massiva (nunca teve essa correspondência).
  diasPrazoRegulatorio: number | null;
  primeiraVez: string;
  ultimaVez: string;
  historico: HistoricoLivroItem[];
}

export interface AtividadeColaborador {
  colaborador: string;
  totalRealizadas: number;
  totalPendentes: number;
  totalLivros: number;
  totalEmExecucao: number;
  ultimaMudancaHora: string;
  minutosParado: number;
  parado: boolean;
  ativo: boolean;
  semSincronismo: boolean;
  livros: LivroAtividade[];
}

export interface AfastamentoInfo {
  dataAfastamento: string;
  dataRetorno: string;
  qtdDiasAfastado: string;
  afastadoInss: string;
  motivoAfastamento: string | null;
}

export interface AtividadeHojeResponse {
  sucesso: boolean;
  data: string;
  ultimaHoraGeral: string | null;
  colaboradores: AtividadeColaborador[];
  afastamentosHoje: Record<string, AfastamentoInfo>;
}

// % de execução do dia = digitados / (digitados + pendentes). 0 quando não
// há nenhuma atividade registrada ainda (parado, ou sem atividade nenhuma) —
// não é "sem dado", é "0% feito até agora", que é exatamente o que a barra
// deve mostrar.
export function percentualExecucao(atividade: AtividadeColaborador | undefined | null): number {
  if (!atividade) return 0;
  const total = atividade.totalRealizadas + atividade.totalPendentes;
  return total > 0 ? (atividade.totalRealizadas / total) * 100 : 0;
}

// Livro com prazo regulatório extremo (mesmos limiares de destaque da
// tabela de detalhe — ver corPrazoRegulatorio em massivas-view.ts):
// >33 dias em QUALQUER status (já estourou o prazo, crítico não importa o
// que esteja acontecendo com o livro) ou <27 dias mas só em livro já "Em
// Execução" (livro sendo trabalhado que ainda nem chegou nos 27 dias
// costuma ser incomum o bastante pra merecer atenção — livro "Pendente"
// com <27 dias é só o normal esperado, não é sinal de nada).
function temLivroCritico(atividade: AtividadeColaborador | undefined): boolean {
  if (!atividade) return false;
  return atividade.livros.some(livro => {
    if (livro.diasPrazoRegulatorio === null) return false;
    if (livro.diasPrazoRegulatorio > 33) return true;
    return livro.diasPrazoRegulatorio < 27 && livro.situacaoAtual === 'Em Execução';
  });
}

// Ordenação master da lista (pedido explícito do usuário, substitui a
// hierarquia anterior baseada só em parado/ativo/semSincronismo):
//   1. Colaborador com pelo menos um livro em prazo regulatório extremo
//      (temLivroCritico) — não importa se está parado/ativo/sem sincronismo.
//   2. Todo mundo com atividade hoje, por percentual de execução ascendente
//      (menor % primeiro) — parado/ativo/semSincronismo tratados como UM só
//      grupo aqui, não mais como tiers separados.
//   3. Sem serviço (nenhuma atividade hoje) — sempre por último.
// categoriaDe()/os 4 toggles continuam funcionando normalmente pra FILTRAR
// a lista — só a ORDEM mudou.
//
// minutosParado NÃO entra mais como desempate: usuário reportou (print) a
// ordem "reiniciando" ao trocar de ativo pra sem sincronismo — causa real,
// confirmada com dado ao vivo: minutosParado de quem está "sem sincronismo"
// passa facilmente de 600 (horas sem sincronizar, por definição da própria
// categoria), e um desempate de escala *1000 não é grande o bastante pra
// evitar que esse valor "vaze" pra cima da diferença real de percentual
// entre duas pessoas de categorias diferentes — ex.: ativo a 13,0% (score
// 87005) aparecendo DEPOIS de alguém sem sincronismo a 13,5% com
// minutosParado=658 (score 87158), quando deveria vir antes por ter menos
// % feito. Critério agora é só percentual, como o usuário pediu.
function pontuacaoDestaque(atividade: AtividadeColaborador | undefined): number {
  if (!atividade) return -1;
  const criticidade = 100 - percentualExecucao(atividade);
  if (temLivroCritico(atividade)) return 2_000_000 + criticidade;
  return criticidade;
}

// As quatro categorias dos toggles. "semServico" é quem não tem nenhum
// registro de atividade hoje (não está no mapa atividadeHoje).
export type CategoriaAtividade = 'parado' | 'semServico' | 'ativo' | 'semSincronismo';

export const OPCOES_CATEGORIA: { valor: CategoriaAtividade; rotulo: string }[] = [
  { valor: 'parado', rotulo: 'Parado' },
  { valor: 'semServico', rotulo: 'Sem serviço' },
  { valor: 'ativo', rotulo: 'Ativo' },
  { valor: 'semSincronismo', rotulo: 'Sem sincronismo' },
];

export function categoriaDe(atividade: AtividadeColaborador | undefined | null): CategoriaAtividade {
  if (!atividade) return 'semServico';
  if (atividade.semSincronismo) return 'semSincronismo';
  if (atividade.parado) return 'parado';
  return 'ativo';
}

export interface LivroSelecionado {
  colaboradorNome: string;
  livro: LivroAtividade;
}

@Injectable({
  providedIn: 'root',
})
export class ColaboradoresService {
  private apiUrl = environment.apiUrl;

  cargos = signal<string[]>([]);
  regionais = signal<string[]>([]);

  colaboradores = signal<Colaborador[]>([]);
  total = signal(0);
  carregando = signal(true);
  erro = signal<string | null>(null);

  filtroColaborador = signal('');
  filtroCargo = signal('');
  filtroRegional = signal('');
  filtroData = signal(hojeIso());

  atividadeHoje = signal<Record<string, AtividadeColaborador>>({});
  afastamentosHoje = signal<Record<string, AfastamentoInfo>>({});
  dataAtividade = signal<string | null>(null);
  carregandoAtividade = signal(true);
  colaboradorSelecionado = signal<string | null>(null);
  filtroCategoria = signal<CategoriaAtividade | ''>('');
  livroSelecionado = signal<LivroSelecionado | null>(null);

  contagemPorRegional = computed(() => {
    const contagem = new Map<string, number>();
    for (const colaborador of this.colaboradores()) {
      const regional = normalizarRegional(colaborador.base);
      contagem.set(regional, (contagem.get(regional) ?? 0) + 1);
    }
    return contagem;
  });

  // Sempre ordenada por destaque (mais grave primeiro) e, quando um toggle
  // está ativo, filtrada só para quem está naquela categoria.
  colaboradoresOrdenados = computed(() => {
    const atividade = this.atividadeHoje();
    const filtro = this.filtroCategoria();
    const lista = [...this.colaboradores()].sort(
      (a, b) => pontuacaoDestaque(atividade[b.colaborador]) - pontuacaoDestaque(atividade[a.colaborador]),
    );
    if (!filtro) return lista;
    return lista.filter(c => categoriaDe(atividade[c.colaborador]) === filtro);
  });

  alternarFiltroCategoria(categoria: CategoriaAtividade): void {
    this.filtroCategoria.set(this.filtroCategoria() === categoria ? '' : categoria);
  }

  private debounceId?: ReturnType<typeof setTimeout>;
  private readonly INTERVALO_ATIVIDADE_MS = 60000;

  constructor(private http: HttpClient) {
    this.carregarOpcoesFiltro();
    this.buscar();
    this.carregarAtividadeHoje();
    setInterval(() => this.carregarAtividadeHoje(), this.INTERVALO_ATIVIDADE_MS);
  }

  carregarOpcoesFiltro(): void {
    this.http.get<OpcoesFiltroResponse>(`${this.apiUrl}/colaboradores/opcoes-filtro`).subscribe({
      next: resposta => {
        this.cargos.set(resposta.cargos);
        this.regionais.set(resposta.regionais);
      },
    });
  }

  buscar(): void {
    this.carregando.set(true);
    this.erro.set(null);

    let params = new HttpParams();
    if (this.filtroColaborador()) params = params.set('colaborador', this.filtroColaborador());
    if (this.filtroCargo()) params = params.set('cargo', this.filtroCargo());
    if (this.filtroRegional()) params = params.set('regional', this.filtroRegional());

    this.http.get<ColaboradoresResponse>(`${this.apiUrl}/colaboradores/ativos`, { params }).subscribe({
      next: resposta => {
        this.colaboradores.set(resposta.colaboradores);
        this.total.set(resposta.total);
        this.carregando.set(false);
      },
      error: () => {
        this.erro.set('Não foi possível carregar os colaboradores.');
        this.carregando.set(false);
      },
    });
  }

  buscarComDebounce(): void {
    if (this.debounceId) clearTimeout(this.debounceId);
    this.debounceId = setTimeout(() => this.buscar(), 350);
  }

  limparFiltros(): void {
    this.filtroColaborador.set('');
    this.filtroCargo.set('');
    this.filtroRegional.set('');
    this.filtroData.set(hojeIso());
    this.buscar();
  }

  carregarAtividadeHoje(): void {
    this.carregandoAtividade.set(true);
    this.http.get<AtividadeHojeResponse>(`${this.apiUrl}/colaboradores/atividade-hoje`).subscribe({
      next: resposta => {
        const mapa: Record<string, AtividadeColaborador> = {};
        for (const item of resposta.colaboradores) {
          mapa[item.colaborador] = item;
        }
        this.atividadeHoje.set(mapa);
        this.afastamentosHoje.set(resposta.afastamentosHoje ?? {});
        this.dataAtividade.set(resposta.data);
        this.carregandoAtividade.set(false);
      },
      error: () => {
        this.carregandoAtividade.set(false);
      },
    });
  }

  atividadeDe(nome: string): AtividadeColaborador | null {
    return this.atividadeHoje()[nome] ?? null;
  }

  afastamentoDe(nome: string): AfastamentoInfo | null {
    return this.afastamentosHoje()[nome] ?? null;
  }

  selecionarColaborador(nome: string): void {
    this.colaboradorSelecionado.set(this.colaboradorSelecionado() === nome ? null : nome);
  }

  abrirLivro(colaboradorNome: string, livro: LivroAtividade): void {
    this.livroSelecionado.set({ colaboradorNome, livro });
  }

  fecharLivro(): void {
    this.livroSelecionado.set(null);
  }
}
