import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * Blocks the app until a stored key has been checked against mdblist. Waiting
 * here means every component below can read `AuthService.user()` straight
 * away, without racing the `/user` call.
 */
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return auth
    .restore()
    .pipe(
      map(
        (ok) =>
          ok || router.createUrlTree(['/login'], { queryParams: { next: state.url } }),
      ),
    );
};

/** Keeps an already signed-in visitor away from the login screen. */
export const guestGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return auth.restore().pipe(map((ok) => !ok || router.createUrlTree(['/'])));
};
