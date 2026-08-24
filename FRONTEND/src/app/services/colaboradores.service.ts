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

// Ordem de gravidade: sem sincronismo > sem serviço (nenhuma atividade hoje)
// > parado > ativo. Dentro do mesmo destaque, quanto mais tempo sem
// mudança, maior a pontuação.
function pontuacaoDestaque(atividade: AtividadeColaborador | undefined): number {
  if (!atividade) return 1_500_000;
  if (atividade.semSincronismo) return 2_000_000 + atividade.minutosParado;
  if (atividade.parado) return 1_000_000 + atividade.minutosParado;
  return atividade.minutosParado;
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

export interface Produtividade {
  produtivoMin: number;
  improdutivoMin: number;
  percentProdutivo: number;
}

function paraMinutosDoDia(hora: string): number {
  const [h, m, s] = (hora || '0:0:0').split(':').map(Number);
  return h * 60 + m + (s || 0) / 60;
}

function diferencaMinutos(inicio: string, fim: string): number {
  return Math.max(0, paraMinutosDoDia(fim) - paraMinutosDoDia(inicio));
}

export function mediaLeiturasPorMinuto(livro: LivroAtividade): number {
  const minutos = diferencaMinutos(livro.primeiraVez, livro.ultimaVez);
  if (minutos < 1) return 0;
  return livro.digitados / minutos;
}

// Cada intervalo entre dois eventos do histórico é produtivo se os
// digitados avançaram nele; senão é improdutivo. O intervalo do último
// evento até "agora" (última vez visto) também entra como improdutivo, já
// que nada mudou desde então.
export function produtividade(livro: LivroAtividade): Produtividade {
  const eventos = livro.historico;
  let produtivoMin = 0;
  let improdutivoMin = 0;

  for (let i = 1; i < eventos.length; i++) {
    const anterior = eventos[i - 1];
    const atual = eventos[i];
    const gap = diferencaMinutos(anterior.horaImport, atual.horaImport);
    if (atual.digitados > anterior.digitados) {
      produtivoMin += gap;
    } else {
      improdutivoMin += gap;
    }
  }

  const ultimoEvento = eventos[eventos.length - 1];
  if (ultimoEvento) {
    improdutivoMin += diferencaMinutos(ultimoEvento.horaImport, livro.ultimaVez);
  }

  const total = produtivoMin + improdutivoMin;
  const percentProdutivo = total > 0 ? Math.round((produtivoMin / total) * 100) : 100;
  return { produtivoMin, improdutivoMin, percentProdutivo };
}

export function formatarDuracao(minutos: number): string {
  const totalMin = Math.round(minutos);
  if (totalMin < 60) return `${totalMin}min`;
  const horas = Math.floor(totalMin / 60);
  const resto = totalMin % 60;
  return `${horas}h ${resto}min`;
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
