import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DetalheLinha, MassivasService, StatusMassivas } from '../../../../services/massivas.service';

type CorLinha = 'verde' | 'amarelo' | 'vermelho';
type ColunaOrdenavel = 'regional' | 'livro' | 'etapa' | 'status' | 'tipoServico' | 'dt_prev_limite' | 'quantidade' | 'leiturista' | 'diasAtraso';
type DirecaoOrdenacao = 'asc' | 'desc';

@Component({
  selector: 'app-massivas-view',
  imports: [CommonModule, FormsModule],
  templateUrl: './massivas-view.html',
  styleUrl: './massivas-view.css',
})
export class MassivasView {
  constructor(public massivasService: MassivasService) {}

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
