// The marionette as the Marionette editor saves it: which puppet it is (its model), which of
// its links are strings, which are rods, which are taken off. Kept in this browser; the stage
// and the Studio build and string the puppet from it when it is there.

import { RIG, cloneStrings } from './rig-config.js';
import { sanitizeStrings } from './modes.js';
import { DEFAULT_MODEL, modelById } from './puppet-shapes.js';

export const MARIONETTE_KEY = 'motion-puppet-marionette';
export const MARIONETTE_VERSION = 2;   // 2: a document also says which model the puppet is
export const DEFAULT_NAME = 'My marionette';

/** The saved marionette ({ name, model, strings }), or null when nothing valid is saved. */
export function loadMarionette(rig = RIG) {
	try {
		return parseMarionette(JSON.parse(localStorage.getItem(MARIONETTE_KEY)), rig);
	} catch {
		return null;   // nothing saved, private mode, or not JSON
	}
}

/** Checks a marionette document from storage or a file. Null if it holds no usable link. */
export function parseMarionette(doc, rig = RIG) {
	if (!doc || typeof doc !== 'object' || !Array.isArray(doc.strings)) return null;
	const strings = sanitizeStrings(doc.strings, rig);
	return strings.length ? { name: String(doc.name || DEFAULT_NAME).slice(0, 40), model: modelById(doc.model).id, strings } : null;
}

export function marionetteDocument(name, strings, model = DEFAULT_MODEL) {
	return { version: MARIONETTE_VERSION, name: String(name || DEFAULT_NAME).slice(0, 40), model: modelById(model).id, strings };
}

/** Saves the marionette; `null` forgets it (back to the gentleman on his twelve strings). False if the browser refused. */
export function saveMarionette(doc) {
	try {
		if (doc) localStorage.setItem(MARIONETTE_KEY, JSON.stringify(doc));
		else localStorage.removeItem(MARIONETTE_KEY);
		return true;
	} catch {
		return false;
	}
}

/** The rig as that puppet: the model's solid pieces on the shared skeleton. */
export function rigForModel(model, rig = RIG) {
	const which = modelById(model);
	return { ...rig, model: which.id, shapes: which.shapes };
}

/** The rig as the saved marionette: its model and its stringing (the rig itself when none is saved). */
export function marionetteRig(rig = RIG) {
	const saved = loadMarionette(rig);
	return saved ? { ...rigForModel(saved.model, rig), strings: saved.strings } : rig;
}

// --- the traditional ways to string a marionette -----------------------------

const DEFAULTS = cloneStrings();
const on = (ids) => DEFAULTS.filter((s) => !ids.includes(s.id)).map((s) => s.id);

/** The default twelve with some made rods, some taken off and some changed, plus extra links. */
function strung({ rods = [], off = [], change = {}, extra = [] } = {}) {
	const table = cloneStrings().map((s) => ({ ...s, ...(change[s.id] || {}), ...(rods.includes(s.id) ? { kind: 'rod' } : {}), enabled: !off.includes(s.id) }));
	for (const link of extra) table.push({ n: table.length + 1, k: 3000, c: 30, max: 80, slack: 0.02, group: 'custom', enabled: true, breakable: false, ...link, at: [...link.at] });
	return table;
}

/**
 * Traditional ways to string a marionette. A string only pulls and hangs slack; a rod is a
 * stiff wire that also pushes — steadier and more direct, but it cannot go loose. `tradition`
 * is where the way of stringing comes from, `feel` what it is like to play.
 */
export const MARIONETTE_PRESETS = [
	{
		id: 'strings', label: 'All strings', tradition: 'English · the classic',
		about: 'The classic string marionette: twelve strings, nothing stiff.',
		feel: 'The most alive and the hardest to keep still.',
		strings: () => strung(),
	},
	{
		id: 'beginner', label: 'Seven strings', tradition: 'The first marionette',
		about: 'What a first marionette is strung with: head, shoulders, hands and knees. No back, hip or foot strings.',
		feel: 'Fewer strings to tangle; the feet go where the knees take them.',
		strings: () => strung({ off: ['back', 'ankleL', 'ankleR', 'hipL', 'hipR'] }),
	},
	{
		id: 'headRod', label: 'Head rod', tradition: 'Czech',
		about: 'Czech style: the head hangs from a stiff rod, so the puppet turns and bows exactly with the bar. Limbs stay on strings.',
		feel: 'Steady and exact; the puppet cannot sag under its bar.',
		strings: () => strung({ rods: ['head'], off: ['back'] }),
	},
	{
		id: 'sicilian', label: 'Head and hand rods', tradition: 'Sicilian · Opera dei Pupi',
		about: 'Sicilian style: a head rod and a rod to each hand for firm, direct gestures. Legs swing on strings.',
		feel: 'Made for sword fights: an arm goes exactly where its rod sends it.',
		strings: () => strung({ rods: ['head', 'wristL', 'wristR'], off: ['back'] }),
	},
	{
		id: 'liege', label: 'One rod, nothing else', tradition: 'Liège · Tchantchès',
		about: 'The puppets of Liège hang from a single iron rod through the head. Arms and legs are not strung at all: they swing as the body is walked, turned and shaken.',
		feel: 'Blunt and lively. Everything is done with the one rod.',
		strings: () => strung({ rods: ['head'], off: on(['head']) }),
	},
	{
		id: 'kathputli', label: 'Head, waist and hands', tradition: 'Rajasthan · Kathputli',
		about: 'A kathputli is worked by a loop from the head to the small of the back and a loop between the hands. The legs hang free.',
		feel: 'Four strings: quick turns, bows from the waist, hands that fly up together.',
		strings: () => strung({
			off: on(['head', 'back', 'wristL', 'wristR']),
			change: { back: { label: 'Waist', body: 'pelvis', at: [0, 0.04, -0.09], slack: 0.006 } },
		}),
	},
	{
		id: 'burmese', label: 'Temples and elbows', tradition: 'Burma · Yoke thé',
		about: 'A Burmese marionette carries many more strings: here the head hangs from its two temples, so it tilts with the bar, and each elbow has a string of its own behind the wrist’s.',
		feel: 'Sixteen links. The head answers every roll of the bar; the arms rise from the elbow.',
		strings: () => strung({
			off: ['head'],
			extra: [
				{ id: 'templeL', label: 'Left temple', body: 'head', at: [0.1, 0.03, 0], handle: 'shoulderL', slack: 0.002, max: 160, group: 'support' },
				{ id: 'templeR', label: 'Right temple', body: 'head', at: [-0.1, 0.03, 0], handle: 'shoulderR', slack: 0.002, max: 160, group: 'support' },
				{ id: 'elbowL', label: 'Left elbow', body: 'upperArmL', at: [0, -0.11, -0.02], handle: 'wristL', slack: 0.07, max: 60, group: 'arms' },
				{ id: 'elbowR', label: 'Right elbow', body: 'upperArmR', at: [0, -0.11, -0.02], handle: 'wristR', slack: 0.07, max: 60, group: 'arms' },
			],
		}),
	},
	{
		id: 'yoke', label: 'Shoulder rods', tradition: 'Trick figures',
		about: 'Two rods to the shoulders carry the body like a coat on a hanger: it cannot sag, lean or turn except as the bar does. Head and limbs stay on strings.',
		feel: 'A body that stays exactly level, for dancers and tightrope walkers.',
		strings: () => strung({ rods: ['shoulderL', 'shoulderR'], off: ['back', 'hipL', 'hipR'] }),
	},
];

/** The preset a table of links is (still) equal to, or null once it has been changed by hand. */
export function presetOf(strings, rig = RIG) {
	const key = JSON.stringify(sanitizeStrings(strings, rig));
	return MARIONETTE_PRESETS.find((p) => JSON.stringify(sanitizeStrings(p.strings(), rig)) === key) || null;
}
