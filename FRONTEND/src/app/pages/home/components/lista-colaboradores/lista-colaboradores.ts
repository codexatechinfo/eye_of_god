import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  AtividadeColaborador,
  CategoriaAtividade,
  ColaboradoresService,
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

  constructor(public colaboradoresService: ColaboradoresService) {}

  selecionar(nome: string): void {
    this.colaboradoresService.selecionarColaborador(nome);
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
