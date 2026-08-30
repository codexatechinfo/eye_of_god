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
  baixandoExemplo = signal(false);
  erroExemplo = signal<string | null>(null);

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

  importar(tabela: string, arquivo: File, empresaId?: string | null) {
    const formData = new FormData();
    formData.append('arquivo', arquivo);
    const url = empresaId
      ? `${this.apiUrl}/importacao/${tabela}?empresaId=${encodeURIComponent(empresaId)}`
      : `${this.apiUrl}/importacao/${tabela}`;
    return this.http.post<ResultadoImportacao>(url, formData);
  }

  // Baixa um .xlsx com uma aba por tabela importável, cabeçalho + até 1
  // linha real de exemplo — referência de formato pra preparar planilhas.
  baixarExemplo(): void {
    this.baixandoExemplo.set(true);
    this.erroExemplo.set(null);
    this.http.get(`${this.apiUrl}/importacao/exemplo`, { responseType: 'blob' }).subscribe({
      next: blob => {
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'exemplo_importacao.xlsx';
        link.click();
        window.URL.revokeObjectURL(url);
        this.baixandoExemplo.set(false);
      },
      error: () => {
        this.erroExemplo.set('Não foi possível baixar o exemplo.');
        this.baixandoExemplo.set(false);
      },
    });
  }
}
