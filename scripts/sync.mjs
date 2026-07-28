/**
 * Rebuilds data.json and images/ from the Iran International memorial list.
 *
 *   node scripts/sync.mjs
 *
 * The source is a Next.js app whose list is served by server actions rather than
 * a public REST API, so we call those actions directly. The action IDs are baked
 * into the site's JS bundle and change whenever the site is redeployed — if this
 * script starts returning "no payload line", re-read them from the chunk that
 * defines them:
 *
 *   curl -s https://javidnaman.iranintl.com/memorial \
 *     | grep -o '/_next/static/chunks/[a-f0-9]*\.js'
 *   # then grep the chunks for: createServerReference("<id>", ...,"getPeopleListPaginated")
 *
 * Images are already downloaded are left alone, so re-runs only fetch what's new.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://javidnaman.iranintl.com';
const CDN = 'https://d1fwhlqkr1vj82.cloudfront.net/image';
const ACTION_LIST = 'c067da2c6c6b338c68594e6c6e0c4f0becded5364c'; // getPeopleListPaginated
const ACTION_DETAIL = 'c05dc4fa3eb34f921fefbd9a043aeefef3f7306ee1'; // getPersonDetail

const IMAGE_WIDTH = 256;
const CONCURRENCY = 8;
const RETRIES = 4;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGES_DIR = path.join(ROOT, 'images');
const DATA_FILE = path.join(ROOT, 'data.json');
const NO_PHOTO = '_no-photo.webp';

/* ------------------------------------------------------------------ helpers */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(label, fn) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt >= RETRIES) throw new Error(`${label}: ${err.message}`);
            await sleep(500 * 2 ** attempt);
        }
    }
}

/** Calls a Next.js server action and returns its decoded result. */
function callAction(actionId, args) {
    return withRetry(`action ${actionId.slice(0, 8)}`, async () => {
        const res = await fetch(`${ORIGIN}/memorial`, {
            method: 'POST',
            headers: {
                'Next-Action': actionId,
                'Content-Type': 'text/plain;charset=UTF-8',
            },
            body: JSON.stringify(args),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        // The RSC stream prefixes each row with an id; the action result is row 1.
        const row = text.split('\n').find((line) => line.startsWith('1:'));
        if (!row) throw new Error('no payload line');
        return JSON.parse(row.slice(2));
    });
}

/** Runs `task` over `items` with a fixed number of workers. */
async function pool(items, task, onProgress) {
    let cursor = 0;
    let completed = 0;
    await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
            while (cursor < items.length) {
                const item = items[cursor++];
                await task(item);
                if (++completed % 250 === 0) onProgress?.(completed, items.length);
            }
        }),
    );
}

/* ------------------------------------------------------------- normalisation */

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

const collapse = (value) => {
    if (value === null || value === undefined) return null;
    const text = String(value).replace(/\s+/g, ' ').trim();
    return text || null;
};

const toEnglishDigits = (text) => text.replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)));

/**
 * A handful of records are submitted by the public with the age, city or a whole
 * eyewitness account typed into the name field. Trim the name back to the part
 * that is actually a name, and recover the age when it was buried in there.
 */
function normaliseName(raw) {
    let name = collapse(raw) || '';
    let recoveredAge = null;

    // "سجاد شریفی ۴۲ ساله" / "نوید عالم چهره ۴۳ ساله اصفهان ..." -> cut at the age
    const age = name.match(/([0-9۰-۹]{1,3})\s*ساله/);
    if (age) recoveredAge = Number(toEnglishDigits(age[1]));

    // Anything from the first digit onwards is annotation, not a name.
    const digit = name.search(/[0-9۰-۹]/);
    if (digit > 0) name = name.slice(0, digit);

    // "رضا رستمیان/ نیازمند بررسی عکس" -> the slash separates a curator's note
    name = name.split('/')[0];

    // A few entries are prefixed with the word the site itself uses for the dead.
    name = name.replace(/^(از\s+)?جاوید\s*نام(ان)?\s+/, '');

    name = collapse(name) || collapse(raw) || 'ناشناس';

    if (recoveredAge !== null && (recoveredAge < 1 || recoveredAge > 120)) recoveredAge = null;
    return { name, recoveredAge };
}

/* ------------------------------------------------------------------- fetches */

async function fetchAllPeople() {
    const people = [];
    for (let page = 1; ; page++) {
        const result = await callAction(ACTION_LIST, [page]);
        people.push(...result.data);
        process.stdout.write(`\r  list: ${people.length} people`);
        if (!result.hasMore || result.count === 0) break;
    }
    process.stdout.write('\n');
    return people;
}

async function fetchAllDetails(people) {
    const details = new Map();
    await pool(
        people,
        async (person) => {
            try {
                details.set(person._id, await callAction(ACTION_DETAIL, [person._id]));
            } catch {
                details.set(person._id, null); // list data alone is still usable
            }
        },
        (done, total) => process.stdout.write(`\r  details: ${done}/${total}`),
    );
    process.stdout.write('\n');
    return details;
}

async function fetchImages(people) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });

    const placeholder = path.join(IMAGES_DIR, NO_PHOTO);
    if (!fs.existsSync(placeholder)) {
        const url = `${ORIGIN}/_next/image?url=%2Fidentified_martyr_no_photo.jpg&w=${IMAGE_WIDTH}&q=75`;
        const buf = await withRetry('placeholder', async () => {
            const res = await fetch(url, { headers: { Accept: 'image/webp,*/*' } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return Buffer.from(await res.arrayBuffer());
        });
        fs.writeFileSync(placeholder, buf);
    }

    const missing = people.filter(
        (p) => p.hasProfileImage && !fs.existsSync(path.join(IMAGES_DIR, `${p._id}.jpg`)),
    );
    if (missing.length === 0) {
        console.log('  images: nothing new');
        return new Set();
    }

    const failed = new Set();
    await pool(
        missing,
        async (person) => {
            try {
                const buf = await withRetry(person._id, async () => {
                    const res = await fetch(`${CDN}/${person._id}?width=${IMAGE_WIDTH}`);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const bytes = Buffer.from(await res.arrayBuffer());
                    if (bytes.length === 0) throw new Error('empty body');
                    return bytes;
                });
                fs.writeFileSync(path.join(IMAGES_DIR, `${person._id}.jpg`), buf);
            } catch {
                failed.add(person._id); // fall back to the placeholder in data.json
            }
        },
        (done) => process.stdout.write(`\r  images: ${done}/${missing.length}`),
    );
    process.stdout.write('\n');
    return failed;
}

/* ---------------------------------------------------------------------- main */

console.log('syncing from', ORIGIN);

const people = await fetchAllPeople();
const details = await fetchAllDetails(people);
const failedImages = await fetchImages(people);

const seen = new Set();
const entries = [];

for (const person of people) {
    if (seen.has(person._id)) continue;
    seen.add(person._id);

    const detail = details.get(person._id) || {};
    const { name, recoveredAge } = normaliseName(person.name || detail.name);

    let age = Number.isFinite(person.age) ? person.age : Number.isFinite(detail.age) ? detail.age : null;
    if (age === null) age = recoveredAge;

    entries.push({
        id: person._id,
        name,
        age,
        place: collapse(person.place || detail.place),
        date: collapse(detail.dateFormatted),
        photo: person.hasProfileImage && !failedImages.has(person._id),
    });
}

// One record per line: small enough for the widget to fetch, still readable in a diff.
fs.writeFileSync(DATA_FILE, `[\n${entries.map((e) => JSON.stringify(e)).join(',\n')}\n]\n`, 'utf8');

// Drop images for people no longer in the list so the repo doesn't accumulate orphans.
const expected = new Set([NO_PHOTO, ...entries.filter((e) => e.photo).map((e) => `${e.id}.jpg`)]);
let removed = 0;
for (const file of fs.readdirSync(IMAGES_DIR)) {
    if (!expected.has(file)) {
        fs.unlinkSync(path.join(IMAGES_DIR, file));
        removed++;
    }
}

console.log(`
  people   : ${entries.length}
  photo    : ${entries.filter((e) => e.photo).length}
  age      : ${entries.filter((e) => e.age !== null).length}
  place    : ${entries.filter((e) => e.place).length}
  date     : ${entries.filter((e) => e.date).length}
  orphans  : ${removed} removed
  data.json: ${(fs.statSync(DATA_FILE).size / 1024).toFixed(0)} KB`);
