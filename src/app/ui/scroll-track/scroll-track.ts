import {
  ChangeDetectionStrategy, Component, ElementRef, signal, viewChild,
} from '@angular/core';
import { I18nPipe } from '../../core/i18n.service';

/**
 * Wraps a horizontally-scrolling `<ng-content>` with the same nudging
 * prev/next arrows used on the home rows (`media-row`), so any carousel can
 * opt into them by projecting its content here instead of a bare scroll div.
 */
@Component({
  selector: 'app-scroll-track',
  imports: [I18nPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './scroll-track.html',
  styleUrl: './scroll-track.scss',
})
export class ScrollTrack {
  private readonly track = viewChild<ElementRef<HTMLElement>>('track');

  protected readonly atStart = signal(true);
  protected readonly atEnd = signal(false);

  protected scrollBy(direction: -1 | 1): void {
    const el = this.track()?.nativeElement;
    if (!el) return;
    el.scrollBy({ left: direction * el.clientWidth * 0.85, behavior: 'smooth' });
  }

  protected syncEdges(): void {
    const el = this.track()?.nativeElement;
    if (!el) return;
    this.atStart.set(el.scrollLeft < 12);
    this.atEnd.set(el.scrollLeft + el.clientWidth >= el.scrollWidth - 12);
  }
}
