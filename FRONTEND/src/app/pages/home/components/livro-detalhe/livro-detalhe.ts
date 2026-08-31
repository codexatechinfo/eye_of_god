import { Component, ElementRef, HostListener, QueryList, ViewChildren, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  ColaboradoresService,
  corDaUc,
  ehCodigoDeImpedimento,
  formatarDistancia,
  formatarDuracao,
  mapaPrimeiraUcPorCodigo,
  ordenarPorSequencia,
  TimelineUcItem,
} from '../../../../services/colaboradores.service';

// Mudança de colaborador/situação detectada entre uma UC realizada e a
// última UC realizada antes dela na ordem de rota — ver mudancasPorUc.
export interface MudancaContexto {
  colaboradorAnterior: string | null;
  colaboradorAtual: string | null;
  situacaoAnterior: string | null;
  situacaoAtual: string | null;
}

@Component({
  selector: 'app-livro-detalhe',
  imports: [CommonModule],
  templateUrl: './livro-detalhe.html',
  styleUrl: './livro-detalhe.css',
})
export class LivroDetalhe {
  // Marcadas com #linhaUc no template (uma por UC da timeline) — usadas
  // pra rolar até a UC focada (clique num ponto do mapa, ver mapa-bases.ts).
  @ViewChildren('linhaUc') private linhas!: QueryList<ElementRef<HTMLElement>>;

  constructor(
    public colaboradoresService: ColaboradoresService,
    private elementRef: ElementRef<HTMLElement>,
  ) {
    effect(() => {
      const uc = this.colaboradoresService.ucFocada();
      if (!uc || !this.linhas) return;
      const linha = this.linhas.find(ref => ref.nativeElement.dataset['uc'] === uc);
      linha?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  // O clique que ABRE o painel (botão "Livro X" na lista) já para a
  // propagação (ver lista-colaboradores.html), então nunca chega aqui no
  // mesmo evento — sem isso, abrir um livro diferente com o painel já
  // aberto fecharia ele de novo no mesmo clique.
  //
  // Cliques DENTRO do mapa (app-mapa-bases) também não fecham o painel: o
  // clique no marcador do colaborador que ABRE o painel bolha até
  // `document` no mesmo evento, e como o alvo (o marcador) não está dentro
  // do elemento do painel, fechava de volta imediatamente — usuário via o
  // painel/rota abrir e sumir no mesmo clique. Mesmo problema em qualquer
  // outra interação com o mapa (clique vazio, controle de camadas) que
  // borbulhe um "click" até o document.
  @HostListener('document:click', ['$event'])
  aoClicarFora(evento: MouseEvent): void {
    if (!this.colaboradoresService.livroSelecionado()) return;
    const alvo = evento.target as Node;
    if (this.elementRef.nativeElement.contains(alvo)) return;
    if (document.querySelector('app-mapa-bases')?.contains(alvo)) return;
    this.fechar();
  }

  fechar(): void {
    this.colaboradoresService.fecharLivro();
  }

  // Lista única do livro inteiro (realizadas e não), ordenada por sequencia
  // (ordem de rota) — substitui os dois blocos separados que existiam antes
  // (timeline cronológica + "não realizadas" à parte).
  ucsOrdenadas = computed(() => ordenarPorSequencia(this.colaboradoresService.atuaisLivro()));

  // Mesma regra de cor usada nos pontos do mapa (mapa-bases.ts) — ver
  // mapaPrimeiraUcPorCodigo/corDaUc em colaboradores.service.ts.
  private primeiraUcPorCodigo = computed(() => mapaPrimeiraUcPorCodigo(this.colaboradoresService.timelineLivro()));

  // colaborador/situacao em atuaisLivro() refletem o LOTE mais recente
  // (o scraper grava esses dois campos iguais pra TODAS as UCs do livro em
  // cada ciclo — confirmado ao vivo: nenhum lote tem UCs de colaboradores
  // diferentes), então não servem pra saber "quem leu esta UC especifica".
  // timelineLivro() (primeira vez que cada UC ficou com codigo) captura o
  // lote de quando ela foi lida de fato — essa é a fonte certa pra detectar
  // troca de colaborador/situação ao longo da rota.
  private timelinePorUc = computed(() => new Map(this.colaboradoresService.timelineLivro().map(t => [t.uc, t])));

  // Por UC realizada, se colaborador OU situação mudaram desde a última UC
  // realizada antes dela na ordem de rota (mesma noção de "anterior" do
  // deslocamento — pula UCs pendentes no meio). Só entra no mapa quando
  // houve mudança de fato.
  mudancasPorUc = computed(() => {
    const timelinePorUc = this.timelinePorUc();
    const mapa = new Map<string, MudancaContexto>();
    let ultimoRealizado: TimelineUcItem | null = null;

    for (const item of this.ucsOrdenadas()) {
      if (!item.codigo) continue;
      const dadosAtual = timelinePorUc.get(item.uc) ?? item;

      if (ultimoRealizado) {
        const dadosAnterior = timelinePorUc.get(ultimoRealizado.uc) ?? ultimoRealizado;
        if (dadosAnterior.colaborador !== dadosAtual.colaborador || dadosAnterior.situacao !== dadosAtual.situacao) {
          mapa.set(item.uc, {
            colaboradorAnterior: dadosAnterior.colaborador,
            colaboradorAtual: dadosAtual.colaborador,
            situacaoAnterior: dadosAnterior.situacao,
            situacaoAtual: dadosAtual.situacao,
          });
        }
      }

      ultimoRealizado = item;
    }

    return mapa;
  });

  corDoPonto(item: TimelineUcItem): 'verde' | 'cinza' | 'laranja' | 'vermelho' {
    return corDaUc(item, this.primeiraUcPorCodigo());
  }

  distanciaFormatada(metros: number | null): string {
    return formatarDistancia(metros);
  }

  duracaoFormatada(segundos: number | null): string {
    return formatarDuracao(segundos);
  }

  ehImpedimento(codigo: string | null): boolean {
    return ehCodigoDeImpedimento(codigo);
  }

  // Accordion: clicar numa UC expande o card de detalhe dela (endereço,
  // deslocamento, regime sucessivo etc.) — só uma expandida por vez. Se for
  // ABRIR (não fechar) e a UC tiver código de impedimento, já dispara a
  // busca do regime sucessivo (sob demanda, não em lote pra toda a lista).
  toggleExpandir(item: TimelineUcItem): void {
    const abrindo = this.colaboradoresService.ucExpandida() !== item.uc;
    this.colaboradoresService.ucExpandida.set(abrindo ? item.uc : null);
    if (abrindo && ehCodigoDeImpedimento(item.codigo)) {
      this.colaboradoresService.carregarRegimeSucessivo(item.uc);
    }
  }

  centralizarNoMapa(item: TimelineUcItem): void {
    if (!item.latitude || !item.longitude) return;
    this.colaboradoresService.centralizarEm.set({ lat: Number(item.latitude), lng: Number(item.longitude) });
  }

  linkStreetView(item: TimelineUcItem): string | null {
    if (!item.latitude || !item.longitude) return null;
    return `https://www.google.com/maps?layer=c&cbll=${item.latitude},${item.longitude}`;
  }
}
