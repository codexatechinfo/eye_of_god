import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, ViewChild, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ColaboradoresService, PontoJornada, corDaUc, horaParaSegundos, segundosParaRelogio } from '../../../../services/colaboradores.service';

// Mesmas cores dos pontos já usadas no mapa/timeline (CORES_PONTO em
// mapa-bases.ts) — "a realizar" (cinza no corDaUc) vira azul, nosso token
// já estabelecido, não a cor genérica do protótipo original.
const CORES: Record<'verde' | 'cinza' | 'laranja' | 'vermelho', string> = {
  verde: '#1F9D62',
  cinza: '#006DFF',
  laranja: '#F28C28',
  vermelho: '#D64545',
};

// Teto do avanço por quadro de animação — sem isso, se a aba ficar em
// segundo plano por um tempo (o navegador congela requestAnimationFrame),
// o próximo quadro saltaria o dia inteiro de uma vez ao voltar.
const PASSO_MAX_SEG = 900;

@Component({
  selector: 'app-regua-tempo',
  imports: [CommonModule],
  templateUrl: './regua-tempo.html',
  styleUrl: './regua-tempo.css',
})
export class ReguaTempo implements AfterViewInit, OnDestroy {
  @ViewChild('canvas') private canvasRef!: ElementRef<HTMLCanvasElement>;

  readonly velocidades = [30, 60, 180, 600];

  private resizeObserver?: ResizeObserver;
  private arrastando = false;
  private laco = 0;
  private ultimoQuadro = 0;

  constructor(public colaboradoresService: ColaboradoresService) {
    // Redesenha sempre que o instante, a jornada ou os regimes sucessivos
    // (cor de reincidência) mudarem.
    effect(() => {
      this.colaboradoresService.reguaInstante();
      this.colaboradoresService.reguaExtremos();
      this.colaboradoresService.jornadaPorColaborador();
      this.colaboradoresService.regimeSucessivoPorUc();
      this.desenhar();
    });
  }

  ngAfterViewInit(): void {
    this.resizeObserver = new ResizeObserver(() => this.desenhar());
    this.resizeObserver.observe(this.canvasRef.nativeElement.parentElement!);
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    if (this.laco) cancelAnimationFrame(this.laco);
  }

  relogio(): string {
    const instante = this.colaboradoresService.reguaInstante();
    return instante === null ? '--:--' : segundosParaRelogio(instante);
  }

  relogioExtremo(segundos: number): string {
    return segundosParaRelogio(segundos);
  }

  mudarVelocidade(valor: string): void {
    this.colaboradoresService.reguaVelocidade.set(Number(valor) || 60);
  }

  irParaInicio(): void {
    const extremos = this.colaboradoresService.reguaExtremos();
    if (!extremos) return;
    this.colaboradoresService.reguaTocando.set(false);
    this.colaboradoresService.reguaInstante.set(extremos.ini);
  }

  irParaFim(): void {
    const extremos = this.colaboradoresService.reguaExtremos();
    if (!extremos) return;
    this.colaboradoresService.reguaTocando.set(false);
    this.colaboradoresService.reguaInstante.set(extremos.fim);
  }

  // Tocar a partir do fim rebobina — sem isso o botão liga e desliga no
  // mesmo quadro e o operador vê o ícone piscar sem a régua andar (mesmo
  // comportamento do protótipo, ver toca()/olho.html).
  alternarPlay(): void {
    const extremos = this.colaboradoresService.reguaExtremos();
    if (!extremos) return;
    const tocando = this.colaboradoresService.reguaTocando();
    const instante = this.colaboradoresService.reguaInstante();
    if (!tocando && instante !== null && instante >= extremos.fim - 1) {
      this.colaboradoresService.reguaInstante.set(extremos.ini);
    }
    this.colaboradoresService.reguaTocando.set(!tocando);
    this.ultimoQuadro = Date.now();
    if (!tocando && !this.laco) {
      this.laco = requestAnimationFrame(() => this.quadro());
    }
  }

  private quadro(): void {
    this.laco = 0;
    if (!this.colaboradoresService.reguaTocando()) return;
    const extremos = this.colaboradoresService.reguaExtremos();
    if (!extremos) {
      this.colaboradoresService.reguaTocando.set(false);
      return;
    }
    const agora = Date.now();
    const dt = (agora - this.ultimoQuadro) / 1000;
    this.ultimoQuadro = agora;
    const velocidade = this.colaboradoresService.reguaVelocidade();
    const passo = Math.min(dt * velocidade, PASSO_MAX_SEG);
    const atual = this.colaboradoresService.reguaInstante();
    let novo = (atual === null ? extremos.ini : atual) + passo;
    if (novo >= extremos.fim) {
      novo = extremos.fim;
      this.colaboradoresService.reguaTocando.set(false);
    }
    this.colaboradoresService.reguaInstante.set(novo);
    if (this.colaboradoresService.reguaTocando()) {
      this.laco = requestAnimationFrame(() => this.quadro());
    }
  }

  private pontosDoDia(): PontoJornada[] {
    const nome = this.colaboradoresService.colaboradorSelecionado();
    if (!nome) return [];
    return this.colaboradoresService.jornadaPorColaborador().get(nome)?.pontos ?? [];
  }

  aoPonteiroBaixo(evento: PointerEvent): void {
    this.arrastando = true;
    this.colaboradoresService.reguaTocando.set(false);
    this.moverCursor(evento.clientX);
  }

  @HostListener('document:pointermove', ['$event'])
  aoPonteiroMover(evento: PointerEvent): void {
    if (!this.arrastando) return;
    this.moverCursor(evento.clientX);
  }

  @HostListener('document:pointerup')
  aoPonteiroSoltar(): void {
    this.arrastando = false;
  }

  private moverCursor(clientX: number): void {
    const extremos = this.colaboradoresService.reguaExtremos();
    if (!extremos) return;
    const r = this.canvasRef.nativeElement.getBoundingClientRect();
    const span = extremos.fim - extremos.ini;
    const fracao = (clientX - r.left - 12) / Math.max(1, r.width - 24);
    const instante = Math.max(extremos.ini, Math.min(extremos.fim, extremos.ini + fracao * span));
    this.colaboradoresService.reguaInstante.set(instante);
  }

  private desenhar(): void {
    const canvasEl = this.canvasRef?.nativeElement;
    const extremos = this.colaboradoresService.reguaExtremos();
    const ctx = canvasEl?.getContext('2d');
    if (!ctx || !extremos) return;

    const r = canvasEl.parentElement!.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const larg = Math.max(1, Math.round(r.width));
    const alt = 52;
    // Mede o PAI e escreve altura fixa — ler a própria altura renderizada e
    // reescrevê-la dobra o canvas a cada repintura (mesma nota do protótipo).
    canvasEl.width = Math.round(larg * dpr);
    canvasEl.height = Math.round(alt * dpr);
    canvasEl.style.height = alt + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, larg, alt);

    const span = Math.max(1, extremos.fim - extremos.ini);
    const x = (s: number) => ((s - extremos.ini) / span) * (larg - 24) + 12;

    // eixo
    ctx.strokeStyle = '#E4E8EE';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(12, 34.5);
    ctx.lineTo(larg - 12, 34.5);
    ctx.stroke();

    // marcas de hora
    ctx.fillStyle = '#98A2B3';
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (let h = Math.ceil(extremos.ini / 3600) * 3600; h <= extremos.fim; h += 3600) {
      const hx = x(h);
      ctx.strokeStyle = '#EDF1F7';
      ctx.beginPath();
      ctx.moveTo(hx, 8);
      ctx.lineTo(hx, 34);
      ctx.stroke();
      ctx.fillStyle = '#98A2B3';
      ctx.fillText(segundosParaRelogio(h), hx - 12, 46);
    }

    // uma marca por ponto do dia, na cor do ponto (mesma regra corDaUc já
    // usada no mapa/timeline) — opaca até o instante atual, esmaecida
    // depois (ainda não "aconteceu" na régua).
    const regimes = this.colaboradoresService.regimeSucessivoPorUc();
    const instante = this.colaboradoresService.reguaInstante();
    for (const p of this.pontosDoDia()) {
      const s = horaParaSegundos(p.hora_import);
      if (s === null) continue;
      ctx.fillStyle = CORES[corDaUc(p, regimes)];
      ctx.globalAlpha = instante !== null && s > instante ? 0.25 : 1;
      const topo = p.tipo_intervalo === 'pausa' ? 12 : 18;
      const altura = p.tipo_intervalo === 'pausa' ? 22 : 16;
      ctx.fillRect(x(s) - 1, topo, 2, altura);
    }
    ctx.globalAlpha = 1;

    // o cursor
    if (instante !== null) {
      const cxp = x(instante);
      ctx.strokeStyle = '#0B2E59';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cxp, 6);
      ctx.lineTo(cxp, 36);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cxp, 6, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#0B2E59';
      ctx.fill();
    }
  }
}
