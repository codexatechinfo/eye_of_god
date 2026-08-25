import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  CategoriaAtividade,
  ColaboradoresService,
  LivroAtividade,
  normalizarRegional,
  OPCOES_CATEGORIA,
} from '../../../../services/colaboradores.service';

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
}
