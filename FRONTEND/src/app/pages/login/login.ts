import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Component({
  selector: 'app-login',
  imports: [CommonModule, FormsModule],
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export class Login implements OnInit {
  email = '';
  senha = '';
  manterConectado = false;
  carregando = signal(false);
  erro = signal('');

  constructor(
    private authService: AuthService,
    private router: Router,
    private route: ActivatedRoute,
  ) {}

  ngOnInit(): void {
    if (this.route.snapshot.queryParamMap.get('motivo') === 'sessao-expirada') {
      this.erro.set('Sua sessão expirou. Faça login de novo.');
      return;
    }
    if (this.authService.estaLogado()) {
      this.router.navigate(['/home']);
    }
  }

  onSubmit(): void {
    const email = this.email.trim();

    if (!email || !this.senha) {
      this.erro.set('Preencha email e senha.');
      return;
    }

    if (!EMAIL_REGEX.test(email)) {
      this.erro.set('Informe um email válido.');
      return;
    }

    this.carregando.set(true);
    this.erro.set('');

    this.authService.login(email, this.senha).subscribe({
      next: (resposta) => {
        this.authService.salvarSessao(resposta.usuario, resposta.token, this.manterConectado);
        this.carregando.set(false);
        this.router.navigate(['/home']);
      },
      error: (erro) => {
        this.carregando.set(false);
        this.erro.set(erro?.error?.erro || 'Erro ao fazer login. Tente novamente.');
      },
    });
  }
}
