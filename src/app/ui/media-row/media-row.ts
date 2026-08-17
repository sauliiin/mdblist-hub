import {
  ChangeDetectionStrategy, Component, ElementRef, OnInit, computed, inject, input, output, signal,
  viewChild,
} from '@angular/core';
import { MdbItem, MdbList } from '../../core/models';
import { I18nPipe, I18nService } from '../../core/i18n.service';
import { MdblistService } from '../../core/mdblist.service';
import { MediaCard } from '../media-card/media-card';

const PAGE = 30;
/** Cap per row so a 483-item list does not build 483 DOM nodes. */
const MAX = 120;

@Component({
  selector: 'app-media-row',
  imports: [I18nPipe, MediaCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-row.html',
  styleUrl: './media-row.scss',
})
export class MediaRow implements OnInit {
  private readonly mdblist = inject(MdblistService);
  private readonly i18n = inject(I18nService);

  readonly list = input.required<MdbList>();
  /** Custom heading override if renamed. */
  readonly customHeading = input<string | null>(null);
  /** Show a numbered rank chip on each card (used for ranked lists). */
  readonly ranked = input(false);
  /** Reveals the rename/reorder/delete controls next to the heading. */
  readonly editMode = input(false);
  /** Disables the respective reorder arrow when the list is at that edge. */
  readonly atTop = input(false);
  readonly atBottom = input(false);

  readonly rename = output<string>();
  /** Confirmed via the trash button's own popover — see `confirmDelete`. */
  readonly delete = output<void>();
  readonly moveUp = output<void>();
  readonly moveDown = output<void>();

  protected readonly heading = computed(() => this.customHeading() || this.list().name);

  protected readonly renaming = signal(false);
  protected readonly draftName = signal('');
  /** The trash button's own confirm step — see `askDelete`. */
  protected readonly confirmingDelete = signal(false);

  private readonly track = viewChild<ElementRef<HTMLElement>>('track');

  protected readonly items = signal<MdbItem[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadingMore = signal(false);
  protected readonly atStart = signal(true);
  protected readonly atEnd = signal(false);

  protected readonly canLoadMore = computed(
    () => this.items().length < Math.min(this.list().items, MAX),
  );

  protected readonly kindLabel = computed(() => {
    const type = this.list().mediatype;
    if (type === 'movie') return this.i18n.t('Movies');
    if (type === 'show') return this.i18n.t('Shows');
    return this.i18n.t('Mixed');
  });

  // The component is only instantiated once its @defer block enters the
  // viewport, so fetching on init is already lazy. It has to be ngOnInit
  // rather than the constructor — required inputs are not set before then.
  ngOnInit(): void {
    this.fetch(0);
  }

  protected loadMore(): void {
    if (this.loadingMore() || !this.canLoadMore()) return;
    this.loadingMore.set(true);
    this.fetch(this.items().length);
  }

  private fetch(offset: number): void {
    this.mdblist.listItems(this.list().id, PAGE, offset).subscribe((items) => {
      this.items.update((current) => [...current, ...items]);
      this.loading.set(false);
      this.loadingMore.set(false);
      queueMicrotask(() => this.syncEdges());
    });
  }

  protected startRename(): void {
    this.draftName.set(this.heading());
    this.renaming.set(true);
  }

  protected confirmRename(): void {
    const name = this.draftName().trim();
    this.renaming.set(false);
    if (name && name !== this.heading()) this.rename.emit(name);
  }

  protected cancelRename(): void {
    this.renaming.set(false);
  }

  protected onDraftName(event: Event): void {
    this.draftName.set((event.target as HTMLInputElement).value);
  }

  /**
   * The trash icon doesn't hide the list right away — "excluir" reads as
   * permanent, and `toggleHidden` is really just a reversible local
   * preference (nothing is touched on mdblist itself), so a stray click
   * deserves a chance to back out before it fires.
   */
  protected askDelete(): void {
    this.confirmingDelete.set(true);
  }

  protected cancelDelete(): void {
    this.confirmingDelete.set(false);
  }

  protected confirmDelete(): void {
    this.confirmingDelete.set(false);
    this.delete.emit();
  }

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
    this.warmNextPage(el);
  }

  /** Offset já pré-aquecido, para disparar uma única vez por página. */
  private warmedOffset = -1;

  /*
   * Chegando perto do fim da faixa, a página seguinte é buscada em background
   * — só para aquecer o cache HTTP, sem adicionar cards. O passo continua
   * explícito no botão "Carregar mais" (decisão registrada no template), mas o
   * clique resolve do cache e vira instantâneo.
   */
  private warmNextPage(el: HTMLElement): void {
    const offset = this.items().length;
    if (!this.canLoadMore() || offset === 0 || this.warmedOffset === offset) return;
    if (el.scrollLeft + el.clientWidth < el.scrollWidth - el.clientWidth * 1.5) return;
    this.warmedOffset = offset;
    this.mdblist.listItems(this.list().id, PAGE, offset).subscribe();
  }
}
