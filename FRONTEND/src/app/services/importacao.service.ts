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

  // Baixa um .xlsx de exemplo (cabeçalho + até 1 linha real) — mesma tabela
  // escolhida no seletor de import (uma aba só); sem `tabela`, baixa todas
  // as tabelas importáveis de uma vez (uma aba por tabela).
  baixarExemplo(tabela?: string | null): void {
    this.baixandoExemplo.set(true);
    this.erroExemplo.set(null);
    const url = tabela
      ? `${this.apiUrl}/importacao/exemplo?tabela=${encodeURIComponent(tabela)}`
      : `${this.apiUrl}/importacao/exemplo`;
    this.http.get(url, { responseType: 'blob' }).subscribe({
      next: blob => {
        const objectUrl = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = tabela ? `exemplo_${tabela}.xlsx` : 'exemplo_importacao.xlsx';
        link.click();
        window.URL.revokeObjectURL(objectUrl);
        this.baixandoExemplo.set(false);
      },
      error: () => {
        this.erroExemplo.set('Não foi possível baixar o exemplo.');
        this.baixandoExemplo.set(false);
      },
    });
  }
}
