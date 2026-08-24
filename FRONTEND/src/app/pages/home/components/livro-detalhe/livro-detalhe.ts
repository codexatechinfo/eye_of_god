import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  ColaboradoresService,
  formatarDuracao,
  LivroAtividade,
  mediaLeiturasPorMinuto,
  produtividade,
} from '../../../../services/colaboradores.service';

@Component({
  selector: 'app-livro-detalhe',
  imports: [CommonModule],
  templateUrl: './livro-detalhe.html',
  styleUrl: './livro-detalhe.css',
})
export class LivroDetalhe {
  constructor(public colaboradoresService: ColaboradoresService) {}

  fechar(): void {
    this.colaboradoresService.fecharLivro();
  }

  mediaLeiturasPorMinuto(livro: LivroAtividade): number {
    return mediaLeiturasPorMinuto(livro);
  }

  produtividade(livro: LivroAtividade) {
    return produtividade(livro);
  }

  formatarDuracao(minutos: number): string {
    return formatarDuracao(minutos);
  }
}
