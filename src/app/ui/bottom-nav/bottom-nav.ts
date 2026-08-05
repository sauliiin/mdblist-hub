import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { PlatformService } from '../../core/platform.service';

/**
 * The tab bar that makes the Android build read as an app rather than a page.
 *
 * A top nav is a website convention: on a phone it sits under the notch and out
 * of thumb reach. This takes over navigation below 860px and hides the topbar
 * links, so the same code serves the APK and a narrow browser window.
 */
@Component({
  selector: 'app-bottom-nav',
  imports: [RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './bottom-nav.html',
  styleUrl: './bottom-nav.scss',
  host: { '[hidden]': '!visible()' },
})
export class BottomNav {
  private readonly platform = inject(PlatformService);
  private readonly auth = inject(AuthService);

  /** Hidden in landscape: there the player wants every pixel of height. */
  protected visible = () =>
    this.platform.handset() && !!this.auth.user() && !this.platform.isLandscape();
}
