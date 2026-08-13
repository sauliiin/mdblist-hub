import { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    title: 'Entrar — Open Stream',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/login/login').then((m) => m.Login),
  },
  {
    path: '',
    title: 'Open Stream — suas listas',
    canActivate: [authGuard],
    loadComponent: () => import('./features/home/home').then((m) => m.Home),
  },
  {
    // `:type` uses TMDB vocabulary (`movie` | `tv`).
    path: 'title/:type/:id',
    title: 'Detalhes — Open Stream',
    canActivate: [authGuard],
    loadComponent: () => import('./features/detail/detail').then((m) => m.Detail),
  },
  {
    // Same `:type`/`:id` pair as the detail page; `?season=&episode=` picks the
    // episode for a show, so a given episode is a shareable URL.
    path: 'watch/:type/:id',
    title: 'Assistir — Open Stream',
    canActivate: [authGuard],
    loadComponent: () => import('./features/player/player').then((m) => m.Player),
  },
  {
    path: 'addons',
    title: 'Addons — Open Stream',
    canActivate: [authGuard],
    loadComponent: () => import('./features/addons/addons').then((m) => m.Addons),
  },
  { path: '**', redirectTo: '' },
];
