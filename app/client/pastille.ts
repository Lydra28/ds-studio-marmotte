// Pastille, mascotte 3D de DS-Studio : un nuancier (pastille de couleur avec
// son étiquette) teinté par la couleur de marque du projet, en direct.
// Tout est généré en code, aucun modèle à charger. Chargé à la demande
// (import dynamique) : Three.js ne pèse pas sur le premier affichage.
//
//   const p = createPastille(conteneur, '#0BD939')
//   p.setColor('#2F6BFF')   // brouillon compris
//   p.setMood('idle' | 'thinking' | 'worried')
//   p.celebrate()           // saut de joie (repris de Poulpy), puis retour à l'humeur
//   p.dispose()
import {
  CanvasTexture,
  Clock,
  Color,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Shape,
  SphereGeometry,
  TorusGeometry,
  WebGLRenderer,
} from 'three';

export type Mood = 'idle' | 'thinking' | 'worried';
export type Pastille = {
  setColor: (hex: string) => void;
  setMood: (mood: Mood) => void;
  celebrate: () => void;
  dispose: () => void;
};

const W = 1.5; // largeur du nuancier
const H = 1.9;
const DEPTH = 0.26;
const BEVEL = 0.08;
const FRONT = DEPTH / 2 + BEVEL;

function roundedRect(w: number, h: number, r: number) {
  const s = new Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

// Étiquette du nuancier : fond clair arrondi et code hexadécimal.
function drawLabel(canvas: HTMLCanvasElement, hex: string) {
  const g = canvas.getContext('2d')!;
  const { width: w, height: h } = canvas;
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#F7F7F5';
  g.beginPath();
  g.roundRect(0, 0, w, h, 36);
  g.fill();
  g.fillStyle = '#1D1D1F';
  g.font = '700 66px ui-monospace, "Cascadia Mono", Consolas, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(hex.toUpperCase(), w / 2, h / 2 + 4);
}

export function createPastille(container: HTMLElement, color: string): Pastille {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';

  const scene = new Scene();
  const camera = new PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0.2, 5.6);
  camera.lookAt(0, 0, 0);
  scene.add(new HemisphereLight(0xffffff, 0x3a3a46, 2.4));
  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(2.5, 3, 4);
  scene.add(key);

  const disposables: { dispose: () => void }[] = [];
  const keep = <T extends { dispose: () => void }>(x: T) => (disposables.push(x), x);

  const root = new Group(); // saut, rebond
  const body = new Group(); // rotations, tremblement
  root.add(body);
  scene.add(root);

  const bodyGeo = keep(
    new ExtrudeGeometry(roundedRect(W, H, 0.28), {
      depth: DEPTH,
      bevelEnabled: true,
      bevelThickness: BEVEL,
      bevelSize: 0.07,
      bevelSegments: 4,
      curveSegments: 10,
    }),
  );
  bodyGeo.center();
  const bodyMat = keep(new MeshStandardMaterial({ color: new Color(color), roughness: 0.42, metalness: 0.05 }));
  body.add(new Mesh(bodyGeo, bodyMat));

  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 150;
  drawLabel(canvas, color);
  const labelTex = keep(new CanvasTexture(canvas));
  const label = new Mesh(
    keep(new PlaneGeometry(W - 0.22, (W - 0.22) * (150 / 512))),
    keep(new MeshBasicMaterial({ map: labelTex, transparent: true })),
  );
  label.position.set(0, -H / 2 + 0.3, FRONT + 0.002);
  body.add(label);

  // Visage : yeux (blanc + pupille), paupières par écrasement, bouche en arc.
  const white = keep(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }));
  const dark = keep(new MeshStandardMaterial({ color: 0x1d1d22, roughness: 0.25 }));
  const eyeGeo = keep(new SphereGeometry(0.17, 24, 16));
  const pupilGeo = keep(new SphereGeometry(0.085, 20, 12));
  const eyes = [-0.32, 0.32].map((x) => {
    const eye = new Group();
    eye.position.set(x, 0.38, FRONT);
    const ball = new Mesh(eyeGeo, white);
    ball.scale.z = 0.55;
    const pupil = new Mesh(pupilGeo, dark);
    pupil.position.z = 0.07;
    eye.add(ball, pupil);
    body.add(eye);
    return { eye, pupil };
  });
  const mouth = new Mesh(keep(new TorusGeometry(0.15, 0.035, 10, 28, Math.PI)), dark);
  mouth.position.set(0, 0.02, FRONT + 0.01);
  body.add(mouth);

  // Bulles de réflexion (reprises de Poulpy) : en diagonale au-dessus de la
  // tête, visibles quand la pastille est pensive.
  const bubbles = (
    [
      [0.62, 0.98, 0.3, 0.055],
      [0.82, 1.18, 0.25, 0.08],
      [1.04, 1.42, 0.2, 0.11],
    ] as const
  ).map(([x, y, z, r]) => {
    const b = new Mesh(
      keep(new SphereGeometry(r, 16, 12)),
      keep(new MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0, roughness: 0.4 })),
    );
    b.position.set(x, y, z);
    root.add(b);
    return b;
  });

  // Ombre portée, plus petite quand la pastille saute.
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = shadowCanvas.height = 128;
  const sg = shadowCanvas.getContext('2d')!;
  const grad = sg.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(0,0,0,0.45)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  sg.fillStyle = grad;
  sg.fillRect(0, 0, 128, 128);
  const shadow = new Mesh(
    keep(new PlaneGeometry(1.7, 0.5)),
    keep(new MeshBasicMaterial({ map: keep(new CanvasTexture(shadowCanvas)), transparent: true, depthWrite: false })),
  );
  shadow.position.set(0, -H / 2 - 0.28, 0);
  scene.add(shadow);

  // Le regard suit le pointeur dans la page.
  const look = { x: 0, y: 0 };
  const target = { x: 0, y: 0 };
  const onPointer = (e: PointerEvent) => {
    const r = container.getBoundingClientRect();
    target.x = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / 400));
    target.y = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / 400));
  };
  addEventListener('pointermove', onPointer, { passive: true });

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = container;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = `${w}px`;
    renderer.domElement.style.height = `${h}px`;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  let mood: Mood = 'idle';
  let party = -1; // début du saut de joie, -1 si aucun
  let last = 0;
  let nextBlink = 1.5;
  let nextShiver = 1;
  const clock = new Clock();
  let frame = 0;
  const tick = () => {
    frame = requestAnimationFrame(tick);
    const t = clock.getElapsedTime();
    const dt = Math.min(0.1, t - last);
    last = t;
    const motion = reduced ? 0.25 : 1;
    // Pensive : yeux levés. Inquiète : suit le pointeur, regard un peu baissé.
    const lookAt =
      mood === 'thinking'
        ? { x: 0.6, y: -0.8 }
        : mood === 'worried'
          ? { x: target.x, y: Math.min(1, target.y + 0.3) }
          : target;
    look.x += (lookAt.x - look.x) * 0.08;
    look.y += (lookAt.y - look.y) * 0.08;

    let y = Math.sin(t * (mood === 'thinking' ? 2.6 : 1.6)) * 0.06 * motion;
    let tilt = mood === 'thinking' ? Math.sin(t * 1.8) * 0.1 * motion : 0;
    if (mood === 'worried' && !reduced) {
      if (t > nextShiver) nextShiver = t + 2.4;
      const s = t - (nextShiver - 2.4);
      if (s < 0.45) tilt += Math.sin(s * 60) * 0.05 * (1 - s / 0.45);
    }
    // Joie (reprise de Poulpy) : saut de 1,7 s, yeux plissés, grand sourire, frétillement.
    let grin = 1;
    const joy = party >= 0;
    if (joy) {
      const p = (t - party) / 1.7;
      if (p >= 1) party = -1;
      else {
        if (!reduced) y += Math.pow(Math.sin(Math.min(p * 1.25, 1) * Math.PI), 0.8) * 0.85;
        tilt += Math.sin(t * 18) * 0.06 * motion;
        grin = 1.35;
      }
    }
    root.position.y = y;
    body.rotation.set(look.y * 0.18, look.x * 0.32 + Math.sin(t * 0.7) * 0.12 * motion, tilt);
    shadow.scale.setScalar(1 - y * 0.6);

    for (const { pupil } of eyes) pupil.position.set(look.x * 0.06, -look.y * 0.06, 0.07);
    // Clignement : paupières fermées 120 ms à intervalle aléatoire.
    if (t > nextBlink + 0.12) nextBlink = t + 2.2 + Math.random() * 2.6;
    const closed = t > nextBlink && t < nextBlink + 0.12;
    for (const { eye } of eyes) eye.scale.y = closed ? 0.12 : party >= 0 ? 0.2 : mood === 'worried' ? 0.85 : 1;

    // Bouche : sourire (arc vers le bas), moue inquiète (arc vers le haut), « o » pensif.
    const happy = party >= 0;
    mouth.rotation.z = mood === 'worried' && !happy ? 0 : Math.PI;
    mouth.position.y = mood === 'worried' && !happy ? -0.12 : 0.02;
    const o = mood === 'thinking' && !happy;
    mouth.scale.set(o ? 0.45 : grin, o ? 0.45 : grin, 1);

    const k = 1 - Math.exp(-5 * dt);
    bubbles.forEach((b, i) => {
      b.scale.setScalar(0.85 + Math.sin(t * 2.2 - i * 0.9) * 0.15);
      b.material.opacity += ((mood === 'thinking' && !happy ? 0.85 : 0) - b.material.opacity) * k;
      b.visible = b.material.opacity > 0.02;
    });
    renderer.render(scene, camera);
  };
  tick();

  return {
    setColor(hex) {
      bodyMat.color.set(hex);
      drawLabel(canvas, hex);
      labelTex.needsUpdate = true;
    },
    setMood(next) {
      mood = next;
    },
    celebrate() {
      party = clock.getElapsedTime();
    },
    dispose() {
      cancelAnimationFrame(frame);
      removeEventListener('pointermove', onPointer);
      observer.disconnect();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
