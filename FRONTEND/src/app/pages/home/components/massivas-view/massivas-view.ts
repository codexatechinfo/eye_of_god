import { Component, Input, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DetalheLinha, EscopoMassivas, MassivasService, StatusMassivas } from '../../../../services/massivas.service';
import { ColaboradoresService } from '../../../../services/colaboradores.service';

type CorLinha = 'verde' | 'amarelo' | 'vermelho';
type ColunaOrdenavel = 'regional' | 'livro' | 'etapa' | 'status' | 'tipoServico' | 'dt_prev_limite' | 'quantidade' | 'leiturista' | 'diasAtraso';
type DirecaoOrdenacao = 'asc' | 'desc';

// Limite pra "comunicação" na barra de resumo (anexo2 do usuário) — diferente
// do limite de 20min já usado pro toggle Parado/Ativo/Sem sincronismo da
// aba Trilho (LIMITE_PARADO_MINUTOS em atividadeColaboradoresService.js).
// Deliberadamente um número separado: mudar esse aqui não deve alterar o
// comportamento já validado do Trilho.
const LIMITE_COMUNICACAO_MINUTOS = 30;

@Component({
  selector: 'app-massivas-view',
  imports: [CommonModule, FormsModule],
  templateUrl: './massivas-view.html',
  styleUrl: './massivas-view.css',
  // Instância própria por aba — a de Massivas e a de Monitoramento de
  // Livros não podem compartilhar filtro (ver massivas.service.ts).
  providers: [MassivasService],
})
export class MassivasView implements OnInit {
  // 'massiva': aba Massivas, comportamento de antes da ADR 0006 (só
  // massiva, sem seletor de tipo). 'leiturarelitura': aba Monitoramento de
  // Livros, só leitura/releitura — nunca massiva, que agora tem aba própria.
  @Input() escopo: EscopoMassivas = 'leiturarelitura';

  // ColaboradoresService é singleton (providedIn: 'root', ao contrário de
  // MassivasService) — é a mesma instância que a aba Trilho usa, de
  // propósito: "agentes em campo" é uma métrica global de colaborador, não
  // depende de qual aba de massiva/livros está aberta.
  constructor(
    public massivasService: MassivasService,
    public colaboradoresService: ColaboradoresService,
  ) {}

  ngOnInit(): void {
    this.massivasService.iniciar(this.escopo);
  }

  // Barra de resumo (anexo2) — "em campo" é MONITOR de fora (cargo próprio,
  // sempre "na base") e LEITURISTA/LEITURISTA MOTOCICLISTA com atividade
  // registrada hoje em contr_execucao_leitura (mesmo dado que a aba Trilho
  // já usa pra Ativo/Parado/Sem sincronismo).
  totalAtivos(): number {
    return this.colaboradoresService.colaboradores().length;
  }

  private agentesEmCampoLista() {
    return this.colaboradoresService
      .colaboradores()
      .filter(c => c.cargo !== 'MONITOR' && this.colaboradoresService.atividadeDe(c.colaborador));
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

  agentesNaBase(): number {
    return this.colaboradoresService.colaboradores().filter(c => c.cargo === 'MONITOR').length;
  }

  comunicacaoOk(): number {
    return this.agentesEmCampoLista().filter(c => {
      const atividade = this.colaboradoresService.atividadeDe(c.colaborador);
      return (atividade?.minutosParado ?? Infinity) < LIMITE_COMUNICACAO_MINUTOS;
    }).length;
  }

  comunicacaoPercent(): number {
    const total = this.agentesEmCampo();
    return total > 0 ? (this.comunicacaoOk() / total) * 100 : 0;
  }

  semComunicar30(): number {
    return this.agentesEmCampo() - this.comunicacaoOk();
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
    }
  }

  indicadorOrdenacao(coluna: ColunaOrdenavel): string {
    if (this.colunaOrdenacao() !== coluna) return '';
    return this.direcaoOrdenacao() === 'asc' ? ' ▲' : ' ▼';
  }

  linhasOrdenadas(): DetalheLinha[] {
    const linhas = this.massivasService.detalhe();
    const coluna = this.colunaOrdenacao();
    if (!coluna) return linhas;

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
  // fica exposto pro template montar o <select>.
  readonly OPCOES_ITENS_POR_PAGINA = [25, 50, 100, 200];

  totalPaginas(): number {
    return Math.max(1, Math.ceil(this.linhasOrdenadas().length / this.massivasService.itensPorPagina()));
  }

  // Corrige sozinho quando um filtro reduz o resultado e a página guardada
  // ficou além do novo total (em vez de mostrar uma página vazia).
  paginaEfetiva(): number {
    return Math.min(Math.max(1, this.massivasService.paginaAtual()), this.totalPaginas());
  }

  linhasPaginadas(): DetalheLinha[] {
    const porPagina = this.massivasService.itensPorPagina();
    const inicio = (this.paginaEfetiva() - 1) * porPagina;
    return this.linhasOrdenadas().slice(inicio, inicio + porPagina);
  }

  irParaPagina(pagina: number): void {
    this.massivasService.paginaAtual.set(Math.min(Math.max(1, pagina), this.totalPaginas()));
  }

  alterarItensPorPagina(qtd: number): void {
    this.massivasService.itensPorPagina.set(Number(qtd));
    this.massivasService.paginaAtual.set(1);
  }

  intervaloExibido(): string {
    const total = this.linhasOrdenadas().length;
    if (!total) return '0 registros';
    const porPagina = this.massivasService.itensPorPagina();
    const inicio = (this.paginaEfetiva() - 1) * porPagina + 1;
    const fim = Math.min(inicio + porPagina - 1, total);
    return `${inicio}–${fim} de ${total} registro${total === 1 ? '' : 's'}`;
  }

  valorCard(status: 'pendentes' | 'atribuidas' | 'emExecucao' | 'total' | 'noPrazo' | 'prazoFinal' | 'atrasadas'): number {
    const resumo = this.massivasService.resumo();
    if (!resumo) return 0;
    const contagem = resumo[status];
    return this.massivasService.visualizacao() === 'livros' ? contagem.livros : contagem.leituras;
  }

  // Mesmo padrão do valorCard, pras faixas de dias (prazo_reg_livros) — o
  // toggle Livros/Leituras vale aqui também.
  valorFaixa(faixa: 'menor27' | 'igual33' | 'maior34'): number {
    const contagem = this.massivasService.resumo()?.faixasDias[faixa];
    if (!contagem) return 0;
    return this.massivasService.visualizacao() === 'livros' ? contagem.livros : contagem.leituras;
  }

  cardEmDestaque(status: StatusMassivas): boolean {
    const filtro = this.massivasService.filtroStatus();
    return filtro === 'todos' || filtro === status;
  }

  selecionarStatus(status: StatusMassivas): void {
    this.massivasService.filtroPrazo.set('');
    this.massivasService.filtroStatus.set(this.massivasService.filtroStatus() === status ? 'todos' : status);
    this.massivasService.buscarTudo();
  }

  // Só usado pelo card "Total massivas" (aba Massivas, visual clássico).
  totalCardEmDestaque(): boolean {
    return this.massivasService.filtroStatus() === 'todos' && !this.massivasService.filtroPrazo();
  }

  selecionarTotal(): void {
    this.massivasService.filtroStatus.set('todos');
    this.massivasService.filtroPrazo.set('');
    this.massivasService.buscarTudo();
  }

  prazoCardEmDestaque(prazo: 'noPrazo' | 'final' | 'atrasada'): boolean {
    const filtroPrazo = this.massivasService.filtroPrazo();
    return !filtroPrazo || filtroPrazo === prazo;
  }

  selecionarPrazo(prazo: 'noPrazo' | 'final' | 'atrasada'): void {
    this.massivasService.filtroPrazo.set(this.massivasService.filtroPrazo() === prazo ? '' : prazo);
    this.massivasService.buscarTudo();
  }

  // Filtro clicável das faixas <27/33/34+ dias (aba Monitoramento de Livros
  // — ADR 0012 Adendo 4). Dimensão independente de status/prazo (é
  // prazo_reg_livros, não contr_execucao_leitura), então não zera os outros
  // filtros ao selecionar — só alterna o próprio.
  faixaEmDestaque(faixa: 'menor27' | 'igual33' | 'maior34'): boolean {
    const filtro = this.massivasService.filtroFaixaDias();
    return !filtro || filtro === faixa;
  }

  selecionarFaixa(faixa: 'menor27' | 'igual33' | 'maior34'): void {
    this.massivasService.filtroFaixaDias.set(this.massivasService.filtroFaixaDias() === faixa ? '' : faixa);
    this.massivasService.buscarTudo();
  }

  abrirHistorico(livro: string): void {
    this.massivasService.abrirHistoricoLivro(livro);
  }

  onStatusChange(): void {
    this.massivasService.buscarTudo();
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
    const hoje = this.massivasService.resumo()?.dataImport;
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
}
