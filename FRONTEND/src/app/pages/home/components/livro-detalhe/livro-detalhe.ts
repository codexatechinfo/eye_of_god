import { Component, ElementRef, HostListener, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  ColaboradoresService,
  ehCodigoDeImpedimento,
  TimelineUcItem,
} from '../../../../services/colaboradores.service';

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

  // Lista única do livro inteiro (realizadas e não), ordenada por sequencia
  // (ordem de rota) — substitui os dois blocos separados que existiam antes
  // (timeline cronológica + "não realizadas" à parte).
  ucsOrdenadas = computed(() => {
    return [...this.colaboradoresService.atuaisLivro()].sort((a, b) => {
      const sa = Number(a.sequencia);
      const sb = Number(b.sequencia);
      const va = Number.isFinite(sa) ? sa : Infinity;
      const vb = Number.isFinite(sb) ? sb : Infinity;
      return va - vb || a.uc.localeCompare(b.uc);
    });
  });

  // Qual UC foi a primeira, cronologicamente, a mostrar cada código de
  // impedimento no livro — usado só pra decidir "vermelho" (código repetido
  // em UC diferente), nunca pra decidir a cor de uma UC contra ela mesma.
  private primeiraUcPorCodigo = computed(() => {
    const mapa = new Map<string, string>();
    for (const item of this.colaboradoresService.timelineLivro()) {
      if (item.codigo && this.ehImpedimento(item.codigo) && !mapa.has(item.codigo)) {
        mapa.set(item.codigo, item.uc);
      }
    }
    return mapa;
  });

  corDoPonto(item: TimelineUcItem): 'verde' | 'cinza' | 'laranja' | 'vermelho' {
    if (!item.codigo) return 'cinza';
    if (!this.ehImpedimento(item.codigo)) return 'verde';
    const primeiraUc = this.primeiraUcPorCodigo().get(item.codigo);
    return primeiraUc && primeiraUc !== item.uc ? 'vermelho' : 'laranja';
  }
}
