// The marionette's stringing as the Marionette editor saves it: which links are strings,
// which are rods, which are taken off. Kept in this browser; the stage and the Studio string
// the puppet from it when it is there.

import { RIG, cloneStrings } from './rig-config.js';
import { sanitizeStrings } from './modes.js';

export const MARIONETTE_KEY = 'motion-puppet-marionette';
export const MARIONETTE_VERSION = 1;

/** The saved stringing ({ name, strings }), or null when nothing valid is saved. */
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
	return strings.length ? { name: String(doc.name || 'My marionette').slice(0, 40), strings } : null;
}

export function marionetteDocument(name, strings) {
	return { version: MARIONETTE_VERSION, name: String(name || 'My marionette').slice(0, 40), strings };
}

/** Saves the stringing; `null` forgets it (back to the twelve default strings). False if the browser refused. */
export function saveMarionette(doc) {
	try {
		if (doc) localStorage.setItem(MARIONETTE_KEY, JSON.stringify(doc));
		else localStorage.removeItem(MARIONETTE_KEY);
		return true;
	} catch {
		return false;
	}
}

/** The rig with the saved stringing in place of the default one (the rig itself when none is saved). */
export function marionetteRig(rig = RIG) {
	const saved = loadMarionette(rig);
	return saved ? { ...rig, strings: saved.strings } : rig;
}

const withKinds = (rods, off = []) => cloneStrings().map((s) => ({ ...s, ...(rods.includes(s.id) ? { kind: 'rod' } : {}), enabled: !off.includes(s.id) }));

/**
 * Traditional ways to string a marionette. A string only pulls and hangs slack; a rod is a
 * stiff wire that also pushes — steadier and more direct, but it cannot go loose.
 */
export const MARIONETTE_PRESETS = [
	{ id: 'strings', label: 'All strings', about: 'The classic string marionette: twelve strings, nothing stiff.', strings: () => withKinds([]) },
	{ id: 'headRod', label: 'Head rod', about: 'Czech style: the head hangs from a stiff rod, so the puppet turns and bows exactly with the bar. Limbs stay on strings.', strings: () => withKinds(['head'], ['back']) },
	{ id: 'sicilian', label: 'Head and hand rods', about: 'Sicilian style: a head rod and a rod to each hand for firm, direct gestures. Legs swing on strings.', strings: () => withKinds(['head', 'wristL', 'wristR'], ['back']) },
];
