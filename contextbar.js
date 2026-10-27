// Floating toolbar above the current selection (Miro-style).
import { h } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { menu, popover, closeFloating } from '../core/ui.js';
import { clamp, kbd } from '../core/util.js';
import { SWATCHES, FILLS, STICKY_FILLS, swatchStyle } from './palette.js';
import { SHAPES, rectOf, unionRects } from './geometry.js';

const SIZES = [12, 14, 16, 18, 22, 28, 36, 48, 64, 96, 144];
const SHAPE_NAMES = { rect: 'Rectangle', round: 'Rounded', ellipse: 'Ellipse', triangle: 'Triangle', diamond: 'Diamond', hexagon: 'Hexagon', parallelogram: 'Parallelogram', star: 'Star', arrowblock: 'Arrow', pill: 'Pill' };

function btn(ic, label, onClick, { on = false, cls, text } = {}) {
  return h('button', {
    class: ['ctx-btn', on && 'is-on', cls], type: 'button', 'aria-label': label, 'data-tip': kbd(label), 'aria-pressed': on ? 'true' : null,
    onmousedown: (e) => e.preventDefault(),
    onclick: (e) => onClick(e.currentTarget),
  }, typeof ic === 'string' ? icon(ic, 18) : ic, text ? h('span', { class: 'ctx-btn-text' }, text) : null);
}

function swatchDot(color, ring = false) {
  return h('span', { class: ['ctx-swatch', ring && 'is-ring', color === 'none' && 'is-none'], style: ring ? { borderColor: color === 'none' ? '' : swatchStyle(color).background } : swatchStyle(color) });
}

function colorGrid(list, current, onPick) {
  const grid = h('div', { class: 'pal-grid', role: 'listbox' });
  const paint = (cur) => {
    grid.replaceChildren(...list.map((c) => h('button', {
      class: ['pal-sw', c.id === cur && 'is-on', c.id === 'none' && 'is-none', c.id === 'auto' && 'is-auto'],
      type: 'button', role: 'option', 'aria-selected': String(c.id === cur), 'aria-label': c.name, title: c.name,
      style: c.id === 'none' ? null : swatchStyle(c.id),
      onclick: () => { onPick(c.id); paint(c.id); },
    })));
  };
  paint(current);
  return grid;
}

function row(label, ...kids) {
  return h('div', { class: 'pop-row' }, h('div', { class: 'pop-label' }, label), h('div', { class: 'pop-items' }, kids));
}

function optionRow(options, current, onPick) {
  const wrap = h('div', { class: 'seg seg-sm' });
  const paint = (cur) => wrap.replaceChildren(...options.map((o) => h('button', {
    type: 'button', class: o.value === cur ? 'is-on' : null, 'aria-label': o.label, title: o.label,
    onclick: () => { onPick(o.value); paint(o.value); },
  }, o.icon ? icon(o.icon, 16) : o.label)));
  paint(current);
  return wrap;
}

export function createContextBar(page, editor, { sendToPaths, present, openLink }) {
  const bar = h('div', { class: 'bp-ctx', role: 'toolbar', 'aria-label': 'Selection tools', hidden: true });
  page.append(bar);

  const ids = () => editor.selected().map((e) => e.id);
  const set = (patch, only) => {
    const sel = editor.selected().filter((e) => !only || only.includes(e.type));
    editor.applyStyle(sel.map((e) => e.id), patch);
  };
  const common = (list, key, fallback) => {
    const vals = new Set(list.map((e) => e[key] ?? fallback));
    return vals.size === 1 ? [...vals][0] : null;
  };

  function rebuild() {
    const sel = editor.selected();
    if (!sel.length || editor.presenting || editor.g) { bar.hidden = true; return; }
    const one = sel.length === 1 ? sel[0] : null;
    const of = (...ts) => sel.filter((e) => ts.includes(e.type));
    const items = [];

    if (sel.every((e) => e.locked)) {
      items.push(btn('unlock', 'Unlock', () => editor.toggleLock(), { text: 'Unlock' }));
      bar.replaceChildren(...items);
      bar.hidden = false;
      position();
      return;
    }

    if (one?.type === 'shape') {
      items.push(btn(one.kind || 'rect', 'Shape', (a) => popover(a, shapePicker(one.kind || 'rect'), { side: 'bottom' })));
    }

    const fillables = of('sticky', 'shape', 'frame', 'text');
    if (fillables.length) {
      const onlySticky = fillables.every((e) => e.type === 'sticky');
      const cur = common(fillables, 'fill', 'none');
      items.push(btn(swatchDot(cur || 'none'), 'Fill colour', (a) => popover(a, h('div', { class: 'pop' },
        h('div', { class: 'pop-label' }, onlySticky ? 'Note colour' : 'Fill'),
        colorGrid(onlySticky ? STICKY_FILLS : FILLS, cur, (c) => set({ fill: c }, ['sticky', 'shape', 'frame', 'text'])))), {}));
    }

    const strokables = of('shape', 'line', 'pen');
    if (strokables.length) {
      const cur = common(strokables, 'stroke', 'auto');
      const curW = common(strokables, 'strokeWidth', 2);
      const curDash = common(of('shape', 'line'), 'dash', 'solid');
      const hasDash = of('shape', 'line').length > 0;
      items.push(btn(swatchDot(cur || 'auto', true), 'Line colour and width', (a) => popover(a, h('div', { class: 'pop' },
        h('div', { class: 'pop-label' }, 'Colour'),
        colorGrid(of('shape').length ? [{ id: 'none', name: 'No border' }, ...SWATCHES] : SWATCHES, cur, (c) => set({ stroke: c }, ['shape', 'line', 'pen'])),
        row('Width', optionRow([1, 2, 3, 5, 8, 12].map((w) => ({ value: w, label: String(w) })), curW, (w) => set({ strokeWidth: w }, ['shape', 'line', 'pen']))),
        hasDash ? row('Style', optionRow([
          { value: 'solid', label: 'Solid', icon: 'solid' }, { value: 'dashed', label: 'Dashed', icon: 'dash' }, { value: 'dotted', label: 'Dotted', icon: 'dotted' },
        ], curDash, (d) => set({ dash: d }, ['shape', 'line']))) : null)), {}));
    }

    const texty = of('sticky', 'shape', 'text');
    if (texty.length) {
      const fs = common(texty, 'fontSize', null);
      items.push(btn('type', 'Text', (a) => popover(a, textPanel(texty)), { text: fs ? String(fs) : (texty.every((e) => e.type === 'sticky') ? 'Auto' : null) }));
      const b = texty.every((e) => e.bold);
      items.push(btn('bold', 'Bold', () => set({ bold: !b }, ['sticky', 'shape', 'text']), { on: b }));
      const al = common(texty, 'align', null) || 'center';
      const nextAlign = { left: 'center', center: 'right', right: 'left' }[al] || 'left';
      items.push(btn({ left: 'taLeft', center: 'taCenter', right: 'taRight' }[al] || 'taCenter', 'Text alignment', () => set({ align: nextAlign }, ['sticky', 'shape', 'text'])));
    }

    const lines = of('line');
    if (lines.length) {
      const route = common(lines, 'route', 'straight') || 'straight';
      items.push(btn({ straight: 'line', curve: 'curve', elbow: 'elbow' }[route], 'Connector style', (a) => popover(a, linePanel(lines))));
      const sc = common(lines, 'startCap', 'none');
      const ec = common(lines, 'endCap', 'none');
      items.push(btn(capIcon(sc, true), 'Start of line', (a) => popover(a, capPicker('startCap', sc))));
      items.push(btn(capIcon(ec, false), 'End of line', (a) => popover(a, capPicker('endCap', ec))));
    }

    if (one && (one.type === 'video' || one.type === 'embed')) {
      const live = editor.activeId === one.id;
      items.push(btn(live ? 'stop' : 'play', live ? 'Stop interacting' : 'Play / interact', () => (live ? editor.deactivate() : editor.activate(one.id)), { text: live ? 'Stop' : 'Play' }));
    }
    if (one && (one.type === 'link' || one.type === 'embed') && one.url) items.push(btn('external', 'Open link in new tab', () => openLink(one.url)));
    if (one?.type === 'sticky' && sendToPaths) items.push(btn('toPaths', 'Send to Paths', (a) => sendToPaths(a, one)));
    if (one?.type === 'frame' && present) items.push(btn('present', 'Present from this frame', () => present(one.id)));

    if (sel.length > 1) {
      items.push(btn('alignLeft', 'Align and distribute', (a) => popover(a, alignPanel(sel.length))));
      const grouped = sel.some((e) => e.group);
      items.push(btn(grouped ? 'ungroup' : 'group', grouped ? 'Ungroup (⇧⌘G)' : 'Group (⌘G)', () => (grouped ? editor.ungroup() : editor.group())));
    }

    if (items.length) items.push(h('span', { class: 'ctx-sep' }));
    items.push(btn('lock', 'Lock (⇧⌘L)', () => editor.toggleLock()));
    items.push(btn('more', 'More', (a) => moreMenu(a)));

    bar.replaceChildren(...items);
    bar.hidden = false;
    position();
  }

  function capIcon(kind, start) {
    const ic = icon({ none: 'capNone', arrow: 'capArrow', triangle: 'capTriangle', dot: 'capDot' }[kind] || 'capNone', 18);
    if (start) ic.style.transform = 'scaleX(-1)';
    return ic;
  }

  function capPicker(key, cur) {
    return h('div', { class: 'pop' },
      h('div', { class: 'pop-label' }, key === 'startCap' ? 'Start' : 'End'),
      optionRow([
        { value: 'none', label: 'None', icon: 'capNone' }, { value: 'arrow', label: 'Arrow', icon: 'capArrow' },
        { value: 'triangle', label: 'Triangle', icon: 'capTriangle' }, { value: 'dot', label: 'Dot', icon: 'capDot' },
      ], cur, (v) => set({ [key]: v }, ['line'])));
  }

  function linePanel(lines) {
    return h('div', { class: 'pop' },
      h('div', { class: 'pop-label' }, 'Connector'),
      optionRow([
        { value: 'straight', label: 'Straight', icon: 'line' }, { value: 'curve', label: 'Curved', icon: 'curve' }, { value: 'elbow', label: 'Elbow', icon: 'elbow' },
      ], common(lines, 'route', 'straight'), (v) => set({ route: v }, ['line'])));
  }

  function shapePicker(cur) {
    const grid = h('div', { class: 'shape-grid' });
    const paint = (c) => grid.replaceChildren(...SHAPES.map((k) => h('button', {
      type: 'button', class: ['tool-opt', k === c && 'is-on'], 'aria-label': SHAPE_NAMES[k], title: SHAPE_NAMES[k],
      onclick: () => { set({ kind: k }, ['shape']); paint(k); },
    }, icon(k, 20))));
    paint(cur);
    return h('div', { class: 'pop' }, h('div', { class: 'pop-label' }, 'Shape'), grid);
  }

  function textPanel(texty) {
    const allSticky = texty.every((e) => e.type === 'sticky');
    const font = common(texty, 'font', 'sans') || 'sans';
    const size = common(texty, 'fontSize', null);
    const sizes = h('div', { class: 'size-grid' });
    const paintSizes = (cur) => sizes.replaceChildren(
      allSticky ? h('button', { type: 'button', class: ['size-opt', cur == null && 'is-on'], onclick: () => { set({ fontSize: undefined }, ['sticky']); paintSizes(null); } }, 'Auto') : null,
      ...SIZES.map((sz) => h('button', { type: 'button', class: ['size-opt', cur === sz && 'is-on'], onclick: () => { set({ fontSize: sz }, ['sticky', 'shape', 'text']); paintSizes(sz); } }, String(sz))));
    paintSizes(size);
    const hasBoxText = texty.some((e) => e.type !== 'text');
    const colors = hasBoxText ? [{ id: 'contrast', name: 'Automatic contrast' }, ...SWATCHES.filter((s2) => s2.id !== 'auto')] : SWATCHES;
    const curColor = common(texty, 'color', hasBoxText ? 'contrast' : 'auto');
    const italic = h('button', { type: 'button', class: 'size-opt', 'aria-label': 'Italic' }, icon('italic', 16));
    const paintItalic = () => {
      const on = editor.selected().filter((e) => texty.some((t) => t.id === e.id)).every((e) => e.italic);
      italic.classList.toggle('is-on', on);
      italic.setAttribute('aria-pressed', String(on));
      return on;
    };
    italic.addEventListener('click', () => { set({ italic: !paintItalic() }, ['sticky', 'shape', 'text']); paintItalic(); });
    paintItalic();
    return h('div', { class: 'pop pop-text' },
      row('Font', optionRow([{ value: 'sans', label: 'Sans' }, { value: 'mono', label: 'Mono' }, { value: 'dot', label: 'Dot' }], font, (v) => set({ font: v }, ['sticky', 'shape', 'text'])), italic),
      h('div', { class: 'pop-label' }, 'Size'),
      sizes,
      h('div', { class: 'pop-label' }, 'Text colour'),
      colorGrid(colors, curColor || (hasBoxText ? 'contrast' : 'auto'), (c) => set({ color: c === 'contrast' ? undefined : c }, ['sticky', 'shape', 'text'])));
  }

  function alignPanel(n) {
    const b = (ic, label, fn, disabled) => h('button', { type: 'button', class: 'tool-opt', 'aria-label': label, title: label, disabled, onclick: fn }, icon(ic, 18));
    return h('div', { class: 'pop' },
      h('div', { class: 'pop-label' }, 'Align'),
      h('div', { class: 'opt-row' },
        b('alignLeft', 'Align left', () => editor.align('left')),
        b('alignCenter', 'Align centre', () => editor.align('center')),
        b('alignRight', 'Align right', () => editor.align('right')),
        b('alignTop', 'Align top', () => editor.align('top')),
        b('alignMiddle', 'Align middle', () => editor.align('middle')),
        b('alignBottom', 'Align bottom', () => editor.align('bottom'))),
      h('div', { class: 'pop-label' }, 'Distribute'),
      h('div', { class: 'opt-row' },
        b('distH', 'Distribute horizontally', () => editor.distribute('h'), n < 3),
        b('distV', 'Distribute vertically', () => editor.distribute('v'), n < 3)));
  }

  function moreMenu(anchor) {
    const sel = editor.selected();
    menu(anchor, [
      { label: 'Bring to front', icon: 'front', kbd: ']', onSelect: () => editor.bringToFront() },
      { label: 'Send to back', icon: 'backward', kbd: '[', onSelect: () => editor.sendToBack() },
      { label: 'Duplicate', icon: 'copy', kbd: '⌘D', onSelect: () => editor.duplicate() },
      { label: 'Copy', icon: 'copy', kbd: '⌘C', onSelect: () => editor.copy() },
      sel.length > 1 ? { label: 'Group', icon: 'group', kbd: '⌘G', onSelect: () => editor.group() } : null,
      sel.some((e) => e.group) ? { label: 'Ungroup', icon: 'ungroup', kbd: '⇧⌘G', onSelect: () => editor.ungroup() } : null,
      { label: 'Zoom to selection', icon: 'fit', kbd: '⇧2', onSelect: () => editor.zoomToSelection() },
      '-',
      { label: 'Delete', icon: 'trash', kbd: 'Del', danger: true, onSelect: () => editor.deleteSelection() },
    ], { align: 'end' });
  }

  function position() {
    if (bar.hidden) return;
    const sel = editor.selected();
    if (!sel.length) return;
    const r = unionRects(sel.map((e) => rectOf(e, editor.byId)));
    const tl = editor.toScreen({ x: r.x, y: r.y });
    const br = editor.toScreen({ x: r.x + r.w, y: r.y + r.h });
    const pr = page.getBoundingClientRect();
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    let x = (tl.x + br.x) / 2 - bw / 2 - pr.left;
    let y = tl.y - pr.top - bh - 34; // clears the connection dots
    const topLimit = 68;
    if (y < topLimit) {
      y = br.y - pr.top + 34;
      if (y + bh > pr.height - 72) y = topLimit;
    }
    x = clamp(x, 8, Math.max(8, pr.width - bw - 8));
    bar.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  editor.on('selection', rebuild);
  editor.on('change', () => { if (!editor.g) rebuild(); });
  editor.on('camera', position);
  editor.on('gesture', (on) => {
    if (on) { bar.hidden = true; closeFloating(); }
    else rebuild();
  });

  return { rebuild, el: bar };
}
