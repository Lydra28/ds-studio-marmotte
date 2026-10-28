// Plugin DS-Studio, côté Figma. Écrit la dernière version acceptée de
// l'atelier (variables, composant Button) dans le fichier cible du projet, sur
// sa page dédiée seulement, et lit les composants du fichier pour les renvoyer
// à l'atelier. Aucun accès réseau ici : l'interface (ui.html) parle à
// l'atelier. Le transfert ne supprime ni ne renomme rien. Seule la remise à
// zéro, confirmée par Romain, supprime ce que DS-Studio a écrit (marqué).
figma.showUI(__html__, { width: 380, height: 620, themeColors: true });

// Collections, page et composants créés par DS-Studio portent cette marque.
// Ceux écrits avant la marque sont reconnus par leur nom, seulement si
// l'atelier a un reçu de transfert pour ce fichier (`known`).
const MARK = 'dsStudio';
const NAMES = ['Primitives', 'Tokens', 'Typography'];
const owned = (x) => x.getPluginData(MARK) === '1';
const mark = (x) => x.setPluginData(MARK, '1');

// Clé du fichier : fournie par Figma (plugin privé), sinon liée une fois par
// Romain depuis l'interface et gardée dans le document.
const LINK = 'dsStudioFileKey';
const fileInfo = () => ({
  key: figma.fileKey || figma.root.getPluginData(LINK) || null,
  native: !!figma.fileKey,
  name: figma.root.name,
});

figma.ui.onmessage = async (msg) => {
  try {
    if (msg.type === 'init')
      figma.ui.postMessage({
        type: 'init',
        settings: (await figma.clientStorage.getAsync('settings')) || {},
        file: fileInfo(),
      });
    else if (msg.type === 'save-settings') await figma.clientStorage.setAsync('settings', msg.settings);
    else if (msg.type === 'link-file') {
      if (figma.fileKey) throw new Error('Figma fournit déjà la clé de ce fichier : liaison inutile.');
      figma.root.setPluginData(LINK, msg.fileKey);
      figma.ui.postMessage({ type: 'file', file: fileInfo() });
    } else if (msg.type === 'transfer') figma.ui.postMessage({ type: 'transferred', report: await transfer(msg.payload, msg.known) });
    else if (msg.type === 'read-components') figma.ui.postMessage({ type: 'components', raw: await readComponents() });
    else if (msg.type === 'reset-plan') figma.ui.postMessage({ type: 'reset-plan', plan: await resetPlan(msg.target, msg.known) });
    else if (msg.type === 'reset') figma.ui.postMessage({ type: 'reset-done', removed: await reset(msg.target, msg.known) });
  } catch (e) {
    figma.ui.postMessage({ type: 'error', message: e && e.message ? e.message : String(e) });
  }
};

function guardFile(target, project) {
  const file = fileInfo();
  if (!file.key) throw new Error('Fichier non identifié : lie-le au projet. Rien n’a été modifié.');
  if (file.key !== target.fileKey)
    throw new Error(`Mauvais fichier : la cible de ${project} est ${target.fileKey}, ce fichier est ${file.key}. Rien n’a été modifié.`);
  if ((target.protectedPages || []).includes(target.page)) throw new Error('La page cible est protégée. Rien n’a été modifié.');
}

async function transfer(p, known) {
  guardFile(p.target, p.project);
  const report = { created: 0, updated: 0, extra: [], components: [], skipped: [] };

  // 0. Collections et page du même nom que DS-Studio n'a pas créées : on n'y écrit pas.
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  let page = figma.root.children.find((x) => x.name === p.target.page);
  const foreign = [
    ...p.collections.map((c) => collections.find((x) => x.name === c.name)).filter((x) => x && !owned(x) && !known).map((x) => `collection « ${x.name} »`),
    ...(page && !owned(page) && !known ? [`page « ${page.name} »`] : []),
  ];
  if (foreign.length)
    throw new Error(`Ce fichier a déjà ${foreign.join(', ')}, que DS-Studio n’a pas créée(s) : transfert refusé pour ne pas mélanger les deux DS. Rien n’a été écrit.`);

  // 1. Variables : collections et modes par nom, création ou mise à jour, alias en second passage.
  const locals = await figma.variables.getLocalVariablesAsync();
  const byName = {};
  const plan = [];
  for (const c of p.collections) {
    let col = collections.find((x) => x.name === c.name);
    if (!col) {
      col = figma.variables.createVariableCollection(c.name);
      col.renameMode(col.modes[0].modeId, c.modes[0]);
    }
    mark(col);
    const modeIds = {};
    for (const m of c.modes) {
      const found = col.modes.find((x) => x.name === m);
      modeIds[m] = found ? found.modeId : col.addMode(m);
    }
    if (c.name === 'Primitives') col.hiddenFromPublishing = true;
    const present = locals.filter((v) => v.variableCollectionId === col.id);
    const wanted = new Set(c.variables.map((v) => v.name));
    for (const v of present) if (!wanted.has(v.name)) report.extra.push(`${c.name}/${v.name}`);
    for (const spec of c.variables) {
      let v = present.find((x) => x.name === spec.name);
      if (v && v.resolvedType !== spec.type) {
        report.skipped.push(`${c.name}/${spec.name} : ${v.resolvedType} dans Figma, ${spec.type} attendu`);
        continue;
      }
      if (v) report.updated++;
      else {
        v = figma.variables.createVariable(spec.name, col, spec.type);
        report.created++;
      }
      v.scopes = spec.scopes;
      v.hiddenFromPublishing = spec.hidden;
      v.description = spec.description;
      byName[`${c.name}/${spec.name}`] = v;
      plan.push({ v, spec, modeIds });
    }
  }
  for (const { v, spec, modeIds } of plan)
    for (const [mode, value] of Object.entries(spec.values)) {
      if (value && typeof value === 'object' && 'alias' in value) {
        const target = byName[`${value.collection}/${value.alias}`];
        if (target) v.setValueForMode(modeIds[mode], figma.variables.createVariableAlias(target));
        else report.skipped.push(`${spec.name} : alias ${value.alias} introuvable`);
      } else v.setValueForMode(modeIds[mode], value);
    }

  // 2. Composants « figma » de la version, sur la page dédiée seulement.
  if (!page) {
    page = figma.createPage();
    page.name = p.target.page;
  }
  mark(page);
  await page.loadAsync();
  for (const doc of p.components || []) {
    if (doc.status !== 'figma') continue;
    if (doc.name === 'Button') await buildButton(page, doc, byName, p.font, report);
    else report.skipped.push(`${doc.name} : seul Button est construit par le plugin, fiche à documenter à la main`);
  }
  return report;
}

// Remise à zéro : uniquement ce que DS-Studio a écrit dans ce fichier (marque,
// ou nom connu si l'atelier a un reçu de transfert). Les autres pages et
// collections ne sont jamais lues pour suppression.
async function resetItems(target, known) {
  guardFile(target, 'ce projet');
  const collections = (await figma.variables.getLocalVariableCollectionsAsync()).filter(
    (c) => owned(c) || (known && NAMES.includes(c.name)),
  );
  const page = figma.root.children.find(owned) || (known ? figma.root.children.find((x) => x.name === target.page) : null) || null;
  if (page && (target.protectedPages || []).includes(page.name)) throw new Error('La page DS-Studio est protégée. Rien n’a été supprimé.');
  if (page) await page.loadAsync();
  return { collections, page };
}

async function resetPlan(target, known) {
  const { collections, page } = await resetItems(target, known);
  const components = page
    ? page.findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] }).filter((n) => !(n.type === 'COMPONENT' && n.parent.type === 'COMPONENT_SET'))
    : [];
  // Instances posées ailleurs : elles resteront, mais sans composant principal.
  let elsewhere = 0;
  for (const n of components)
    for (const c of n.type === 'COMPONENT_SET' ? n.children : [n])
      for (const i of await c.getInstancesAsync()) {
        let up = i.parent;
        while (up && up.type !== 'PAGE') up = up.parent;
        if (up !== page) elsewhere++;
      }
  return {
    collections: collections.map((c) => ({ name: c.name, variables: c.variableIds.length })),
    page: page ? { name: page.name, layers: page.children.length } : null,
    components: components.map((n) => n.name),
    elsewhere,
    onlyPage: !!page && figma.root.children.length === 1,
  };
}

async function reset(target, known) {
  const { collections, page } = await resetItems(target, known);
  const removed = { collections: [], variables: 0, page: null, components: [] };
  if (page) {
    removed.components = page
      .findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] })
      .filter((n) => !(n.type === 'COMPONENT' && n.parent.type === 'COMPONENT_SET'))
      .map((n) => n.name);
    // Une page seule ne peut pas être supprimée : on la vide.
    if (figma.root.children.length === 1) for (const n of [...page.children]) n.remove();
    else {
      if (figma.currentPage === page) await figma.setCurrentPageAsync(figma.root.children.find((x) => x !== page));
      removed.page = page.name;
      page.remove();
    }
  }
  for (const c of collections) {
    removed.collections.push(c.name);
    removed.variables += c.variableIds.length;
    c.remove();
  }
  return removed;
}

const token = (vars, name) =>
  vars['Tokens/' + name] || vars['Typography/' + name] || vars['Primitives/' + name] || null;
function paint(variable) {
  const base = { type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } };
  return variable ? figma.variables.setBoundVariableForPaint(base, 'color', variable) : base;
}
function bind(node, field, variable, fallback) {
  if (variable) node.setBoundVariable(field, variable);
  else node[field] = fallback;
}
// Police du projet si Figma la connaît, sinon Inter (le libellé le dit dans le rapport).
async function pickFont(family, report) {
  const fonts = await figma.listAvailableFontsAsync();
  for (const fam of [family, 'Inter'].filter(Boolean))
    for (const style of ['Semi Bold', 'SemiBold', 'Medium', 'Bold', 'Regular']) {
      const f = fonts.find((x) => x.fontName.family === fam && x.fontName.style === style);
      if (f) {
        if (fam !== family) report.skipped.push(`Police « ${family} » absente de Figma : Button en Inter`);
        await figma.loadFontAsync(f.fontName);
        return f.fontName;
      }
    }
  throw new Error('Aucune police utilisable (ni la police du projet, ni Inter).');
}

function styleButton(comp, variant, state, vars, font) {
  const T = (n) => token(vars, n);
  comp.layoutMode = 'HORIZONTAL';
  comp.primaryAxisSizingMode = 'AUTO';
  comp.counterAxisSizingMode = 'AUTO';
  comp.primaryAxisAlignItems = 'CENTER';
  comp.counterAxisAlignItems = 'CENTER';
  for (const f of ['paddingTop', 'paddingBottom']) bind(comp, f, T('space/sm'), 12);
  for (const f of ['paddingLeft', 'paddingRight']) bind(comp, f, T('space/md'), 16);
  for (const f of ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'])
    bind(comp, f, T('radius/control'), 8);
  const hover = state === 'hover';
  const fill =
    variant === 'primary'
      ? T(hover ? 'bg/brand-hover' : 'bg/brand')
      : variant === 'secondary'
        ? T(hover ? 'bg/surface-hover' : 'bg/surface')
        : hover
          ? T('bg/surface-hover')
          : null;
  comp.fills = fill ? [paint(fill)] : [];
  const stroke = state === 'focus' ? T('border/focus') : variant === 'secondary' ? T('border/default') : null;
  comp.strokes = stroke ? [paint(stroke)] : [];
  comp.strokeAlign = 'INSIDE';
  bind(comp, 'strokeWeight', T(state === 'focus' ? 'border-width/medium' : 'border-width/thin'), state === 'focus' ? 2 : 1);
  comp.opacity = state === 'disabled' ? 0.4 : 1;
  let text = comp.findChild((n) => n.type === 'TEXT');
  if (!text) {
    text = figma.createText();
    comp.appendChild(text);
  }
  text.fontName = font;
  if (!text.characters) text.characters = 'Action';
  text.fills = [paint(T(variant === 'primary' ? 'text/on-brand' : variant === 'ghost' ? 'text/brand' : 'text/primary'))];
  const size = T('font/size/label');
  if (size) text.setBoundVariable('fontSize', size);
  else text.fontSize = 14;
}

async function buildButton(page, doc, vars, family, report) {
  const props = doc.props || {};
  const list = (k, d) => (props[k] && props[k].length ? props[k] : d);
  const font = await pickFont(family, report);
  let set = page.children.find((n) => n.type === 'COMPONENT_SET' && n.name === 'Button');
  // Libellés existants : leur police actuelle doit être chargée avant toute modification.
  if (set)
    for (const t of set.findAll((n) => n.type === 'TEXT'))
      if (t.fontName !== figma.mixed) await figma.loadFontAsync(t.fontName);
  const existing = new Map(set ? set.children.map((c) => [c.name, c]) : []);
  const nodes = [];
  for (const variant of list('Variant', ['primary']))
    for (const state of list('State', ['default']))
      for (const size of list('Size', ['md'])) {
        const name = `Variant=${variant}, State=${state}, Size=${size}`;
        let comp = existing.get(name);
        if (!comp) {
          comp = figma.createComponent();
          comp.name = name;
          (set || page).appendChild(comp);
        }
        existing.delete(name);
        styleButton(comp, variant, state, vars, font);
        nodes.push(comp);
      }
  for (const name of existing.keys()) report.skipped.push(`Button : variante « ${name} » conservée, absente de la version`);
  if (!set) {
    const right = page.children.reduce((m, n) => Math.max(m, n.x + n.width), 0);
    set = figma.combineAsVariants(nodes, page);
    set.name = 'Button';
    set.x = right + 200;
    set.y = 0;
  }
  mark(set);
  // Grille : une colonne par état, une ligne par variante et taille.
  const states = list('State', ['default']).length;
  const w = Math.max(...nodes.map((n) => n.width)) + 24;
  const h = Math.max(...nodes.map((n) => n.height)) + 24;
  nodes.forEach((n, i) => {
    n.x = 24 + (i % states) * w;
    n.y = 24 + Math.floor(i / states) * h;
  });
  set.resizeWithoutConstraints(24 + states * w, 24 + Math.ceil(nodes.length / states) * h);
  set.description = [
    doc.role,
    doc.use && `Quand : ${doc.use}`,
    doc.avoid && `Éviter : ${doc.avoid}`,
    doc.a11y && `Accessibilité : ${doc.a11y}`,
  ]
    .filter(Boolean)
    .join('\n');
  report.components.push('Button');
}

// Lecture seule : composants de toutes les pages, propriétés et variables liées.
async function readComponents() {
  const names = new Map();
  const variableName = async (id) => {
    if (!names.has(id)) {
      const v = await figma.variables.getVariableByIdAsync(id);
      names.set(id, v ? v.name : null);
    }
    return names.get(id);
  };
  const out = [];
  for (const page of figma.root.children) {
    await page.loadAsync();
    const nodes = page
      .findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] })
      .filter((n) => !(n.type === 'COMPONENT' && n.parent && n.parent.type === 'COMPONENT_SET'));
    for (const n of nodes) {
      if (out.length >= 400) break;
      const props = {};
      const ignored = [];
      try {
        for (const [key, def] of Object.entries(n.componentPropertyDefinitions)) {
          const clean = key.replace(/#.*$/, '');
          if (def.type === 'VARIANT') props[clean] = def.variantOptions || [];
          else ignored.push(`${clean} (${def.type.toLowerCase()})`);
        }
      } catch (e) {
        ignored.push('propriétés illisibles');
      }
      const root = n.type === 'COMPONENT_SET' ? n.defaultVariant || n.children[0] : n;
      const ids = new Set();
      for (const node of [root, ...(root && 'findAll' in root ? root.findAll(() => true) : [])].slice(0, 400)) {
        for (const v of Object.values(node.boundVariables || {})) for (const a of [].concat(v)) if (a && a.id) ids.add(a.id);
        if ('fills' in node && Array.isArray(node.fills))
          for (const f of node.fills) if (f.boundVariables && f.boundVariables.color) ids.add(f.boundVariables.color.id);
      }
      const variables = [];
      for (const id of [...ids].slice(0, 60)) {
        const name = await variableName(id);
        if (name) variables.push(name);
      }
      out.push({ name: n.name, description: n.description || '', page: page.name, props, ignored, variables });
    }
  }
  return { source: `Figma ${figma.root.name}`.slice(0, 200), components: out };
}
