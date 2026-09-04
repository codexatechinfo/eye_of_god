import { Component, ElementRef, QueryList, ViewChildren, effect, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  AtividadeColaborador,
  CategoriaAtividade,
  ColaboradoresService,
  formatarDistancia,
  formatarDuracao,
  formatarTempoParado,
  normalizarRegional,
  OPCOES_CATEGORIA,
  percentualExecucao,
} from '../../../../services/colaboradores.service';

type CorBarra = 'verde' | 'amarelo' | 'vermelho';

@Component({
  selector: 'app-lista-colaboradores',
  imports: [CommonModule, FormsModule],
  templateUrl: './lista-colaboradores.html',
  styleUrl: './lista-colaboradores.css',
})
export class ListaColaboradores {
  opcoesCategoria = OPCOES_CATEGORIA;

  // Barra de jornada expandida (cards de ocupação/trabalhado/ocioso/km) —
  // um só de cada vez, sempre fechada de novo ao trocar de colaborador.
  jornadaExpandida = signal(false);

  // Marcadas com #linhaColaborador no template (uma por colaborador) —
  // usadas pra rolar até o colaborador focado (clique no ícone dele no
  // mapa, ver mapa-bases.ts). Mesmo padrão de #linhaUc em livro-detalhe.ts.
  @ViewChildren('linhaColaborador') private linhas!: QueryList<ElementRef<HTMLElement>>;

  constructor(public colaboradoresService: ColaboradoresService) {
    effect(() => {
      const nome = this.colaboradoresService.colaboradorFocado();
      if (!nome || !this.linhas) return;
      const linha = this.linhas.find(ref => ref.nativeElement.dataset['colaborador'] === nome);
      linha?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  selecionar(nome: string): void {
    this.jornadaExpandida.set(false);
    this.colaboradoresService.selecionarColaborador(nome);
  }

  toggleJornada(): void {
    this.jornadaExpandida.set(!this.jornadaExpandida());
  }

  distanciaFormatada(metros: number | null | undefined): string {
    return formatarDistancia(metros ?? null);
  }

  duracaoFormatada(segundos: number | null | undefined): string {
    return formatarDuracao(segundos ?? null);
  }

  // Cards "Último sincronismo" mostram há QUANTO TEMPO o colaborador não
  // sincroniza (pedido explícito do usuário), não mais a hora do relógio —
  // mesma fórmula já usada no toggle Parado/Ativo/Sem sincronismo
  // (LIMITE_PARADO_MINUTOS) e no modal "sem comunicar" de monitoramento-view.
  tempoSemSincronizar(minutos: number | null | undefined): string {
    return minutos == null ? '--' : formatarTempoParado(minutos);
  }

  toggleCategoria(categoria: CategoriaAtividade): void {
    this.colaboradoresService.alternarFiltroCategoria(categoria);
  }

  regionalDe(base: string): string {
    return normalizarRegional(base);
  }

  // Cargo cru de ativos_inativos vira um rótulo mais claro na lista.
  rotuloCargo(cargo: string): string {
    if (cargo === 'LEITURISTA MOTOCICLISTA') return 'Motoqueiro';
    if (cargo === 'LEITURISTA') return 'Pedestre';
    if (cargo === 'MONITOR') return 'Monitor';
    return cargo;
  }

  // Barra de progresso abaixo do nome — mesmo % que agora também ordena a
  // lista (pontuacaoDestaque em colaboradores.service.ts).
  percentual(nome: string): number {
    return percentualExecucao(this.colaboradoresService.atividadeDe(nome));
  }

  corBarra(atividade: AtividadeColaborador | null): CorBarra {
    const pct = percentualExecucao(atividade);
    if (pct >= 70) return 'verde';
    if (pct >= 30) return 'amarelo';
    return 'vermelho';
  }
}
