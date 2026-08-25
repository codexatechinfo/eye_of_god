import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const router = inject(Router);
  const token = authService.getToken();

  const requisicao = token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;

  return next(requisicao).pipe(
    catchError((erro: unknown) => {
      // 401/403 numa rota autenticada é sessão vencida/token inválido, não a API
      // fora do ar — sem isso o app mostrava "offline" de forma enganosa e
      // ficava preso em vez de mandar logar de novo.
      if (erro instanceof HttpErrorResponse && (erro.status === 401 || erro.status === 403) && token) {
        authService.logout();
        router.navigate(['/login'], { queryParams: { motivo: 'sessao-expirada' } });
      }
      return throwError(() => erro);
    }),
  );
};
