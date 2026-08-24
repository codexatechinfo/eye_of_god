import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ImportacaoService, ResultadoImportacao } from '../../../../services/importacao.service';

@Component({
  selector: 'app-importacao-view',
  imports: [CommonModule, FormsModule],
  templateUrl: './importacao-view.html',
  styleUrl: './importacao-view.css',
})
export class ImportacaoView implements OnInit {
  tabelaSelecionada = signal('');
  arquivoSelecionado = signal<File | null>(null);
  enviando = signal(false);
  resultado = signal<ResultadoImportacao | null>(null);
  erro = signal('');

  constructor(public importacaoService: ImportacaoService) {}

  ngOnInit(): void {
    this.importacaoService.carregarTabelas();
  }

  onArquivoChange(evento: Event): void {
    const input = evento.target as HTMLInputElement;
    this.arquivoSelecionado.set(input.files?.[0] ?? null);
    this.resultado.set(null);
    this.erro.set('');
  }

  tabelaAtual() {
    return this.importacaoService.tabelas().find(t => t.tabela === this.tabelaSelecionada()) ?? null;
  }

  importar(): void {
    const tabela = this.tabelaSelecionada();
    const arquivo = this.arquivoSelecionado();
    if (!tabela || !arquivo) {
      this.erro.set('Escolha a tabela e o arquivo .xlsx.');
      return;
    }

    this.enviando.set(true);
    this.erro.set('');
    this.resultado.set(null);

    this.importacaoService.importar(tabela, arquivo).subscribe({
      next: resposta => {
        this.resultado.set(resposta);
        this.enviando.set(false);
        this.arquivoSelecionado.set(null);
      },
      error: erro => {
        this.erro.set(erro?.error?.erro || 'Erro ao importar o arquivo. Tente novamente.');
        this.enviando.set(false);
      },
    });
  }
}
