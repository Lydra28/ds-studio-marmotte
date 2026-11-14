// Navigation mobile (lot 5 du site) : sous 800 px, le bouton « Menu »
// déplie la navigation en colonne. La classe `has-menu` n'est posée que si
// ce script tourne : sans lui, la navigation reste affichée en entier.
const header = document.querySelector<HTMLElement>('.top');
const toggle = header?.querySelector<HTMLButtonElement>('.menu-toggle');
if (header && toggle) {
  header.classList.add('has-menu');
  const set = (open: boolean) => {
    toggle.setAttribute('aria-expanded', String(open));
    header.classList.toggle('is-open', open);
  };
  toggle.addEventListener('click', () => set(toggle.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && header.classList.contains('is-open')) {
      set(false);
      toggle.focus();
    }
  });
}
