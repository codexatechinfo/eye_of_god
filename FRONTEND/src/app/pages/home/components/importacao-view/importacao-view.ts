import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ImportacaoService, ResultadoImportacao } from '../../../../services/importacao.service';
import { EmpresasService } from '../../../../services/empresas.service';
import { AuthService } from '../../../../services/auth.service';

@Component({
  selector: 'app-importacao-view',
  imports: [CommonModule, FormsModule],
  templateUrl: './importacao-view.html',
  styleUrl: './importacao-view.css',
})
export class ImportacaoView implements OnInit {
  tabelaSelecionada = signal('');
  empresaSelecionada = signal('');
  arquivoSelecionado = signal<File | null>(null);
  enviando = signal(false);
  resultado = signal<ResultadoImportacao | null>(null);
  erro = signal('');

  constructor(
    public importacaoService: ImportacaoService,
    public empresasService: EmpresasService,
    private authService: AuthService,
  ) {}

  ngOnInit(): void {
    this.importacaoService.carregarTabelas();
    if (this.ehRoot()) {
      this.empresasService.carregar();
    }
  }

  ehRoot(): boolean {
    return this.authService.getUsuarioLogado()?.nivel === 'ROOT';
  }

  // ROOT não tem empresa própria — só precisa escolher quando a tabela não é
  // compartilhada (hoje nenhuma é, ver ADR 0009, mas o flag continua vindo do
  // backend em vez de fixo aqui, caso surja tabela compartilhada de novo).
  precisaEscolherEmpresa(): boolean {
    const tabela = this.tabelaAtual();
    return this.ehRoot() && !!tabela && !tabela.compartilhada;
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
    if (this.precisaEscolherEmpresa() && !this.empresaSelecionada()) {
      this.erro.set('Escolha a empresa que vai receber esse import.');
      return;
    }

    this.enviando.set(true);
    this.erro.set('');
    this.resultado.set(null);

    this.importacaoService.importar(tabela, arquivo, this.precisaEscolherEmpresa() ? this.empresaSelecionada() : null).subscribe({
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
