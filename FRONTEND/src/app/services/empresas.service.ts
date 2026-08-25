import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';

export interface Empresa {
  id: string;
  nome: string;
  ativa: boolean;
}

@Injectable({ providedIn: 'root' })
export class EmpresasService {
  private apiUrl = environment.apiUrl;

  empresas = signal<Empresa[]>([]);
  carregado = false;

  constructor(private http: HttpClient) {}

  carregar(): void {
    if (this.carregado) return;
    this.http.get<{ sucesso: boolean; empresas: Empresa[] }>(`${this.apiUrl}/empresas`).subscribe({
      next: resposta => {
        this.empresas.set(resposta.empresas);
        this.carregado = true;
      },
    });
  }
}
