import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { environment } from '../../../environments/environment';
import { FiltrosColaboradores } from './components/filtros-colaboradores/filtros-colaboradores';
import { ListaColaboradores } from './components/lista-colaboradores/lista-colaboradores';
import { LivroDetalhe } from './components/livro-detalhe/livro-detalhe';
import { MapaBases } from './components/mapa-bases/mapa-bases';
import { MonitoramentoView } from './components/monitoramento-view/monitoramento-view';
import { ImportacaoView } from './components/importacao-view/importacao-view';
import { ColaboradoresService } from '../../services/colaboradores.service';

type StatusColeta = 'coletando' | 'parada' | 'offline' | null;
// 'monitoramento' é a aba Trilho (rótulo mudou, chave não — ver ADR 0006).
// 'livros' é Monitoramento de Livros (leitura/releitura); 'massivas' é a
// aba nova, dedicada só a massiva (ver ADR 0010).
type Aba = 'monitoramento' | 'livros' | 'massivas' | 'importacao';

interface StatusJob {
  ativo: boolean;
  emAndamento: boolean;
}

interface StatusColetaResponse {
  sucesso: boolean;
  coletaAcomp: StatusJob;
  coletaMassivas: StatusJob;
  ultimoImport: { dataImport: string; horaImport: string } | null;
}

@Component({
  selector: 'app-home',
  imports: [CommonModule, FiltrosColaboradores, ListaColaboradores, LivroDetalhe, MapaBases, MonitoramentoView, ImportacaoView],
  templateUrl: './home.html',
  styleUrl: './home.css',
})
export class Home implements OnInit, OnDestroy {
  statusColeta = signal<StatusColeta>(null);
  ultimoImport = signal<{ dataImport: string; horaImport: string } | null>(null);
  abaAtiva = signal<Aba>('monitoramento');

  // Controla a criação (lazy) de app-monitoramento-view — depois de aberta uma
  // vez, [hidden] no template mantém a instância viva (e o filtro dela
  // junto) em vez de destruir ao trocar de aba. Ver home.html.
  jaAbriuLivros = signal(false);
  jaAbriuMassivas = signal(false);

  private intervaloId?: ReturnType<typeof setInterval>;
  private readonly INTERVALO_VERIFICACAO_MS = 30000;

  constructor(
    private http: HttpClient,
    private authService: AuthService,
    private router: Router,
    // Público — o alerta de "afastado com atividade" é global (não preso à
    // aba Trilho, ver home.html), consumido direto do template daqui.
    public colaboradoresService: ColaboradoresService,
  ) {}

  ngOnInit(): void {
    this.verificarStatusColeta();
    this.intervaloId = setInterval(() => this.verificarStatusColeta(), this.INTERVALO_VERIFICACAO_MS);
  }

  ngOnDestroy(): void {
    if (this.intervaloId) {
      clearInterval(this.intervaloId);
    }
  }

  verificarStatusColeta(): void {
    this.http.get<StatusColetaResponse>(`${environment.apiUrl}/coleta/status`).subscribe({
      next: resposta => {
        const acomp = resposta.coletaAcomp;
        this.statusColeta.set(acomp.ativo ? 'coletando' : 'parada');
        this.ultimoImport.set(resposta.ultimoImport);
      },
      error: () => {
        this.statusColeta.set('offline');
      },
    });
  }

  selecionarAba(aba: Aba): void {
    this.abaAtiva.set(aba);
    if (aba === 'livros') this.jaAbriuLivros.set(true);
    if (aba === 'massivas') this.jaAbriuMassivas.set(true);
  }

  podeImportar(): boolean {
    const nivel = this.authService.getUsuarioLogado()?.nivel;
    return nivel === 'ADMINISTRADOR' || nivel === 'ROOT';
  }

  logout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
  }
}
