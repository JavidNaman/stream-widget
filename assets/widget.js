'use strict';

// Themes live in subfolders; resolve data and images against the repo root.
const BASE = new URL('../', document.currentScript.src).href;
const DATA_URL = BASE + 'data.json';

/* Per-theme defaults. URL parameters override them. */
const THEME_DEFAULTS = {
    dark: { anim: 'blur', duration: 5000, fade: 560 },
    light: { anim: 'slide', duration: 5000, fade: 520 },
    bar: { anim: 'wipe', duration: 5000, fade: 460 },
};

const params = new URLSearchParams(location.search);

/** Numeric URL parameter. Number(null) is 0, hence the explicit null check. */
function readNumber(name, fallback, min, max) {
    const raw = params.get(name);
    if (raw === null || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(Math.max(value, min), max);
}

const root = document.documentElement;

/** Reads a length owned by the stylesheet. */
function cssPixels(name, fallback) {
    const value = parseFloat(getComputedStyle(root).getPropertyValue(name));
    return Number.isFinite(value) ? value : fallback;
}

const DEFAULT_FADE = cssPixels('--fade', 520);

const MAX_W = cssPixels('--max-w', 470);

const ANIMATIONS = ['blur', 'fade', 'slide', 'wipe', 'none'];

/** Hex colour from a URL parameter, with or without the #. */
function readColour(name) {
    const raw = (params.get(name) || '').trim().replace(/^#/, '');
    return /^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(raw) ? '#' + raw : null;
}

const THEMES = ['dark', 'light', 'bar'];
const PAGE_THEME = document.body.dataset.theme;
const THEME = THEMES.includes(params.get('theme')) ? params.get('theme')
    : THEMES.includes(PAGE_THEME) ? PAGE_THEME : 'dark';

const DEFAULTS = THEME_DEFAULTS[THEME];
const MOTION = ANIMATIONS.includes(params.get('anim')) ? params.get('anim') : DEFAULTS.anim;

const HOLD_MS = readNumber('duration', DEFAULTS.duration, 1000, 120000);
const FADE_MS = readNumber('fade', DEFAULTS.fade, 0, 4000);
// Without an explicit scale, fill the browser source: bigger source, sharper render.
const AUTO_SCALE = !params.has('scale');
const SCALE = readNumber('scale', 1, 0.4, 4);
const SHUFFLE = params.get('order') !== 'list';



const FADE_OUT_MS = Math.round(FADE_MS * 0.58);
root.style.setProperty('--fade', FADE_MS + 'ms');
root.style.setProperty('--fade-out', FADE_OUT_MS + 'ms');
let ACCENT_OFF = false;
const accentParam = (params.get('accent') || '').trim().toLowerCase();
if (accentParam === 'none' || accentParam === '0') {
    ACCENT_OFF = true;
} else {
    const accent = readColour('accent');
    if (accent) root.style.setProperty('--accent', accent);
}

for (const box of document.querySelectorAll('.box')) {
    box.dataset.theme = THEME;
    box.dataset.anim = MOTION;
}
function applyScale() {
    if (!AUTO_SCALE) {
        root.style.setProperty('--scale', String(SCALE));
        return;
    }
    const cardHeight = cssPixels('--h', 112);
    const fit = Math.min(
        document.documentElement.clientWidth / MAX_W,
        document.documentElement.clientHeight / cardHeight,
    );
    root.style.setProperty('--scale', String(Math.max(0.4, Math.min(4, fit))));
}

applyScale();
addEventListener('resize', applyScale);


// Read after the theme is on the element, so a theme may restyle the name.
const NAME_SIZE = parseFloat(getComputedStyle(document.querySelector('#card .name')).fontSize) || 22;

const elCard = document.getElementById('card');
const elMeasure = document.getElementById('measure');
const elInfo = elCard.querySelector('.info');

// On the card, not the root: themes declare their values there.
if (params.has('glass')) {
    const sheer = String(readNumber('glass', 0.28, 0, 0.9));
    elCard.style.setProperty('--sheer', sheer);
    elMeasure.style.setProperty('--sheer', sheer);
}
if (ACCENT_OFF) elCard.dataset.accent = 'none';

// Which corner the panel is pinned to. It grows away from that corner, and the
// wipe opens out of it, so a left-aligned widget sits on the left of the shot.
if (params.get('align') === 'left') {
    elCard.dataset.align = 'left';
    elMeasure.dataset.align = 'left';
}

// Which edge of the bar carries the accent. It follows the anchored corner by
// default; ?side= names the edge a viewer would point at.
const side = params.get('side');
if (side === 'left') elCard.style.setProperty('--accent-side', 'right');
else if (side === 'right') elCard.style.setProperty('--accent-side', 'left');


let people = [];
let cursor = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fetches the roster, retrying until it succeeds. */
async function loadPeople() {
    for (let attempt = 0; ; attempt++) {
        try {
            const res = await fetch(DATA_URL, { cache: 'no-cache' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const parsed = await res.json();
            if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('empty roster');
            return parsed.filter((entry) => entry && typeof entry === 'object');
        } catch {
            await sleep(Math.min(1000 * 2 ** attempt, 30000));
        }
    }
}

function shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
}

/** Next person, reshuffling on wrap without repeating the last one. */
function nextPerson() {
    if (cursor >= people.length) {
        const last = people[people.length - 1];
        shuffle(people);
        if (people.length > 1 && people[0] === last) {
            [people[0], people[1]] = [people[1], people[0]];
        }
        cursor = 0;
    }
    return people[cursor++];
}

/** Warms the cache. The on-screen element still decodes separately. */
async function prefetchImage(person) {
    if (!person.photo) return null;
    const src = BASE + 'images/' + person.id + '.jpg';
    const probe = new Image();
    probe.src = src;
    try {
        await probe.decode();
        return src;
    } catch {
        return null;
    }
}

/** Sets the portrait and waits until it can be painted, so the previous one
    is never left showing beside the new name. */
async function showPortrait(src) {
    const image = elCard.querySelector('img');
    if (!src) {
        image.removeAttribute('src');
        return false;
    }
    image.src = src;
    try {
        await image.decode();
        return true;
    } catch {
        image.removeAttribute('src');
        return false;
    }
}

/** Sets text, hiding the element when empty. */
function setText(el, text) {
    const value = text == null ? '' : String(text).trim();
    el.textContent = value;
    el.classList.toggle('is-empty', value === '');
}

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const toPersianDigits = (value) => String(value).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]);

/** Lays a person out inside `box` — either the visible card or the ruler. */
function paint(box, person, src, nameSize) {
    const avatar = box.querySelector('.avatar');
    const image = avatar.querySelector('img');

    avatar.classList.toggle('is-empty', !src);
    box.classList.toggle('no-photo', !src);
    // showPortrait swaps the pixels; it can wait for the decode.
    if (image) image.alt = src ? (person.name || '') : '';

    // The honorific in front is markup and stays put.
    box.querySelector('.given').textContent = person.name || 'ناشناس';

    // Age and place share a line; a missing one drops out.
    const bits = [];
    if (Number.isFinite(person.age)) bits.push(toPersianDigits(person.age) + ' ساله');
    if (person.place) bits.push(person.place);

    const meta = box.querySelector('.meta');
    meta.replaceChildren();
    meta.classList.toggle('is-empty', bits.length === 0);
    bits.forEach((bit, index) => {
        if (index > 0) {
            const sep = document.createElement('span');
            sep.className = 'sep';
            sep.textContent = '·';
            meta.append(sep);
        }
        meta.append(document.createTextNode(bit));
    });

    setText(box.querySelector('.date'), person.date);

    if (nameSize) box.style.setProperty('--name-size', nameSize);
    else box.style.removeProperty('--name-size');
}

/** Steps an over-long name down rather than truncating it. Measured on the
    ruler, never on the card, whose width is often mid-animation. */
function fitName(box) {
    const name = box.querySelector('.name');
    box.style.removeProperty('--name-size');
    if (name.scrollWidth <= name.clientWidth + 1) return null;
    const ratio = name.clientWidth / name.scrollWidth;
    const size = Math.max(17, Math.floor(NAME_SIZE * ratio)) + 'px';
    box.style.setProperty('--name-size', size);
    return size;
}

/** Pixels by which the widest line overflows, or 0. */
function shortfall(box) {
    let worst = 0;
    for (const line of box.querySelectorAll('.info > p')) {
        if (line.classList.contains('is-empty')) continue;
        worst = Math.max(worst, line.scrollWidth - line.clientWidth);
    }
    return worst > 1 ? worst : 0;
}

/** Widens the panel to cover any overflow; at the cap, shrinks the name. */
function ensureFits() {
    for (let pass = 0; pass < 3; pass++) {
        const short = shortfall(elCard);
        if (!short) return;
        const wider = Math.min(MAX_W, elCard.offsetWidth + short + 2);
        elInfo.style.width = (elInfo.getBoundingClientRect().width + short + 2) + 'px';
        if (wider <= elCard.offsetWidth) break;
        elCard.style.setProperty('--morph', '0ms');
        elCard.style.width = wider + 'px';
    }
    if (shortfall(elCard)) fitName(elCard);
}

/** Layout for one person, measured offscreen at the final width. */
function measure(person, src) {
    elMeasure.querySelector('.info').style.removeProperty('width');
    paint(elMeasure, person, src);
    const nameSize = fitName(elMeasure);
    // offsetWidth rounds; two pixels covers the fraction it drops.
    return {
        width: Math.min(MAX_W, elMeasure.offsetWidth + 2),
        infoWidth: Math.ceil(elMeasure.querySelector('.info').getBoundingClientRect().width) + 2,
        nameSize,
    };
}

/** Waits until the browser source is on screen again. */
function whenVisible() {
    if (!document.hidden) return Promise.resolve();
    return new Promise((resolve) => {
        document.addEventListener('visibilitychange', function onChange() {
            if (document.hidden) return;
            document.removeEventListener('visibilitychange', onChange);
            resolve();
        });
    });
}

async function run() {
    people = await loadPeople();
    if (SHUFFLE) shuffle(people);

    // Load the faces before measuring anything. fonts.ready alone resolves
    // immediately here, since nothing on the page has text yet; the sample text
    // is what pulls in the Arabic subset these names render in.
    await Promise.all([
        document.fonts.load('700 23px Vazirmatn', 'آزمایش'),
        document.fonts.load('400 17px Vazirmatn', 'آزمایش'),
    ]).catch(() => {});
    await document.fonts.ready;

    // Never let one stalled portrait hold the opening card back.
    const first = nextPerson();
    const firstSrc = await Promise.race([prefetchImage(first), sleep(2500).then(() => null)]);
    const firstLayout = measure(first, firstSrc);

    // No transition on the opening width, or the name is measured mid-growth.
    elCard.style.setProperty('--morph', '0ms');
    elCard.style.width = firstLayout.width + 'px';
    elInfo.style.width = firstLayout.infoWidth + 'px';
    paint(elCard, first, firstSrc, firstLayout.nameSize);
    ensureFits();
    await showPortrait(firstSrc);
    elCard.style.removeProperty('--morph');
    elCard.classList.add('is-lit', 'is-showing');

    while (people.length > 1) {
        // One bad record costs that person their turn, not the whole run.
        try {
            await showNext();
        } catch {
            await sleep(1000);
        }
    }
}

async function showNext() {
    // Prepare the next person while the current one is still up.
    const upcoming = nextPerson();
    const upcomingSrc = await prefetchImage(upcoming);
    const layout = measure(upcoming, upcomingSrc);

    await sleep(HOLD_MS);
    await whenVisible();

    if (MOTION.startsWith('wipe')) {
        // Closes fully before the next person goes in.
        elCard.style.setProperty('--morph', FADE_MS + 'ms');
        elCard.classList.add('is-shut');
        await sleep(FADE_MS + 40);

        // Resized while clipped, so the change is never visible.
        elCard.style.setProperty('--morph', '0ms');
        elCard.style.width = layout.width + 'px';
        paint(elCard, upcoming, upcomingSrc, layout.nameSize);
        elInfo.style.width = layout.infoWidth + 'px';
        ensureFits();
        await showPortrait(upcomingSrc);
        await sleep(140);

        elCard.style.setProperty('--morph', FADE_MS + 'ms');
        elCard.classList.remove('is-shut');
        await sleep(FADE_MS);
        return;
    }

    // Resize under the fade-out, so there is no pause with an empty panel.
    elCard.classList.add('is-leaving');
    elCard.classList.remove('is-showing');
    elCard.style.setProperty('--morph', FADE_OUT_MS + 'ms');
    elCard.style.width = layout.width + 'px';
    await sleep(FADE_OUT_MS);

    elCard.classList.remove('is-leaving');
    paint(elCard, upcoming, upcomingSrc, layout.nameSize);
    elInfo.style.width = layout.infoWidth + 'px';
    ensureFits();
    await showPortrait(upcomingSrc);
    elCard.classList.add('is-showing');
    await sleep(FADE_MS);
}

run();
