import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
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
  ) {}

  ngOnInit(): void {
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
        this.authService.salvarUsuario(resposta.usuario, this.manterConectado);
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
