import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    title: 'mdblist hub — suas listas',
    loadComponent: () => import('./features/home/home').then((m) => m.Home),
  },
  {
    // `:type` uses TMDB vocabulary (`movie` | `tv`).
    path: 'title/:type/:id',
    title: 'Detalhes — mdblist hub',
    loadComponent: () => import('./features/detail/detail').then((m) => m.Detail),
  },
  { path: '**', redirectTo: '' },
];
