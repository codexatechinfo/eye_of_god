import { Component, ElementRef, EventEmitter, HostListener, Input, OnDestroy, Output, ViewChild, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

export interface OpcaoFiltroColuna {
  valor: string;
  rotulo: string;
}

// Filtro "estilo Excel" embutido no cabeçalho da tabela (monitoramento-view):
// um ícone de funil ao lado do título da coluna que abre um popover com
// campo de busca + lista de opções clicável. Cobre os dois modos usados na
// tabela "Detalhe por livro":
// - `opcoes` preenchido (Regional/Etapa/Status/Tipo/Prazo regulatório):
//   busca filtra a lista, clique numa opção aplica e fecha. `opcoes[0]` é
//   sempre a entrada de "limpar" (ex.: {valor:'', rotulo:'Todas'}) — nunca
//   some da lista mesmo com busca digitada, mesma ideia do "(Selecionar
//   tudo)" do Excel ficar fixo no topo.
// - `opcoes` null (Livro/Leiturista): não tem lista pra escolher, o próprio
//   campo de busca É o filtro — cada tecla emite `valorChange` (debounce,
//   quando necessário, fica por conta de quem consome, igual já era antes).
@Component({
  selector: 'app-filtro-coluna',
  imports: [CommonModule, FormsModule],
  templateUrl: './filtro-coluna.html',
})
export class FiltroColuna implements OnDestroy {
  @Input() valor = '';
  @Input() opcoes: OpcaoFiltroColuna[] | null = null;
  @Input() placeholder = 'Buscar...';

  @Output() valorChange = new EventEmitter<string>();

  @ViewChild('botaoFiltro') private botaoFiltro?: ElementRef<HTMLButtonElement>;
  @ViewChild('campoBusca') private campoBusca?: ElementRef<HTMLInputElement>;

  aberto = signal(false);
  busca = signal('');
  // Calculadas ao abrir (position: fixed, ancorado no botão do funil) — a
  // primeira versão usava position: absolute dentro do <th>, que a tabela
  // (overflow-x-auto + thead sticky) cortava/deslocava pro lado (usuário
  // reportou com print: "a lista suspensa está lateral"). Fixed ancorado por
  // coordenada de tela ignora o clipping de qualquer ancestral com scroll.
  posicaoTop = signal(0);
  posicaoLeft = signal(0);

  private readonly LARGURA_POPOVER_PX = 208; // w-52
  // Reposiciona (não fecha) em scroll/resize — a 1ª versão fechava no
  // scroll, mas isso disparava sozinho: o focus() do campo de busca (logo
  // abaixo) já causa um scroll-into-view em alguns navegadores, fechando o
  // popover no mesmo instante em que abre (usuário: "não está mostrando
  // nada"); e rolar a tabela de propósito pra ver outra coluna também
  // fechava o filtro que o usuário ainda queria usar ("sai do filtro").
  // Reposicionar mantém o popover ancorado no botão em vez de sumir.
  private readonly reposicionarListener = () => this.posicionar();

  constructor(private elementRef: ElementRef<HTMLElement>) {}

  ngOnDestroy(): void {
    this.pararDeOuvirRolagem();
  }

  // Fecha ao clicar fora do popover — a tabela tem vários filtros
  // simultâneos, então cada um cuida do próprio fechamento (sem overlay de
  // tela cheia, que atrapalharia clicar em outra coluna ou rolar a tabela).
  @HostListener('document:click', ['$event'])
  aoClicarFora(evento: MouseEvent): void {
    if (this.aberto() && !this.elementRef.nativeElement.contains(evento.target as Node)) {
      this.fechar();
    }
  }

  toggle(): void {
    if (this.aberto()) {
      this.fechar();
      return;
    }
    // Modo lista: busca começa vazia (mostra tudo). Modo texto: busca
    // começa com o filtro já aplicado, pra continuar editando de onde parou.
    this.busca.set(this.opcoes ? '' : this.valor);
    this.posicionar();
    this.aberto.set(true);
    // `capture: true` porque o scroll do <div overflow-y-auto>/<div
    // overflow-x-auto> da tabela não borbulha até window/document — só a
    // fase de captura alcança um scroll disparado dentro de um elemento
    // aninhado.
    window.addEventListener('scroll', this.reposicionarListener, true);
    window.addEventListener('resize', this.reposicionarListener);
    // preventScroll: true — sem isso, focar o campo já causa um
    // scroll-into-view em alguns navegadores assim que o popover abre
    // (mesmo ele já estando visível), e isso sozinho bastava pra confundir
    // o usuário achando que "não mostra nada".
    setTimeout(() => this.campoBusca?.nativeElement.focus({ preventScroll: true }));
  }

  fechar(): void {
    this.aberto.set(false);
    this.pararDeOuvirRolagem();
  }

  private pararDeOuvirRolagem(): void {
    window.removeEventListener('scroll', this.reposicionarListener, true);
    window.removeEventListener('resize', this.reposicionarListener);
  }

  private posicionar(): void {
    const botao = this.botaoFiltro?.nativeElement;
    if (!botao) return;
    const rect = botao.getBoundingClientRect();
    // Encosta a borda DIREITA do popover na borda direita do botão quando
    // não há espaço suficiente à direita pra abrir alinhado à esquerda dele
    // (colunas perto da borda direita da tabela, mesmo cenário do bug
    // original) — nunca deixa o popover estourar a tela.
    const espacoDisponivel = window.innerWidth - rect.left;
    const left =
      espacoDisponivel >= this.LARGURA_POPOVER_PX ? rect.left : Math.max(8, rect.right - this.LARGURA_POPOVER_PX);
    this.posicaoTop.set(rect.bottom + 4);
    this.posicaoLeft.set(left);
  }

  onTeclaEscape(): void {
    this.fechar();
  }

  onBuscaChange(texto: string): void {
    this.busca.set(texto);
    if (!this.opcoes) this.valorChange.emit(texto);
  }

  opcoesFiltradas(): OpcaoFiltroColuna[] {
    if (!this.opcoes) return [];
    const termo = this.busca().trim().toLowerCase();
    if (!termo) return this.opcoes;
    const [primeira, ...resto] = this.opcoes;
    return [primeira, ...resto.filter(o => o.rotulo.toLowerCase().includes(termo))];
  }

  selecionar(valor: string): void {
    this.valorChange.emit(valor);
    this.fechar();
  }
}
