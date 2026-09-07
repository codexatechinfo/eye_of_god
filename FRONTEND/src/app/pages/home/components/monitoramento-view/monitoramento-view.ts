import { Component, Input, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  DetalheLinha,
  EscopoMonitoramento,
  FaixaDiasMonitoramento,
  MonitoramentoService,
  StatusMonitoramento,
  TipoServico,
} from '../../../../services/monitoramento.service';
import { ColaboradoresService, formatarTempoParado, LIMITE_PARADO_MINUTOS } from '../../../../services/colaboradores.service';
import { FiltroColuna, OpcaoFiltroColuna } from './filtro-coluna/filtro-coluna';

type CorLinha = 'verde' | 'amarelo' | 'vermelho';
type ColunaOrdenavel =
  | 'regional'
  | 'livro'
  | 'etapa'
  | 'status'
  | 'tipoServico'
  | 'dt_prev_limite'
  | 'quantidade'
  | 'leiturista'
  | 'diasAtraso'
  | 'percentual'
  | 'diasPrazoRegulatorio'
  | 'dataRecebimento';
type DirecaoOrdenacao = 'asc' | 'desc';

@Component({
  selector: 'app-monitoramento-view',
  imports: [CommonModule, FormsModule, FiltroColuna],
  templateUrl: './monitoramento-view.html',
  styleUrl: './monitoramento-view.css',
  // Instância própria por aba — a de Massivas e a de Monitoramento de
  // Livros não podem compartilhar filtro (ver monitoramento.service.ts).
  providers: [MonitoramentoService],
})
export class MonitoramentoView implements OnInit {
  // 'massiva': aba Massivas, comportamento de antes da ADR 0006 (só
  // massiva, sem seletor de tipo). 'leiturarelitura': aba Monitoramento de
  // Livros, só leitura/releitura — nunca massiva, que agora tem aba própria.
  @Input() escopo: EscopoMonitoramento = 'leiturarelitura';

  // ColaboradoresService é singleton (providedIn: 'root', ao contrário de
  // MonitoramentoService) — é a mesma instância que a aba Trilho usa, de
  // propósito: "agentes em campo" é uma métrica global de colaborador, não
  // depende de qual aba de massiva/livros está aberta.
  constructor(
    public monitoramentoService: MonitoramentoService,
    public colaboradoresService: ColaboradoresService,
  ) {}

  ngOnInit(): void {
    this.monitoramentoService.iniciar(this.escopo);
  }

  // Barra de resumo (anexo2) — "em campo" é qualquer colaborador (incluindo
  // MONITOR) com atividade registrada hoje em contr_execucao_leitura/massiva
  // (mesmo dado que a aba Trilho já usa pra Ativo/Parado/Sem sincronismo);
  // "na base" é MONITOR sem atividade hoje. Usuário corrigiu a suposição
  // anterior (MONITOR = sempre na base, nunca contava em "em campo" mesmo
  // tendo ido a campo): monitor também vai a campo, então só entra em "na
  // base" quando não teve nenhuma atividade hoje, igual a qualquer outro
  // cargo cai em "sem serviço" na aba Trilho.
  totalAtivos(): number {
    return this.colaboradoresService.colaboradores().length;
  }

  // Na aba Massivas, "em campo" só conta quem tem pelo menos um livro de
  // massiva na atividade de hoje — usuário corrigiu a suposição anterior
  // (contava qualquer atividade, leitura/releitura incluída, inflando os
  // números da aba errada). Na aba Monitoramento de Livros o comportamento
  // já estava certo (usuário confirmou), então segue sem filtro extra ali.
  private agentesEmCampoLista() {
    const todos = this.colaboradoresService
      .colaboradores()
      .filter(c => this.colaboradoresService.atividadeDe(c.colaborador));
    if (this.escopo !== 'massiva') return todos;
    return todos.filter(c => {
      const atividade = this.colaboradoresService.atividadeDe(c.colaborador);
      return atividade?.livros.some(l => l.tipoServico === 'massiva') ?? false;
    });
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

  // MONITOR com atividade hoje — foi a campo, entra no total de "em campo".
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

  mostrarSemComunicar = signal(false);

  abrirSemComunicar(): void {
    if (this.semComunicar30() > 0) this.mostrarSemComunicar.set(true);
  }

  fecharSemComunicar(): void {
    this.mostrarSemComunicar.set(false);
  }

  // Lista pro modal aberto em abrirSemComunicar(): mesmos colaboradores de
  // semComunicar30() (minutosParado >= LIMITE_PARADO_MINUTOS), com as
  // etapas distintas dos livros que cada um tem hoje e o total ainda a
  // realizar (naoDigitados agregado — mesma fonte de totalPendentes).
  // Ordenado por mais tempo sem comunicar primeiro (mais crítico no topo).
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

  // Modal "Agentes em campo" (item 2) — abre ao clicar no número do card,
  // lista TODOS os agentes em campo do escopo desta aba (mesma lista de
  // agentesEmCampoLista(), já filtrada por massiva quando for o caso), com
  // bateria do aparelho, tempo sem sincronizar e atalho pro mapa.
  mostrarAgentesEmCampo = signal(false);

  abrirAgentesEmCampo(): void {
    if (this.agentesEmCampo() > 0) this.mostrarAgentesEmCampo.set(true);
  }

  fecharAgentesEmCampo(): void {
    this.mostrarAgentesEmCampo.set(false);
  }

  listaAgentesEmCampo(): { nome: string; cargo: string; bateria: number | null; minutosParado: number | null }[] {
    return this.agentesEmCampoLista()
      .map(c => ({
        nome: c.colaborador,
        cargo: c.cargo,
        bateria: this.colaboradoresService.scalefusionDe(c.colaborador)?.bateria_percentual ?? null,
        minutosParado: this.colaboradoresService.atividadeDe(c.colaborador)?.minutosParado ?? null,
      }))
      .sort((a, b) => a.nome.localeCompare(b.nome));
  }

  // Bateria do aparelho — mesmos limiares de lista-colaboradores.ts#corBateria.
  corBateria(percentual: number | null): string {
    if (percentual == null) return 'text-slate-400';
    if (percentual <= 20) return 'text-red-600';
    if (percentual <= 50) return 'text-amber-600';
    return 'text-emerald-600';
  }

  verNoMapa(nome: string): void {
    this.colaboradoresService.verNoMapa(nome);
    this.fecharAgentesEmCampo();
  }

  // atividade.totalRealizadas/totalPendentes soma TODOS os livros do
  // colaborador (leitura+releitura+massiva juntos, desde a ADR 0013, que
  // passou a mesclar massiva na mesma lista de atividade). Aqui precisa ser
  // só do escopo da aba — então soma livro a livro, filtrando por
  // tipoServico em vez de usar os totais já agregados do colaborador.
  private progressoContagens(): { realizadas: number; total: number } {
    let realizadas = 0;
    let total = 0;
    for (const c of this.agentesEmCampoLista()) {
      const atividade = this.colaboradoresService.atividadeDe(c.colaborador);
      if (!atividade) continue;
      for (const livro of atividade.livros) {
        const ehMassiva = livro.tipoServico === 'massiva';
        if (ehMassiva !== (this.escopo === 'massiva')) continue;
        realizadas += livro.digitados;
        total += livro.digitados + livro.naoDigitados;
      }
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

  private chaveOrdenacao(linha: DetalheLinha, coluna: ColunaOrdenavel): string | number {
    switch (coluna) {
      case 'regional':
        return linha.regional ?? '';
      case 'livro':
        return linha.livro;
      case 'etapa':
        return linha.etapa;
      case 'status':
        return linha.status;
      case 'tipoServico':
        return linha.tipo_servico;
      case 'dt_prev_limite':
        return linha.dt_prev_limite ? new Date(linha.dt_prev_limite).getTime() : -Infinity;
      case 'quantidade':
        return linha.digitados;
      case 'leiturista':
        return linha.leiturista ?? '';
      case 'diasAtraso':
        return this.diasAtraso(linha);
      case 'percentual':
        return this.percentualLinha(linha);
      case 'diasPrazoRegulatorio':
        return linha.dias_prazo_regulatorio ?? -Infinity;
      case 'dataRecebimento':
        return this.dataRecebimentoMs(linha);
    }
  }

  // "DD/MM/YYYY HH:MM" (ou só "DD/MM/YYYY") -> epoch, só pra ordenar a
  // coluna direito — o formato brasileiro não ordena certo como string.
  private dataRecebimentoMs(linha: DetalheLinha): number {
    if (!linha.data_recebimento) return -Infinity;
    const [dataParte, horaParte] = linha.data_recebimento.split(' ');
    const [d, m, a] = dataParte.split('/').map(Number);
    const [h, min] = (horaParte || '0:0').split(':').map(Number);
    return Date.UTC(a, m - 1, d, h || 0, min || 0);
  }

  indicadorOrdenacao(coluna: ColunaOrdenavel): string {
    if (this.colunaOrdenacao() !== coluna) return '';
    return this.direcaoOrdenacao() === 'asc' ? ' ▲' : ' ▼';
  }

  linhasOrdenadas(): DetalheLinha[] {
    const linhas = this.monitoramentoService.detalhe();
    const coluna = this.colunaOrdenacao();

    // Sem coluna escolhida pelo usuário (clique num cabeçalho): ordena pelos
    // mais críticos primeiro, em qualquer filtro/aba — dias em atraso desc
    // (é a única noção de "atraso" que as duas abas já calculam da mesma
    // forma, ver diasAtraso()), com % de execução asc como desempate (quem
    // fez menos ainda é mais crítico entre dois livros com o mesmo atraso).
    if (!coluna) {
      return [...linhas].sort((a, b) => {
        const atrasoA = this.diasAtraso(a);
        const atrasoB = this.diasAtraso(b);
        if (atrasoA !== atrasoB) return atrasoB - atrasoA;
        return this.percentualLinha(a) - this.percentualLinha(b);
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

  // Paginação client-side — o detalhe inteiro já vem numa resposta só, então
  // paginar aqui em vez de ir ao backend a cada página. OPCOES_ITENS_POR_PAGINA
  // vira atalhos rápidos ao lado do campo numérico livre (que aceita
  // qualquer valor até o teto).
  readonly OPCOES_ITENS_POR_PAGINA = [25, 50, 100, 250];
  readonly MAX_ITENS_POR_PAGINA = 250;

  totalPaginas(): number {
    return Math.max(1, Math.ceil(this.linhasOrdenadas().length / this.monitoramentoService.itensPorPagina()));
  }

  // Corrige sozinho quando um filtro reduz o resultado e a página guardada
  // ficou além do novo total (em vez de mostrar uma página vazia).
  paginaEfetiva(): number {
    return Math.min(Math.max(1, this.monitoramentoService.paginaAtual()), this.totalPaginas());
  }

  linhasPaginadas(): DetalheLinha[] {
    const porPagina = this.monitoramentoService.itensPorPagina();
    const inicio = (this.paginaEfetiva() - 1) * porPagina;
    return this.linhasOrdenadas().slice(inicio, inicio + porPagina);
  }

  irParaPagina(pagina: number): void {
    this.monitoramentoService.paginaAtual.set(Math.min(Math.max(1, pagina), this.totalPaginas()));
  }

  // `input` opcional: quando o valor digitado é inválido/fora do teto e o
  // signal acaba não mudando (ex.: usuário digita "0" com 250 já selecionado),
  // o binding [value] do Angular não teria motivo pra re-renderizar o campo —
  // ele ficaria mostrando "0" enquanto a tabela continua com 250 linhas.
  // Setar input.value direto garante que o campo sempre reflete o valor
  // válido de verdade, independente de o signal ter mudado ou não.
  alterarItensPorPagina(qtd: number | string, input?: HTMLInputElement): void {
    const numero = Math.trunc(Number(qtd));
    const limitado = Number.isFinite(numero) && numero > 0 ? Math.min(numero, this.MAX_ITENS_POR_PAGINA) : this.monitoramentoService.itensPorPagina();
    this.monitoramentoService.itensPorPagina.set(limitado);
    this.monitoramentoService.paginaAtual.set(1);
    if (input) input.value = String(limitado);
  }

  intervaloExibido(): string {
    const total = this.linhasOrdenadas().length;
    if (!total) return '0 registros';
    const porPagina = this.monitoramentoService.itensPorPagina();
    const inicio = (this.paginaEfetiva() - 1) * porPagina + 1;
    const fim = Math.min(inicio + porPagina - 1, total);
    return `${inicio}–${fim} de ${total} registro${total === 1 ? '' : 's'}`;
  }

  valorCard(status: 'pendentes' | 'atribuidas' | 'emExecucao' | 'total' | 'noPrazo' | 'prazoFinal' | 'atrasadas'): number {
    const resumo = this.monitoramentoService.resumo();
    if (!resumo) return 0;
    const contagem = resumo[status];
    return this.monitoramentoService.visualizacao() === 'livros' ? contagem.livros : contagem.leituras;
  }

  // Mesmo padrão do valorCard, pras faixas de dias (prazo_reg_livros) — o
  // toggle Livros/Leituras vale aqui também.
  valorFaixa(faixa: 'menor27' | 'igual33' | 'maior34'): number {
    const contagem = this.monitoramentoService.resumo()?.faixasDias[faixa];
    if (!contagem) return 0;
    return this.monitoramentoService.visualizacao() === 'livros' ? contagem.livros : contagem.leituras;
  }

  cardEmDestaque(status: StatusMonitoramento): boolean {
    const filtro = this.monitoramentoService.filtroStatus();
    return filtro === 'todos' || filtro === status;
  }

  selecionarStatus(status: StatusMonitoramento): void {
    this.monitoramentoService.filtroPrazo.set('');
    this.monitoramentoService.filtroStatus.set(this.monitoramentoService.filtroStatus() === status ? 'todos' : status);
    this.monitoramentoService.buscarTudo();
  }

  // Só usado pelo card "Total massivas" (aba Massivas, visual clássico).
  totalCardEmDestaque(): boolean {
    return this.monitoramentoService.filtroStatus() === 'todos' && !this.monitoramentoService.filtroPrazo();
  }

  selecionarTotal(): void {
    this.monitoramentoService.filtroStatus.set('todos');
    this.monitoramentoService.filtroPrazo.set('');
    this.monitoramentoService.buscarTudo();
  }

  prazoCardEmDestaque(prazo: 'noPrazo' | 'final' | 'atrasada'): boolean {
    const filtroPrazo = this.monitoramentoService.filtroPrazo();
    return !filtroPrazo || filtroPrazo === prazo;
  }

  selecionarPrazo(prazo: 'noPrazo' | 'final' | 'atrasada'): void {
    this.monitoramentoService.filtroPrazo.set(this.monitoramentoService.filtroPrazo() === prazo ? '' : prazo);
    this.monitoramentoService.buscarTudo();
  }

  // Filtro clicável das faixas <27/33/34+ dias (aba Monitoramento de Livros
  // — ADR 0012 Adendo 4). Dimensão independente de status/prazo (é
  // prazo_reg_livros, não contr_execucao_leitura), então não zera os outros
  // filtros ao selecionar — só alterna o próprio.
  faixaEmDestaque(faixa: 'menor27' | 'igual33' | 'maior34'): boolean {
    const filtro = this.monitoramentoService.filtroFaixaDias();
    return !filtro || filtro === faixa;
  }

  selecionarFaixa(faixa: 'menor27' | 'igual33' | 'maior34'): void {
    this.monitoramentoService.filtroFaixaDias.set(this.monitoramentoService.filtroFaixaDias() === faixa ? '' : faixa);
    this.monitoramentoService.buscarTudo();
  }

  abrirHistorico(livro: string): void {
    this.monitoramentoService.abrirHistoricoLivro(livro);
  }

  // Clique no valor da célula Regional/Leiturista filtra a tabela por aquele
  // valor exato (item 4). stopPropagation() é obrigatório — a linha inteira
  // já tem (click)="abrirHistorico(...)", sem isso o clique acionaria os
  // dois.
  filtrarPorRegional(regional: string, evento: Event): void {
    evento.stopPropagation();
    this.aplicarFiltroRegional(regional);
  }

  filtrarPorLeiturista(leiturista: string, evento: Event): void {
    evento.stopPropagation();
    this.aplicarFiltroLeiturista(leiturista);
  }

  // Filtros "estilo Excel" embutidos no cabeçalho (item 4, refeito depois do
  // usuário achar a barra de campos sempre visível "ridícula" — agora cada
  // coluna tem só um ícone de funil que abre o popover, ver
  // filtro-coluna.ts). `opcoes[0]` de cada lista é sempre a entrada de
  // "limpar" — Regional/Etapa usam '' (mesmo sentinela de sempre pro filtro
  // vazio), Status/Tipo já tinham seu próprio sentinela ('todos'/
  // 'leiturarelitura') antes disso existir, mantido igual pra não mudar o
  // contrato com o backend.
  readonly OPCOES_STATUS: OpcaoFiltroColuna[] = [
    { valor: 'todos', rotulo: 'Todos' },
    { valor: 'pendentes', rotulo: 'Pendentes' },
    { valor: 'atribuidas', rotulo: 'Atribuídas' },
    { valor: 'emExecucao', rotulo: 'Em execução' },
  ];

  readonly OPCOES_TIPO_SERVICO: OpcaoFiltroColuna[] = [
    { valor: 'leiturarelitura', rotulo: 'Todos' },
    { valor: 'leitura', rotulo: 'Leitura' },
    { valor: 'releitura', rotulo: 'Releitura' },
  ];

  readonly OPCOES_PRAZO_FAIXA: OpcaoFiltroColuna[] = [
    { valor: '', rotulo: 'Todos' },
    { valor: 'menor27', rotulo: '< 27 dias' },
    { valor: 'igual33', rotulo: '33 dias' },
    { valor: 'maior34', rotulo: '34+ dias' },
  ];

  opcoesRegional(): OpcaoFiltroColuna[] {
    return [{ valor: '', rotulo: 'Todas' }, ...this.monitoramentoService.regionais().map(r => ({ valor: r, rotulo: r }))];
  }

  opcoesEtapa(): OpcaoFiltroColuna[] {
    return [{ valor: '', rotulo: 'Todas' }, ...this.monitoramentoService.etapas().map(e => ({ valor: e, rotulo: `Etapa ${e}` }))];
  }

  aplicarFiltroRegional(valor: string): void {
    this.monitoramentoService.filtroRegional.set(valor);
    this.monitoramentoService.buscarTudo();
  }

  aplicarFiltroLivro(valor: string): void {
    this.monitoramentoService.filtroLivro.set(valor);
    this.monitoramentoService.buscarComDebounce();
  }

  aplicarFiltroEtapa(valor: string): void {
    this.monitoramentoService.filtroEtapa.set(valor);
    this.monitoramentoService.buscarTudo();
  }

  aplicarFiltroStatus(valor: string): void {
    this.monitoramentoService.filtroStatus.set(valor as StatusMonitoramento);
    this.onStatusChange();
  }

  aplicarFiltroTipoServico(valor: string): void {
    this.monitoramentoService.filtroTipoServico.set(valor as TipoServico);
    this.monitoramentoService.onTipoServicoChange();
  }

  aplicarFiltroFaixaDias(valor: string): void {
    this.monitoramentoService.filtroFaixaDias.set(valor as FaixaDiasMonitoramento);
    this.monitoramentoService.buscarTudo();
  }

  aplicarFiltroLeiturista(valor: string): void {
    this.monitoramentoService.filtroColaborador.set(valor);
    this.monitoramentoService.buscarComDebounce();
  }

  onStatusChange(): void {
    this.monitoramentoService.buscarTudo();
  }

  // Comparação por DIA, não por hora — de propósito. A tabela mistura massiva
  // (dt_prev_limite = calendario_leitura.prazo_massiva, sempre meia-noite,
  // sem componente de hora) com leitura/releitura (que desde a ADR 0011 tem
  // hora real); comparar timestamp completo fazia todo item de massiva com
  // vencimento HOJE aparecer "1 dia em atraso" e vermelho mesmo o card
  // "Atraso" batendo 0 — meia-noite de hoje sempre fica no passado frente à
  // hora real do scrape. O cálculo hora-a-hora da releitura já vale nos
  // cards (backend, condicaoSqlPrazoContr); aqui, cor da linha e "dias em
  // atraso" ficam em dia inteiro pros dois tipos de fonte, consistente.
  private hojeUtcMs(): number | null {
    const hoje = this.monitoramentoService.resumo()?.dataImport;
    if (!hoje) return null;
    const [d, m, a] = hoje.split('/').map(Number);
    return Date.UTC(a, m - 1, d);
  }

  private prazoUtcMs(dtPrevLimite: string): number {
    const d = new Date(dtPrevLimite);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  diasAtraso(linha: DetalheLinha): number {
    const hoje = this.hojeUtcMs();
    if (hoje === null || !linha.dt_prev_limite) return 0;
    const prazo = this.prazoUtcMs(linha.dt_prev_limite);
    const dias = Math.round((hoje - prazo) / 86400000);
    return dias > 0 ? dias : 0;
  }

  corLinha(linha: DetalheLinha): CorLinha {
    const hoje = this.hojeUtcMs();
    if (hoje === null || !linha.dt_prev_limite) return 'verde';
    const prazo = this.prazoUtcMs(linha.dt_prev_limite);
    if (prazo < hoje) return 'vermelho';
    if (prazo === hoje) return 'amarelo';
    return 'verde';
  }

  // % de execução do livro (digitados/total) — mesma conta usada no card
  // "Progresso de atividades" da barra de resumo, só que por linha.
  percentualLinha(linha: DetalheLinha): number {
    const total = linha.digitados + linha.nao_digitados;
    return total > 0 ? (linha.digitados / total) * 100 : 0;
  }

  corPercentual(pct: number): CorLinha {
    if (pct >= 70) return 'verde';
    if (pct >= 30) return 'amarelo';
    return 'vermelho';
  }

  // Destaque da coluna "Prazo regulatório": só os dois extremos chamam
  // atenção (>33 dias = já passou do prazo regulatório de 33 dias, crítico;
  // <27 dias = ainda folgado). A faixa 27-33 fica neutra, de propósito — é a
  // janela "normal", sem necessidade de alerta.
  corPrazoRegulatorio(dias: number | null): 'verde' | 'vermelho' | null {
    if (dias === null) return null;
    if (dias < 27) return 'verde';
    if (dias > 33) return 'vermelho';
    return null;
  }
}
