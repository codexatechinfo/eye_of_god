import { Component, Input, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DetalheLinha, EscopoMassivas, MassivasService, StatusMassivas } from '../../../../services/massivas.service';

type CorLinha = 'verde' | 'amarelo' | 'vermelho';
type ColunaOrdenavel = 'regional' | 'livro' | 'etapa' | 'status' | 'tipoServico' | 'dt_prev_limite' | 'quantidade' | 'leiturista' | 'diasAtraso';
type DirecaoOrdenacao = 'asc' | 'desc';

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

  constructor(public massivasService: MassivasService) {}

  ngOnInit(): void {
    this.massivasService.iniciar(this.escopo);
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

  valorCard(status: 'pendentes' | 'atribuidas' | 'emExecucao' | 'total' | 'noPrazo' | 'prazoFinal' | 'atrasadas'): number {
    const resumo = this.massivasService.resumo();
    if (!resumo) return 0;
    const contagem = resumo[status];
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

  abrirHistorico(livro: string): void {
    this.massivasService.abrirHistoricoLivro(livro);
  }

  onStatusChange(): void {
    this.massivasService.buscarTudo();
  }

  // "Agora" é o momento do último scrape (data+hora de importação), não o
  // relógio real — mesmo padrão do backend (IMPORT_TS_CONTR_SQL em
  // massivasService.js). Precisão de hora importa desde que releitura passou
  // a ter prazo por hora (recebimento + 24h/48h, não mais por dia).
  private agoraMs(): number | null {
    const r = this.massivasService.resumo();
    if (!r?.dataImport) return null;
    const [d, m, a] = r.dataImport.split('/').map(Number);
    if (!r.horaImport) return Date.UTC(a, m - 1, d);
    const [h, mi, s] = r.horaImport.split(':').map(Number);
    return Date.UTC(a, m - 1, d, h || 0, mi || 0, s || 0);
  }

  private prazoMs(dtPrevLimite: string): number {
    return new Date(dtPrevLimite).getTime();
  }

  private diaUtc(ms: number): number {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  diasAtraso(linha: DetalheLinha): number {
    const agora = this.agoraMs();
    if (agora === null || !linha.dt_prev_limite) return 0;
    const prazo = this.prazoMs(linha.dt_prev_limite);
    const dias = Math.round((agora - prazo) / 86400000);
    return dias > 0 ? dias : 0;
  }

  corLinha(linha: DetalheLinha): CorLinha {
    const agora = this.agoraMs();
    if (agora === null || !linha.dt_prev_limite) return 'verde';
    const prazo = this.prazoMs(linha.dt_prev_limite);
    if (prazo < agora) return 'vermelho';
    if (this.diaUtc(prazo) === this.diaUtc(agora)) return 'amarelo';
    return 'verde';
  }
}
