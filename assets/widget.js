'use strict';

// Every theme lives in its own folder, so paths are resolved against the repo
// root rather than the page — light/ and subtitle/ share one copy of the data.
const BASE = new URL('../', document.currentScript.src).href;
const DATA_URL = BASE + 'data.json';

/* Each theme carries its own defaults; a URL parameter still wins over them. */
const THEME_DEFAULTS = {
    glass: { anim: 'blur', duration: 5000, fade: 380 },
    light: { anim: 'slide', duration: 5000, fade: 380 },
    subtitle: { anim: 'wipe', duration: 5000, fade: 340 },
};

const params = new URLSearchParams(location.search);

/** Reads a numeric URL parameter, falling back when absent or nonsense.
    Note the explicit null check — Number(null) is 0, not NaN, so without it a
    missing parameter would silently clamp to the minimum instead. */
function readNumber(name, fallback, min, max) {
    const raw = params.get(name);
    if (raw === null || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(Math.max(value, min), max);
}

const root = document.documentElement;

/** Reads a length declared in the stylesheet, so a value the CSS owns is never
    also hard-coded here where the two could drift apart. */
function cssPixels(name, fallback) {
    const value = parseFloat(getComputedStyle(root).getPropertyValue(name));
    return Number.isFinite(value) ? value : fallback;
}

const DEFAULT_FADE = cssPixels('--fade', 520);

const MAX_W = cssPixels('--max-w', 470);

const ANIMATIONS = ['blur', 'fade', 'slide', 'wipe', 'none'];

/** A CSS colour given as a URL parameter, hex with or without the #. */
function readColour(name) {
    const raw = (params.get(name) || '').trim().replace(/^#/, '');
    return /^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(raw) ? '#' + raw : null;
}

const THEMES = ['glass', 'light', 'subtitle'];
const PAGE_THEME = document.body.dataset.theme;
const THEME = THEMES.includes(params.get('theme')) ? params.get('theme')
    : THEMES.includes(PAGE_THEME) ? PAGE_THEME : 'glass';

const DEFAULTS = THEME_DEFAULTS[THEME];
const MOTION = ANIMATIONS.includes(params.get('anim')) ? params.get('anim') : DEFAULTS.anim;

const HOLD_MS = readNumber('duration', DEFAULTS.duration, 1000, 120000);
const FADE_MS = readNumber('fade', DEFAULTS.fade, 0, 4000);
// With no scale given, the widget grows to fill whatever size the Browser
// Source is. That means a bigger source renders bigger *and sharper* rather
// than being upscaled afterwards, and it keeps working for anyone who set the
// source to the old 800x300 before the card was resized.
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

// Both of these live on the card, not on the root: each theme declares its own
// starting values there, and an inline property on the same element is what
// overrides them.
if (params.has('glass')) {
    elCard.style.setProperty('--sheer', String(readNumber('glass', 0.28, 0, 0.9)));
    elMeasure.style.setProperty('--sheer', String(readNumber('glass', 0.28, 0, 0.9)));
}
if (ACCENT_OFF) elCard.style.setProperty('--accent-width', '0px');


let people = [];
let cursor = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fetches the roster, retrying so a source that starts before the network is up
    recovers on its own instead of staying blank. */
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

/** Walks the roster, reshuffling on each pass without repeating the person who
    was just on screen across the wrap. */
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

/** Warms the cache for a portrait and reports whether it is usable at all.
    Decoding a detached Image only gets the bytes in; the element on screen still
    has to load and decode them itself, which is what showPortrait waits for. */
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

/** Points the on-screen portrait at `src` and resolves only once that element is
    ready to paint it. Without this the card can spend a frame or two still
    showing the previous person's photo beside the new person's name. */
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

/** Sets text, hiding the element entirely when there is nothing to show. */
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
    // The pixels are swapped by showPortrait, which can wait for the decode.
    if (image) image.alt = src ? (person.name || '') : '';

    // Only the given name is written; the honorific in front of it is markup and
    // stays where it is.
    box.querySelector('.given').textContent = person.name || 'ناشناس';

    // Age and place share a line; whichever is missing drops out, and if both are
    // missing the line disappears rather than leaving a gap.
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

/** Nobody's name gets cut short. The handful too long for the panel step down a
    point or two instead of ending in an ellipsis.

    This is measured on the ruler and never on the card, because the card's width
    is often mid-animation — measuring against it sized the very first name
    against an empty 52px panel and cropped it. */
function fitName(box) {
    const name = box.querySelector('.name');
    box.style.removeProperty('--name-size');
    if (name.scrollWidth <= name.clientWidth + 1) return null;
    const ratio = name.clientWidth / name.scrollWidth;
    const size = Math.max(17, Math.floor(NAME_SIZE * ratio)) + 'px';
    box.style.setProperty('--name-size', size);
    return size;
}

/** How many pixels short the widest line in `box` is, or 0 if everything fits. */
function shortfall(box) {
    let worst = 0;
    for (const line of box.querySelectorAll('.info > p')) {
        if (line.classList.contains('is-empty')) continue;
        worst = Math.max(worst, line.scrollWidth - line.clientWidth);
    }
    return worst > 1 ? worst : 0;
}

/** Final guarantee that nothing on the card ends in an ellipsis. Widens the
    panel to cover any shortfall, and only if it is already at its limit does it
    fall back to stepping the name down. Costs nothing when everything fits,
    which is the normal case. */
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

/** How the panel should be laid out for this person, worked out offscreen at the
    final width so nothing has to be measured against a moving target. */
function measure(person, src) {
    elMeasure.querySelector('.info').style.removeProperty('width');
    paint(elMeasure, person, src);
    const nameSize = fitName(elMeasure);
    // offsetWidth is a whole number but the layout underneath is not, so a panel
    // built to the reported width can land a fraction of a pixel short and clip
    // the very text it was measured from. Two pixels covers the rounding.
    return {
        width: Math.min(MAX_W, elMeasure.offsetWidth + 2),
        infoWidth: Math.ceil(elMeasure.querySelector('.info').getBoundingClientRect().width) + 2,
        nameSize,
    };
}

/** Resolves once the browser source is on screen again, so an inactive scene
    doesn't silently burn through the roster. */
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

    // Every width on this card is measured, so the real font has to be in place
    // before any measuring happens — Vazirmatn is wider than the fallback, and a
    // panel measured in the fallback is built too narrow for the name it holds.
    //
    // Asking for fonts.ready alone is not enough: at this point nothing on the
    // page has any text in it, so the browser has not requested the font yet and
    // ready resolves immediately against an empty page. These load calls demand
    // the faces outright, with Persian sample text so the Arabic subset — the one
    // that actually renders these names — is the one that gets fetched.
    await Promise.all([
        document.fonts.load('700 23px Vazirmatn', 'آزمایش'),
        document.fonts.load('400 17px Vazirmatn', 'آزمایش'),
    ]).catch(() => {});
    await document.fonts.ready;

    // The opening card must not be held hostage by one portrait. On a slow link
    // a stalled image would leave the overlay blank for as long as it took; past
    // this point the first person is simply shown without a photo, and the panel
    // closes up around the name exactly as it does for anyone who has none.
    const first = nextPerson();
    const firstSrc = await Promise.race([prefetchImage(first), sleep(1200).then(() => null)]);
    const firstLayout = measure(first, firstSrc);

    // No transition on the opening width, or the name would be laid out against
    // a panel that is still growing into place.
    elCard.style.setProperty('--morph', '0ms');
    elCard.style.width = firstLayout.width + 'px';
    elInfo.style.width = firstLayout.infoWidth + 'px';
    paint(elCard, first, firstSrc, firstLayout.nameSize);
    ensureFits();
    await showPortrait(firstSrc);
    elCard.style.removeProperty('--morph');
    elCard.classList.add('is-lit', 'is-showing');

    while (people.length > 1) {
        // This runs unattended for hours, so one unreadable record must not be
        // able to end the stream's memorial. Anything unexpected costs that
        // person their turn and nothing more.
        try {
            await showNext();
        } catch {
            await sleep(1000);
        }
    }
}

async function showNext() {
    // Work the next person out while the current one is still on screen, so the
    // change never waits on the network or the decoder.
    const upcoming = nextPerson();
    const upcomingSrc = await prefetchImage(upcoming);
    const layout = measure(upcoming, upcomingSrc);

    await sleep(HOLD_MS);
    await whenVisible();

    if (MOTION === 'wipe') {
        // The panel closes the whole way across, and only once it is shut does
        // the next person go in. Nothing of the change happens in view.
        elCard.style.setProperty('--morph', FADE_MS + 'ms');
        elCard.classList.add('is-shut');
        elCard.style.width = '0px';
        await sleep(FADE_MS + 60);

        paint(elCard, upcoming, upcomingSrc, layout.nameSize);
        elInfo.style.width = layout.infoWidth + 'px';
        await showPortrait(upcomingSrc);
        // A beat fully shut, so the close reads as finished rather than a bounce.
        await sleep(140);

        elCard.classList.remove('is-shut');
        elCard.style.width = layout.width + 'px';
        await sleep(FADE_MS);
        ensureFits();
        return;
    }

    // The panel resizes while the old details are fading, not in a gap of its
    // own afterwards — that gap was a visible pause with an empty pill in it.
    // By the time the next person is painted the panel is already their size.
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
