import { Icon } from '../components/Icon';
import neraLogo from '../assets/logo_4x_1.png';

/**
 * NERA design-system component: **`Header`** — COMPONENT_SET `842:3470`,
 * page "📌 Shared components", `Property 1` VARIANT = **light | dark**.
 * (Two other catalog entries are called `Header`: `841:5074` on "✈️ CRMS Components" and
 * `1261:3619` on "📝 CLM Components". Both spell the prop `Mode` = Light | Dark, so the
 * instance's `Property 1=…` string picks `842:3470` unambiguously.)
 *
 * Both variants were pulled from Figma and are **byte-identical in the export**: the fill of both
 * is the variable `Neutrals/Neutral 0`, which resolves to #121319 in Dark and #ffffff in Light.
 * So the variant is not a second implementation — it is the `data-theme` attribute this Header
 * already writes on `<html>`, and `data-dt-variant` below reports which one is live.
 * Structure, VERIFIED: 912×60, row, `space-between`, padding [12,24,12,24];
 * left `Frame 3` gap 16 (Property 34 + "By" 14/Regular Neutrals/Neutral 800 + `logo@4x 1` 60×16);
 * right `Frame 1000003497` gap 16 (`notification-bing` 32, the 72×36 `light/dark` pill filled
 * Backgrounds/Tags with a 28×28 Primary/Primary half, then `User Avatar` 36 + `arrow-down` 16).
 *
 * Figma: `Header` (20173:137669) — 60 high, padding 12/24, fill Neutrals/Neutral 0.
 * Left: hamburger (Property_34) + "By" + the nera wordmark (logo@4x 1).
 * Right: notification-bing, the light/dark pill (Backgrounds/Tags, active half Primary/Primary),
 * the AK avatar (Warning/Warning Dark on profilePicture) and a chevron.
 */
export interface HeaderProps {
  theme: 'Light' | 'Dark';
  onThemeChange: (t: 'Light' | 'Dark') => void;
  onToggleSidebar: () => void;
}

export function Header({ theme, onThemeChange, onToggleSidebar }: HeaderProps) {
  return (
    <header
      className="flex h-[60px] shrink-0 items-center justify-between gap-8 bg-neutrals-neutral-0 ps-space-4 pe-space-4 pt-space-3-paren pb-space-3-paren"
      data-dt-node="20173:137669"
      data-dt-component="Header"
      data-dt-variant={`Property 1=${theme === 'Dark' ? 'dark' : 'light'}`}
    >
      <div className="flex items-center gap-space-3" data-dt-node="I20173:137669;45:1720">
        <button type="button" onClick={onToggleSidebar} aria-label="Toggle navigation" className="rounded-s p-0.5 text-text-main-titles hover:bg-neutrals-neutral-100">
          <Icon name="Property_34" size={24} data-dt-node="I20173:137669;45:1721" />
        </button>
        <span className="flex items-center gap-1" data-dt-node="I20173:137669;45:1728">
          <span className="font-roboto text-body-4 leading-5 tracking-[0.25px] text-neutrals-neutral-800" data-dt-node="I20173:137669;45:1729">By</span>
          <img src={neraLogo} alt="nera" width={60} height={16} className="h-4 w-[60px] object-contain" data-dt-node="I20173:137669;45:1730" />
        </span>
      </div>

      <div className="flex items-center justify-end gap-space-3" data-dt-node="I20173:137669;45:1731">
        <button type="button" aria-label="Notifications" className="relative rounded-s text-text-main-titles hover:opacity-80">
          <Icon name="notification-bing" size={32} preserveColor data-dt-node="I20173:137669;45:1732" />
        </button>

        <div
          className="flex h-9 items-center gap-space-2 rounded-full bg-backgrounds-tags ps-space-3-paren pe-1.5 pt-space-2 pb-space-2"
          role="group"
          aria-label="Colour theme"
          data-dt-node="I20173:137669;45:1740"
        >
          <button type="button" aria-label="Light theme" aria-pressed={theme === 'Light'} onClick={() => onThemeChange('Light')} className="flex h-[18px] w-[18px] items-center justify-center text-text-main-titles">
            <Icon name="sun" size={18} preserveColor data-dt-node="I20173:137669;45:1741" />
          </button>
          <button
            type="button"
            aria-label="Dark theme"
            aria-pressed={theme === 'Dark'}
            onClick={() => onThemeChange('Dark')}
            className={`flex h-7 w-7 items-center justify-center rounded-full ${theme === 'Dark' ? 'bg-primary-primary text-neutrals-neutral-0' : 'text-text-sub-titles'}`}
            data-dt-node="I20173:137669;45:1742"
          >
            <Icon name="Vector" size={18} data-dt-node="I20173:137669;45:1743" />
          </button>
        </div>

        <div className="flex items-center gap-space-3-paren" data-dt-node="I20173:137669;45:1744">
          {/* NERA `User Avatar` 1:1189, `Size=small, Type=Text` — the instance overrides the box
              from the set's 40 to 36, so it is rendered inline here rather than through
              components/UserAvatar.tsx (which carries the set's own four sizes). */}
          <span className="relative flex h-9 w-9 items-center justify-center" data-dt-node="I20173:137669;842:3338" data-dt-component="User Avatar" data-dt-variant="Size=small, Type=Text">
            <Icon name="profilePicture" size={36} preserveColor className="absolute inset-0" />
            <span className="relative text-body-4 font-medium leading-[18px] text-warning-warning-dark" data-dt-node="I20173:137669;842:3338;1:1219">AK</span>
          </span>
          <button type="button" aria-label="Account menu" className="text-text-main-titles">
            <Icon name="arrow-down-31f462" size={16} data-dt-node="I20173:137669;45:1747" />
          </button>
        </div>
      </div>
    </header>
  );
}
