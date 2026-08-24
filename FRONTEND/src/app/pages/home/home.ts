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
import { MassivasView } from './components/massivas-view/massivas-view';

type StatusColeta = 'coletando' | 'parada' | 'fora-do-horario' | 'offline' | null;
type Aba = 'monitoramento' | 'massivas';

interface StatusJob {
  ativo: boolean;
  emAndamento: boolean;
  dentroDaJanela: boolean;
}

interface StatusColetaResponse {
  sucesso: boolean;
  coletaAcomp: StatusJob;
  coletaMassivas: StatusJob;
  ultimoImport: { dataImport: string; horaImport: string } | null;
}

@Component({
  selector: 'app-home',
  imports: [CommonModule, FiltrosColaboradores, ListaColaboradores, LivroDetalhe, MapaBases, MassivasView],
  templateUrl: './home.html',
  styleUrl: './home.css',
})
export class Home implements OnInit, OnDestroy {
  statusColeta = signal<StatusColeta>(null);
  ultimoImport = signal<{ dataImport: string; horaImport: string } | null>(null);
  abaAtiva = signal<Aba>('monitoramento');

  private intervaloId?: ReturnType<typeof setInterval>;
  private readonly INTERVALO_VERIFICACAO_MS = 30000;

  constructor(
    private http: HttpClient,
    private authService: AuthService,
    private router: Router,
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
        if (acomp.dentroDaJanela && acomp.ativo) {
          this.statusColeta.set('coletando');
        } else if (acomp.dentroDaJanela && !acomp.ativo) {
          this.statusColeta.set('parada');
        } else {
          this.statusColeta.set('fora-do-horario');
        }
        this.ultimoImport.set(resposta.ultimoImport);
      },
      error: () => {
        this.statusColeta.set('offline');
      },
    });
  }

  selecionarAba(aba: Aba): void {
    this.abaAtiva.set(aba);
  }

  logout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
  }
}
