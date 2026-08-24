import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';

export interface TabelaImportavel {
  tabela: string;
  modo: 'substituir' | 'upsert';
  chave: string[] | null;
  compartilhada: boolean;
  colunas: string[];
}

export interface ResultadoImportacao {
  sucesso: boolean;
  linhasProcessadas: number;
  modo: string;
  tabela: string;
  compartilhada?: boolean;
}

@Injectable({ providedIn: 'root' })
export class ImportacaoService {
  private apiUrl = environment.apiUrl;

  tabelas = signal<TabelaImportavel[]>([]);
  carregandoTabelas = signal(false);

  constructor(private http: HttpClient) {}

  carregarTabelas(): void {
    this.carregandoTabelas.set(true);
    this.http.get<{ sucesso: boolean; tabelas: TabelaImportavel[] }>(`${this.apiUrl}/importacao`).subscribe({
      next: resposta => {
        this.tabelas.set(resposta.tabelas);
        this.carregandoTabelas.set(false);
      },
      error: () => this.carregandoTabelas.set(false),
    });
  }

  importar(tabela: string, arquivo: File) {
    const formData = new FormData();
    formData.append('arquivo', arquivo);
    return this.http.post<ResultadoImportacao>(`${this.apiUrl}/importacao/${tabela}`, formData);
  }
}
