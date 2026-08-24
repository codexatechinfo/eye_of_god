import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface Usuario {
  id: number;
  nome: string;
  email: string;
  nivel: string;
}

export interface LoginResponse {
  sucesso: boolean;
  usuario: Usuario;
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private apiUrl = environment.apiUrl;

  constructor(private http: HttpClient) {}

  login(email: string, senha: string): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(`${this.apiUrl}/auth/login`, { email, senha });
  }

  salvarUsuario(usuario: Usuario, manterConectado: boolean): void {
    const dados = JSON.stringify(usuario);
    if (manterConectado) {
      localStorage.setItem('usuario', dados);
    } else {
      sessionStorage.setItem('usuario', dados);
    }
  }

  getUsuarioLogado(): Usuario | null {
    const dados = localStorage.getItem('usuario') || sessionStorage.getItem('usuario');
    return dados ? JSON.parse(dados) : null;
  }

  logout(): void {
    localStorage.removeItem('usuario');
    sessionStorage.removeItem('usuario');
  }

  estaLogado(): boolean {
    return this.getUsuarioLogado() !== null;
  }
}