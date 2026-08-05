import { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    title: 'Entrar — mdblist hub',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/login/login').then((m) => m.Login),
  },
  {
    path: '',
    title: 'mdblist hub — suas listas',
    canActivate: [authGuard],
    loadComponent: () => import('./features/home/home').then((m) => m.Home),
  },
  {
    // `:type` uses TMDB vocabulary (`movie` | `tv`).
    path: 'title/:type/:id',
    title: 'Detalhes — mdblist hub',
    canActivate: [authGuard],
    loadComponent: () => import('./features/detail/detail').then((m) => m.Detail),
  },
  { path: '**', redirectTo: '' },
];
