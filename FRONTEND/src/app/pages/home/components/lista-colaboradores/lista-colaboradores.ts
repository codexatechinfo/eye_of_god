import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  AtividadeColaborador,
  CategoriaAtividade,
  ColaboradoresService,
  formatarDistancia,
  formatarDuracao,
  LivroAtividade,
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

  constructor(public colaboradoresService: ColaboradoresService) {}

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

  abrirLivro(colaboradorNome: string, livro: LivroAtividade): void {
    this.colaboradoresService.abrirLivro(colaboradorNome, livro);
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
