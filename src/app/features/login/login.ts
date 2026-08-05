import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly key = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Toggles the key between dots and plain text. */
  protected readonly revealed = signal(false);

  protected onKey(event: Event): void {
    this.key.set((event.target as HTMLInputElement).value);
    this.error.set(null);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    const key = this.key().trim();
    if (!key || this.busy()) return;

    this.busy.set(true);
    this.error.set(null);

    this.auth.signIn(key).subscribe({
      next: () => {
        // `next` carries the page the guard bounced away from, if any.
        const next = this.route.snapshot.queryParamMap.get('next');
        this.router.navigateByUrl(next || '/');
      },
      error: (err: { status?: number }) => {
        this.busy.set(false);
        this.error.set(
          err?.status === 0
            ? 'Não foi possível falar com o mdblist. Verifique sua conexão.'
            : 'Chave inválida. Confira se copiou a chave inteira das preferências do mdblist.',
        );
      },
    });
  }
}
