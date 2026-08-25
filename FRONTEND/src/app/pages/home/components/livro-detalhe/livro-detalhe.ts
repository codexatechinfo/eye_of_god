import { Component, ElementRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ColaboradoresService } from '../../../../services/colaboradores.service';

@Component({
  selector: 'app-livro-detalhe',
  imports: [CommonModule],
  templateUrl: './livro-detalhe.html',
  styleUrl: './livro-detalhe.css',
})
export class LivroDetalhe {
  constructor(
    public colaboradoresService: ColaboradoresService,
    private elementRef: ElementRef<HTMLElement>,
  ) {}

  // O clique que ABRE o painel (botão "Livro X" na lista) já para a
  // propagação (ver lista-colaboradores.html), então nunca chega aqui no
  // mesmo evento — sem isso, abrir um livro diferente com o painel já
  // aberto fecharia ele de novo no mesmo clique.
  @HostListener('document:click', ['$event'])
  aoClicarFora(evento: MouseEvent): void {
    if (!this.colaboradoresService.livroSelecionado()) return;
    if (!this.elementRef.nativeElement.contains(evento.target as Node)) {
      this.fechar();
    }
  }

  fechar(): void {
    this.colaboradoresService.fecharLivro();
  }
}
