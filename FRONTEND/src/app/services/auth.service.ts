import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export type Nivel = 'ROOT' | 'ADMINISTRADOR' | 'SUPERVISOR' | 'USUARIO';

export interface Usuario {
  id: number;
  nome: string;
  email: string;
  nivel: Nivel;
  empresaId: string | null;
}

export interface LoginResponse {
  sucesso: boolean;
  usuario: Usuario;
  token: string;
}

const CHAVE_USUARIO = 'usuario';
const CHAVE_TOKEN = 'token';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private apiUrl = environment.apiUrl;

  constructor(private http: HttpClient) {}

  login(email: string, senha: string): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(`${this.apiUrl}/auth/login`, { email, senha });
  }

  salvarSessao(usuario: Usuario, token: string, manterConectado: boolean): void {
    const armazenamento = manterConectado ? localStorage : sessionStorage;
    armazenamento.setItem(CHAVE_USUARIO, JSON.stringify(usuario));
    armazenamento.setItem(CHAVE_TOKEN, token);
  }

  getUsuarioLogado(): Usuario | null {
    const dados = localStorage.getItem(CHAVE_USUARIO) || sessionStorage.getItem(CHAVE_USUARIO);
    return dados ? JSON.parse(dados) : null;
  }

  getToken(): string | null {
    return localStorage.getItem(CHAVE_TOKEN) || sessionStorage.getItem(CHAVE_TOKEN);
  }

  logout(): void {
    localStorage.removeItem(CHAVE_USUARIO);
    localStorage.removeItem(CHAVE_TOKEN);
    sessionStorage.removeItem(CHAVE_USUARIO);
    sessionStorage.removeItem(CHAVE_TOKEN);
  }

  estaLogado(): boolean {
    return this.getToken() !== null;
  }
}
