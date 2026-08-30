import { Component, ElementRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ColaboradoresService, ehCodigoDeImpedimento } from '../../../../services/colaboradores.service';

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

  ehImpedimento(codigo: string | null): boolean {
    return ehCodigoDeImpedimento(codigo);
  }

  // UCs do livro que ainda não têm codigo preenchido — não entram em
  // timelineLivro (que só tem "quando foi realizada", não existe pra quem
  // nunca foi). Aparecem depois da timeline, com ponto cinza (pedido do
  // usuário), pra a lista mostrar o livro inteiro, não só o que já rodou.
  naoRealizadas() {
    return this.colaboradoresService.atuaisLivro().filter(uc => !uc.codigo);
  }
}
