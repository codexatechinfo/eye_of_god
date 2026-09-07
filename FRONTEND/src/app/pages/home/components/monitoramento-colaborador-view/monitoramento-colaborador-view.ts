import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  CategoriaAtividade,
  ColaboradoresService,
  categoriaDe,
  formatarTempoParado,
  LIMITE_PARADO_MINUTOS,
  normalizarRegional,
  OPCOES_CATEGORIA,
  percentualExecucao,
} from '../../../../services/colaboradores.service';
import { FiltroColuna, OpcaoFiltroColuna } from '../monitoramento-view/filtro-coluna/filtro-coluna';
import { ColaboradorDetalhe } from '../colaborador-detalhe/colaborador-detalhe';

type CorLinha = 'verde' | 'amarelo' | 'vermelho';
type ColunaOrdenavel = 'colaborador' | 'cargo' | 'regional' | 'bateria' | 'ultimoRegistro' | 'quantidade' | 'percentual' | 'categoria';
type DirecaoOrdenacao = 'asc' | 'desc';

interface LinhaColaborador {
  colaborador: string;
  cargo: string;
  regional: string;
  bateria: number | null;
  ultimoRegistro: string | null;
  ultimoRegistroMs: number;
  digitados: number;
  pendentes: number;
  percentual: number;
  categoria: CategoriaAtividade;
}

// Aba nova, no mesmo modelo visual de monitoramento-view.ts (barra de
// resumo + tabela com filtro "estilo Excel" embutido no cabeçalho, ver ADR
// 0035) — mas centrada em COLABORADOR, não em livro. Não precisa de
// MonitoramentoService (não tem fonte massiva/leitura própria): todo o dado
// já existe em ColaboradoresService (mesma fonte que a aba Trilho usa),
// então esta aba só CONSOME o estado global, sem buscar nada sozinha.
@Component({
  selector: 'app-monitoramento-colaborador-view',
  imports: [CommonModule, FormsModule, FiltroColuna, ColaboradorDetalhe],
  templateUrl: './monitoramento-colaborador-view.html',
})
export class MonitoramentoColaboradorView {
  opcoesCategoria = OPCOES_CATEGORIA;

  constructor(public colaboradoresService: ColaboradoresService) {}

  totalAtivos(): number {
    return this.colaboradoresService.colaboradores().length;
  }

  // Mesma lógica de agentesEmCampoLista em monitoramento-view.ts, sem
  // escopo massiva/leitura pra filtrar (essa aba não distingue tipo de
  // serviço) — "em campo" aqui é só "teve atividade hoje", igual à barra de
  // resumo das outras duas abas.
  private agentesEmCampoLista() {
    return this.colaboradoresService.colaboradores().filter(c => this.colaboradoresService.atividadeDe(c.colaborador));
  }

  agentesEmCampo(): number {
    return this.agentesEmCampoLista().length;
  }

  agentesMoto(): number {
    return this.agentesEmCampoLista().filter(c => c.cargo === 'LEITURISTA MOTOCICLISTA').length;
  }

  agentesAPe(): number {
    return this.agentesEmCampoLista().filter(c => c.cargo === 'LEITURISTA').length;
  }

  agentesMonitorEmCampo(): number {
    return this.agentesEmCampoLista().filter(c => c.cargo === 'MONITOR').length;
  }

  comunicacaoOk(): number {
    return this.agentesEmCampoLista().filter(c => {
      const atividade = this.colaboradoresService.atividadeDe(c.colaborador);
      return (atividade?.minutosParado ?? Infinity) < LIMITE_PARADO_MINUTOS;
    }).length;
  }

  comunicacaoPercent(): number {
    const total = this.agentesEmCampo();
    return total > 0 ? (this.comunicacaoOk() / total) * 100 : 0;
  }

  semComunicar30(): number {
    return this.agentesEmCampo() - this.comunicacaoOk();
  }

  // Mesmo cálculo do card "Progresso de atividades" das abas Livros/
  // Massivas, sem escopo massiva/leitura pra somar (aqui é digitados/
  // pendentes AGREGADOS do colaborador, totalRealizadas/totalPendentes já
  // prontos em AtividadeColaborador — sem precisar somar livro a livro).
  private progressoContagens(): { realizadas: number; total: number } {
    let realizadas = 0;
    let total = 0;
    for (const c of this.agentesEmCampoLista()) {
      const atividade = this.colaboradoresService.atividadeDe(c.colaborador);
      if (!atividade) continue;
      realizadas += atividade.totalRealizadas;
      total += atividade.totalRealizadas + atividade.totalPendentes;
    }
    return { realizadas, total };
  }

  progressoRealizadas(): number {
    return this.progressoContagens().realizadas;
  }

  progressoTotal(): number {
    return this.progressoContagens().total;
  }

  progressoPercent(): number {
    const { realizadas, total } = this.progressoContagens();
    return total > 0 ? (realizadas / total) * 100 : 0;
  }

  mostrarSemComunicar = signal(false);

  abrirSemComunicar(): void {
    if (this.semComunicar30() > 0) this.mostrarSemComunicar.set(true);
  }

  fecharSemComunicar(): void {
    this.mostrarSemComunicar.set(false);
  }

  listaSemComunicar(): { nome: string; minutosParado: number; etapas: string[]; aRealizar: number }[] {
    return this.agentesEmCampoLista()
      .map(c => {
        const atividade = this.colaboradoresService.atividadeDe(c.colaborador);
        return { colaborador: c.colaborador, atividade };
      })
      .filter(({ atividade }) => (atividade?.minutosParado ?? Infinity) >= LIMITE_PARADO_MINUTOS)
      .map(({ colaborador, atividade }) => ({
        nome: colaborador,
        minutosParado: atividade?.minutosParado ?? 0,
        etapas: [...new Set((atividade?.livros ?? []).map(l => l.etapa))].sort((a, b) => Number(a) - Number(b)),
        aRealizar: atividade?.totalPendentes ?? 0,
      }))
      .sort((a, b) => b.minutosParado - a.minutosParado);
  }

  formatarTempoParado(minutos: number): string {
    return formatarTempoParado(minutos);
  }

  // Mesmo padrão do modal "Agentes em campo" das abas Livros/Massivas (ADR
  // 0035).
  mostrarAgentesEmCampo = signal(false);

  abrirAgentesEmCampo(): void {
    if (this.agentesEmCampo() > 0) this.mostrarAgentesEmCampo.set(true);
  }

  fecharAgentesEmCampo(): void {
    this.mostrarAgentesEmCampo.set(false);
  }

  listaAgentesEmCampo(): { nome: string; bateria: number | null; minutosParado: number | null }[] {
    return this.agentesEmCampoLista()
      .map(c => ({
        nome: c.colaborador,
        bateria: this.colaboradoresService.scalefusionDe(c.colaborador)?.bateria_percentual ?? null,
        minutosParado: this.colaboradoresService.atividadeDe(c.colaborador)?.minutosParado ?? null,
      }))
      .sort((a, b) => a.nome.localeCompare(b.nome));
  }

  corBateria(percentual: number | null): string {
    if (percentual == null) return 'text-slate-400';
    if (percentual <= 20) return 'text-red-600';
    if (percentual <= 50) return 'text-amber-600';
    return 'text-emerald-600';
  }

  // "Ver no mapa" (item 2 da rodada anterior, reaproveitado aqui) — mesmo
  // método de ColaboradoresService, troca pra aba Trilho e centraliza.
  verNoMapa(nome: string, evento?: Event): void {
    evento?.stopPropagation();
    this.colaboradoresService.verNoMapa(nome);
    this.fecharAgentesEmCampo();
  }

  // Cargo cru de ativos_inativos vira um rótulo mais claro — mesmo texto já
  // usado em lista-colaboradores.ts.
  rotuloCargo(cargo: string): string {
    if (cargo === 'LEITURISTA MOTOCICLISTA') return 'Motoqueiro';
    if (cargo === 'LEITURISTA') return 'Pedestre';
    if (cargo === 'MONITOR') return 'Monitor';
    return cargo;
  }

  rotuloCategoria(categoria: CategoriaAtividade): string {
    return this.opcoesCategoria.find(o => o.valor === categoria)?.rotulo ?? categoria;
  }

  // Cards de status (Ativo/Parado/Sem sincronismo/Sem serviço/Afastados) —
  // mesmo visual dos cards de status das abas Livros/Massivas, só que
  // contando categoria de colaborador em vez de status de livro. Clicável,
  // filtra a tabela (filtroTabelaCategoria).
  contagemCategoria(categoria: CategoriaAtividade): number {
    return this.linhasBase().filter(l => l.categoria === categoria).length;
  }

  categoriaEmDestaque(categoria: CategoriaAtividade): boolean {
    const filtro = this.filtroTabelaCategoria();
    return !filtro || filtro === categoria;
  }

  selecionarCategoria(categoria: CategoriaAtividade): void {
    this.filtroTabelaCategoria.set(this.filtroTabelaCategoria() === categoria ? '' : categoria);
    this.paginaAtual.set(1);
  }

  // "DD/MM/YYYY HH:MM" -> epoch, só pra ordenar a coluna direito.
  private paraEpochOrdenavel(dataHora: string | null): number {
    if (!dataHora) return -Infinity;
    const [dataParte, horaParte] = dataHora.split(' ');
    const [d, m, a] = dataParte.split('/').map(Number);
    const [h, min] = (horaParte || '0:0').split(':').map(Number);
    if (!d || !m || !a) return -Infinity;
    return Date.UTC(a, m - 1, d, h || 0, min || 0);
  }

  // Base da tabela — TODOS os colaboradores ativos (não só quem tem
  // atividade hoje, ao contrário da barra de resumo acima), com bateria e
  // último registro quando existem. Mesmo princípio da aba Livros: a tabela
  // mostra o universo inteiro pra monitorar, os cards de cima é que somam
  // só quem está "em campo".
  private linhasBase(): LinhaColaborador[] {
    const localizacaoPorNome = new Map(this.colaboradoresService.localizacoes().map(l => [l.colaborador, l]));
    const afastamentos = this.colaboradoresService.afastamentosHoje();

    return this.colaboradoresService.colaboradores().map(c => {
      const atividade = this.colaboradoresService.atividadeDe(c.colaborador);
      const afastamento = afastamentos[c.colaborador] ?? null;
      const loc = localizacaoPorNome.get(c.colaborador);
      const ultimoRegistro = loc ? `${loc.data_import} ${loc.hora_import}` : null;

      return {
        colaborador: c.colaborador,
        cargo: c.cargo,
        regional: normalizarRegional(c.base),
        bateria: this.colaboradoresService.scalefusionDe(c.colaborador)?.bateria_percentual ?? null,
        ultimoRegistro,
        ultimoRegistroMs: this.paraEpochOrdenavel(ultimoRegistro),
        digitados: atividade?.totalRealizadas ?? 0,
        pendentes: atividade?.totalPendentes ?? 0,
        percentual: percentualExecucao(atividade),
        categoria: categoriaDe(atividade, afastamento),
      };
    });
  }

  // Filtros embutidos por coluna (mesmo padrão "estilo Excel" da aba
  // Livros/Massivas, ver filtro-coluna.ts) — locais desta aba, de propósito
  // não reaproveitam filtroRegional/filtroCargo/filtroColaborador de
  // ColaboradoresService: aqueles pertencem à barra lateral da aba Trilho
  // (server-side, via buscar()) e mexer neles aqui afetaria a outra aba.
  filtroTabelaColaborador = signal('');
  filtroTabelaCargo = signal('');
  filtroTabelaRegional = signal('');
  filtroTabelaCategoria = signal<CategoriaAtividade | ''>('');

  opcoesRegional(): OpcaoFiltroColuna[] {
    return [{ valor: '', rotulo: 'Todas' }, ...this.colaboradoresService.regionais().map(r => ({ valor: r, rotulo: r }))];
  }

  opcoesCargo(): OpcaoFiltroColuna[] {
    return [
      { valor: '', rotulo: 'Todos' },
      ...this.colaboradoresService.cargos().map(c => ({ valor: c, rotulo: this.rotuloCargo(c) })),
    ];
  }

  opcoesStatusColuna(): OpcaoFiltroColuna[] {
    return [{ valor: '', rotulo: 'Todos' }, ...this.opcoesCategoria.map(o => ({ valor: o.valor, rotulo: o.rotulo }))];
  }

  aplicarFiltroColaborador(valor: string): void {
    this.filtroTabelaColaborador.set(valor);
    this.paginaAtual.set(1);
  }

  aplicarFiltroCargo(valor: string): void {
    this.filtroTabelaCargo.set(valor);
    this.paginaAtual.set(1);
  }

  aplicarFiltroRegional(valor: string): void {
    this.filtroTabelaRegional.set(valor);
    this.paginaAtual.set(1);
  }

  aplicarFiltroStatus(valor: string): void {
    this.filtroTabelaCategoria.set((valor || '') as CategoriaAtividade | '');
    this.paginaAtual.set(1);
  }

  limparFiltrosTabela(): void {
    this.filtroTabelaColaborador.set('');
    this.filtroTabelaCargo.set('');
    this.filtroTabelaRegional.set('');
    this.filtroTabelaCategoria.set('');
    this.paginaAtual.set(1);
  }

  private linhasFiltradas(): LinhaColaborador[] {
    const nome = this.filtroTabelaColaborador().trim().toLowerCase();
    const cargo = this.filtroTabelaCargo();
    const regional = this.filtroTabelaRegional();
    const categoria = this.filtroTabelaCategoria();

    return this.linhasBase().filter(l => {
      if (nome && !l.colaborador.toLowerCase().includes(nome)) return false;
      if (cargo && l.cargo !== cargo) return false;
      if (regional && l.regional !== regional) return false;
      if (categoria && l.categoria !== categoria) return false;
      return true;
    });
  }

  colunaOrdenacao = signal<ColunaOrdenavel | null>(null);
  direcaoOrdenacao = signal<DirecaoOrdenacao>('asc');

  ordenarPor(coluna: ColunaOrdenavel): void {
    if (this.colunaOrdenacao() !== coluna) {
      this.colunaOrdenacao.set(coluna);
      this.direcaoOrdenacao.set('asc');
      return;
    }
    if (this.direcaoOrdenacao() === 'asc') {
      this.direcaoOrdenacao.set('desc');
    } else {
      this.colunaOrdenacao.set(null);
    }
  }

  indicadorOrdenacao(coluna: ColunaOrdenavel): string {
    if (this.colunaOrdenacao() !== coluna) return '';
    return this.direcaoOrdenacao() === 'asc' ? ' ▲' : ' ▼';
  }

  private chaveOrdenacao(linha: LinhaColaborador, coluna: ColunaOrdenavel): string | number {
    switch (coluna) {
      case 'colaborador':
        return linha.colaborador;
      case 'cargo':
        return linha.cargo;
      case 'regional':
        return linha.regional;
      case 'bateria':
        return linha.bateria ?? -Infinity;
      case 'ultimoRegistro':
        return linha.ultimoRegistroMs;
      case 'quantidade':
        return linha.digitados;
      case 'percentual':
        return linha.percentual;
      case 'categoria':
        return linha.categoria;
    }
  }

  linhasOrdenadas(): LinhaColaborador[] {
    const linhas = this.linhasFiltradas();
    const coluna = this.colunaOrdenacao();

    // Sem coluna escolhida: mais crítico primeiro — menor % de execução
    // primeiro entre quem está em campo, sem serviço/afastado por último
    // (mesma ideia de ordenação master já usada na lista lateral da aba
    // Trilho, ver pontuacaoDestaque em colaboradores.service.ts).
    if (!coluna) {
      const prioridade = (l: LinhaColaborador) => (l.categoria === 'semServico' || l.categoria === 'afastado' ? 1 : 0);
      return [...linhas].sort((a, b) => {
        const prioA = prioridade(a);
        const prioB = prioridade(b);
        if (prioA !== prioB) return prioA - prioB;
        return a.percentual - b.percentual;
      });
    }

    const direcao = this.direcaoOrdenacao() === 'asc' ? 1 : -1;
    return [...linhas].sort((a, b) => {
      const chaveA = this.chaveOrdenacao(a, coluna);
      const chaveB = this.chaveOrdenacao(b, coluna);
      if (chaveA < chaveB) return -1 * direcao;
      if (chaveA > chaveB) return 1 * direcao;
      return 0;
    });
  }

  readonly OPCOES_ITENS_POR_PAGINA = [25, 50, 100, 250];
  readonly MAX_ITENS_POR_PAGINA = 250;

  paginaAtual = signal(1);
  itensPorPagina = signal(50);

  totalPaginas(): number {
    return Math.max(1, Math.ceil(this.linhasOrdenadas().length / this.itensPorPagina()));
  }

  paginaEfetiva(): number {
    return Math.min(Math.max(1, this.paginaAtual()), this.totalPaginas());
  }

  linhasPaginadas(): LinhaColaborador[] {
    const porPagina = this.itensPorPagina();
    const inicio = (this.paginaEfetiva() - 1) * porPagina;
    return this.linhasOrdenadas().slice(inicio, inicio + porPagina);
  }

  irParaPagina(pagina: number): void {
    this.paginaAtual.set(Math.min(Math.max(1, pagina), this.totalPaginas()));
  }

  alterarItensPorPagina(qtd: number | string, input?: HTMLInputElement): void {
    const numero = Math.trunc(Number(qtd));
    const limitado = Number.isFinite(numero) && numero > 0 ? Math.min(numero, this.MAX_ITENS_POR_PAGINA) : this.itensPorPagina();
    this.itensPorPagina.set(limitado);
    this.paginaAtual.set(1);
    if (input) input.value = String(limitado);
  }

  intervaloExibido(): string {
    const total = this.linhasOrdenadas().length;
    if (!total) return '0 registros';
    const porPagina = this.itensPorPagina();
    const inicio = (this.paginaEfetiva() - 1) * porPagina + 1;
    const fim = Math.min(inicio + porPagina - 1, total);
    return `${inicio}–${fim} de ${total} registro${total === 1 ? '' : 's'}`;
  }

  corPercentual(pct: number): CorLinha {
    if (pct >= 70) return 'verde';
    if (pct >= 30) return 'amarelo';
    return 'vermelho';
  }

  corCategoria(categoria: CategoriaAtividade): string {
    if (categoria === 'ativo') return 'bg-emerald-100 text-emerald-700';
    if (categoria === 'parado') return 'bg-amber-100 text-amber-700';
    if (categoria === 'semSincronismo') return 'bg-red-100 text-red-700';
    if (categoria === 'afastado') return 'bg-purple-100 text-purple-700';
    return 'bg-slate-100 text-slate-500';
  }

  // Clique na linha (item pedido: "abrir o detalhe de execução dele no
  // dia") — mesmo painel já usado na aba Trilho (app-colaborador-detalhe),
  // embutido nesta aba (ver monitoramento-colaborador-view.html). Não troca
  // de aba sozinho — só o botão "Ver no mapa" DENTRO do painel faz isso.
  abrirDetalhe(nome: string): void {
    this.colaboradoresService.abrirColaborador(nome);
  }
}
