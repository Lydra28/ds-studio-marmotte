// Motion du haut de page : en pause quand il sort de l'écran ou que l'onglet
// est masqué (boucle non essentielle, cadrage du site, lot 1). Sans ce
// script, l'animation tourne : le contenu reste visible.
const motion = document.querySelector<HTMLElement>('.hm');
if (motion && 'IntersectionObserver' in window) {
  let visible = true;
  const apply = () => motion.classList.toggle('is-paused', !visible || document.hidden);
  new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    apply();
  }).observe(motion);
  document.addEventListener('visibilitychange', apply);
}
